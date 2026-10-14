/**
 * Lectura del certificado de VERI*FACTU (services/verifactu/certificado.ts)
 * con certificados generados aqui mismo (ayuda-certificados.ts), nunca los reales.
 */
import { createHash, X509Certificate } from 'crypto';
import forge from 'node-forge';
import { leerCertificado, maxIteraciones, metadatosDeX509, type CodigoCertificado } from '../services/verifactu/certificado';
import { conIteracionesMac, crearCa, crearCertificado, pkcs12, pkcs12Rc2, sujetoPersona, sujetoRepresentante, sujetoSello, type CertificadoPrueba } from './ayuda-certificados';

jest.setTimeout(120_000);

// Con una «ñ»: el AES (PBES2) deriva la clave con la contraseña en UTF-8, como OpenSSL y Windows.
const CLAVE = 'contraseña de prueba 1';
let ca: CertificadoPrueba;
let rep: CertificadoPrueba;

beforeAll(() => {
  ca = crearCa();
  rep = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES SA'), firmante: ca });
});

const falla = (fn: () => unknown, codigo: CodigoCertificado, campo = 'certificado') => {
  try {
    fn();
  } catch (e) {
    expect(e).toMatchObject({ statusCode: 400, details: { codigo, campo } });
    return;
  }
  throw new Error(`No ha fallado con ${codigo}`);
};

describe('leerCertificado', () => {
  it('representante de persona juridica (AES-256): NIF de la empresa, del representante, emisor, serie y huella de X509Certificate', () => {
    const { metadatos } = leerCertificado(pkcs12({ cert: rep, cadena: [ca], contrasena: CLAVE }), CLAVE);
    const x = new X509Certificate(rep.certPem);
    expect(metadatos).toMatchObject({
      titular: 'IFBIOSOLUCIONES SA',
      nifTitular: 'A10952364',
      nifRepresentante: '12345678Z',
      tipo: 'REPRESENTANTE_PJ',
      emisor: 'AC DE PRUEBAS',
      numeroSerie: x.serialNumber.toUpperCase(),
      huellaSha256: createHash('sha256').update(x.raw).digest('hex').toUpperCase(),
    });
    expect(metadatos.caducaEn.getTime()).toBe(new Date(x.validTo).getTime());
    expect(JSON.stringify(metadatos)).not.toContain(CLAVE);
  });

  it('3DES tambien vale; persona fisica y sello se distinguen', () => {
    expect(leerCertificado(pkcs12({ cert: rep, contrasena: CLAVE, algoritmo: '3des' }), CLAVE).metadatos.tipo).toBe('REPRESENTANTE_PJ');
    const persona = crearCertificado({ sujeto: sujetoPersona('00000000T'), firmante: ca });
    expect(leerCertificado(pkcs12({ cert: persona, contrasena: CLAVE }), CLAVE).metadatos).toMatchObject({ tipo: 'PERSONA_FISICA', nifTitular: '00000000T', nifRepresentante: null, titular: 'APELLIDO NOMBRE - 00000000T' });
    const sello = crearCertificado({ sujeto: sujetoSello('B12345674', 'EMPRESA SL'), firmante: ca });
    expect(leerCertificado(pkcs12({ cert: sello, contrasena: CLAVE }), CLAVE).metadatos).toMatchObject({ tipo: 'SELLO', nifTitular: 'B12345674', titular: 'EMPRESA SL' });
    const otro = crearCertificado({ sujeto: [{ name: 'commonName', value: 'servidor.local' }], firmante: ca });
    expect(leerCertificado(pkcs12({ cert: otro, contrasena: CLAVE }), CLAVE).metadatos).toMatchObject({ tipo: 'OTRO', nifTitular: '' });
  });

  it('con la CA dentro y sin localKeyId elige el certificado que casa con la clave', () => {
    const r = leerCertificado(pkcs12({ cert: rep, cadena: [ca], contrasena: CLAVE, sinLocalKeyId: true }), CLAVE);
    expect(r.metadatos.nifTitular).toBe('A10952364');
  });

  it('contraseña mala, vacia o demasiado larga: campo contrasena', () => {
    const pfx = pkcs12({ cert: rep, contrasena: CLAVE });
    falla(() => leerCertificado(pfx, 'otra'), 'VERIFACTU_CERT_CONTRASENA', 'contrasena');
    falla(() => leerCertificado(pfx, ''), 'VERIFACTU_CERT_CONTRASENA', 'contrasena');
    falla(() => leerCertificado(pfx, 'x'.repeat(129)), 'VERIFACTU_CERT_CONTRASENA', 'contrasena');
  });

  it('fichero vacio, que no es DER o de mas de 64 KB', () => {
    falla(() => leerCertificado(Buffer.alloc(0), CLAVE), 'VERIFACTU_CERT_FICHERO');
    falla(() => leerCertificado(Buffer.from('esto no es un certificado'), CLAVE), 'VERIFACTU_CERT_FICHERO');
    falla(() => leerCertificado(Buffer.alloc(64 * 1024 + 1, 1), CLAVE), 'VERIFACTU_CERT_GRANDE');
    // DER valido pero no es un PKCS#12.
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(rep.cert)).getBytes(), 'binary');
    falla(() => leerCertificado(der, CLAVE), 'VERIFACTU_CERT_FICHERO');
  });

  it('cifrado antiguo (RC2-40): se rechaza con las instrucciones para exportarlo de nuevo', () => {
    falla(() => leerCertificado(pkcs12Rc2(rep, CLAVE), CLAVE), 'VERIFACTU_CERT_CIFRADO_ANTIGUO');
  });

  it('2.000.000 de iteraciones: se rechaza ANTES de descifrar (y enseguida)', () => {
    const pfx = conIteracionesMac(pkcs12({ cert: rep, contrasena: CLAVE }), 2_000_000);
    expect(maxIteraciones(forge.asn1.fromDer(pfx.toString('binary')))).toBe(2_000_000n);
    const t0 = Date.now();
    falla(() => leerCertificado(pfx, CLAVE), 'VERIFACTU_CERT_ITERACIONES');
    expect(Date.now() - t0).toBeLessThan(2000);
    // Las de PBKDF2 de la clave tambien cuentan.
    expect(maxIteraciones(forge.asn1.fromDer(pkcs12({ cert: rep, contrasena: CLAVE, iteraciones: 3000 }).toString('binary')))).toBe(3000n);
  });

  it('sin clave privada', () => {
    falla(() => leerCertificado(pkcs12({ cert: rep, contrasena: CLAVE, sinClave: true }), CLAVE), 'VERIFACTU_CERT_SIN_CLAVE');
  });

  it('caducado o aun no valido, con la fecha', () => {
    const viejo = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES SA'), firmante: ca, desde: new Date('2024-01-01T00:00:00Z'), hasta: new Date('2025-06-30T12:00:00Z') });
    expect(() => leerCertificado(pkcs12({ cert: viejo, contrasena: CLAVE }), CLAVE)).toThrow('El certificado caducó el 30-06-2025');
    falla(() => leerCertificado(pkcs12({ cert: viejo, contrasena: CLAVE }), CLAVE), 'VERIFACTU_CERT_CADUCADO');
    const futuro = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES SA'), firmante: ca, desde: new Date(Date.now() + 10 * 86_400_000), hasta: new Date(Date.now() + 400 * 86_400_000) });
    falla(() => leerCertificado(pkcs12({ cert: futuro, contrasena: CLAVE }), CLAVE), 'VERIFACTU_CERT_AUN_NO_VALIDO');
    // Con el reloj en otra fecha, el mismo certificado vale.
    expect(leerCertificado(pkcs12({ cert: viejo, contrasena: CLAVE }), CLAVE, new Date('2025-01-01T00:00:00Z')).metadatos.nifTitular).toBe('A10952364');
  });

  it('metadatosDeX509 lee VATES-/IDCES- tal como los da esta version de Node', () => {
    const x = new X509Certificate(rep.certPem);
    expect(x.subject).toMatch(/organizationIdentifier=VATES-A10952364|2\.5\.4\.97=VATES-A10952364/);
    expect(metadatosDeX509(x)).toMatchObject({ nifTitular: 'A10952364', nifRepresentante: '12345678Z' });
  });
});
