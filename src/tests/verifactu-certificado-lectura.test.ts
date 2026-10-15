/**
 * Lectura del certificado de VERI*FACTU (services/verifactu/certificado.ts)
 * con certificados generados aqui mismo (ayuda-certificados.ts), nunca los reales.
 */
import { createHash, X509Certificate } from 'crypto';
import forge from 'node-forge';
import { leerCertificado, maxIteraciones, metadatosDeX509, resumenIteraciones, sinEscapesDn, type CodigoCertificado } from '../services/verifactu/certificado';
import { conIteracionesMac, crearCa, crearCertificado, pkcs12, pkcs12AMedida, pkcs12Rc2, sujetoPersona, sujetoRepresentante, sujetoSello, type CertificadoPrueba } from './ayuda-certificados';

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

  it('lo que va escondido dentro de una parte cifrada tambien cuenta, y antes de calcularlo', () => {
    // La misma forma con 2.048 iteraciones se lee bien (forge abre la parte cifrada y OpenSSL tambien).
    expect(leerCertificado(pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: [{ escondida: true }] }), CLAVE).metadatos.nifTitular).toBe('A10952364');
    const t0 = Date.now();
    falla(() => leerCertificado(pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: [{ escondida: true, iteracionesFalsas: 50_000_000 }] }), CLAVE), 'VERIFACTU_CERT_ITERACIONES');
    expect(Date.now() - t0).toBeLessThan(2000);
    // Muchas partes escondidas: MAC, contenedor y 6 claves son 8 derivaciones (el tope es 6).
    const muchas = pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: Array.from({ length: 6 }, () => ({ escondida: true })) });
    expect(resumenIteraciones(forge.asn1.fromDer(muchas.toString('binary'))).partes).toBe(2);
    falla(() => leerCertificado(muchas, CLAVE), 'VERIFACTU_CERT_ITERACIONES');
  });

  it('a la vista: como mucho 4 partes cifradas y 3.000.000 de iteraciones entre todas', () => {
    falla(() => leerCertificado(pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: Array.from({ length: 4 }, () => ({})) }), CLAVE), 'VERIFACTU_CERT_ITERACIONES');
    const tres = pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: Array.from({ length: 3 }, () => ({ iteracionesFalsas: 1_000_000 })) });
    expect(resumenIteraciones(forge.asn1.fromDer(tres.toString('binary')))).toEqual({ max: 1_000_000n, suma: 3_002_048n, partes: 4 });
    falla(() => leerCertificado(tres, CLAVE), 'VERIFACTU_CERT_ITERACIONES');
  });

  it('con 1.000.000 de iteraciones (como exporta Firefox) se lee, y el PBKDF2 lo hace Node, no forge', () => {
    // La clave con 1.000.000 (el MAC, con 2.048: el de PKCS#12 lo sigue haciendo forge, unos 2 s por millon).
    const pfx = pkcs12AMedida({ cert: rep, contrasena: CLAVE, claves: [{ iteraciones: 1_000_000 }] });
    // Se mira a mano (no con jest.spyOn): forge solo usa el nativo si pbkdf2Sync declara sus 5 parametros.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto') as { pbkdf2Sync: (p: unknown, s: unknown, n: number, l: number, d: string) => Buffer };
    const original = nodeCrypto.pbkdf2Sync;
    const llamadas: Array<[number, number, string]> = [];
    nodeCrypto.pbkdf2Sync = function (p, s, n, l, d) {
      llamadas.push([n, l, d]);
      return original(p, s, n, l, d);
    };
    try {
      const t0 = Date.now();
      expect(leerCertificado(pfx, CLAVE).metadatos.nifTitular).toBe('A10952364');
      // Con el PBKDF2 de forge serian decenas de segundos dentro de Jest.
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(llamadas).toContainEqual([1_000_000, 32, 'sha256']);
    } finally {
      nodeCrypto.pbkdf2Sync = original;
    }
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

  it('el titular y el emisor salen sin los escapes con los que Node escribe la coma y los demás especiales', () => {
    const conComa = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'IFBIOSOLUCIONES, S.A.'), firmante: crearCa('AC FNMT; "USUARIOS" + REPRESENTACION') });
    const x = new X509Certificate(conComa.certPem);
    expect(x.subject).toContain('IFBIOSOLUCIONES\\, S.A.');
    expect(metadatosDeX509(x)).toMatchObject({ titular: 'IFBIOSOLUCIONES, S.A.', emisor: 'AC FNMT; "USUARIOS" + REPRESENTACION', nifTitular: 'A10952364' });
    const { metadatos } = leerCertificado(pkcs12({ cert: conComa, contrasena: CLAVE }), CLAVE);
    expect(metadatos.titular).toBe('IFBIOSOLUCIONES, S.A.');
  });

  it('un NIF, titular o emisor mas largos de lo que caben en la base: fichero no valido (400), no un 500 al guardar', () => {
    const nifLargo = crearCertificado({ sujeto: sujetoRepresentante(`A${'1'.repeat(25)}`, 'EMPRESA SA'), firmante: ca });
    falla(() => metadatosDeX509(new X509Certificate(nifLargo.certPem)), 'VERIFACTU_CERT_FICHERO');
    falla(() => leerCertificado(pkcs12({ cert: nifLargo, contrasena: CLAVE }), CLAVE), 'VERIFACTU_CERT_FICHERO');
    const titularLargo = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'E'.repeat(192)), firmante: ca });
    falla(() => metadatosDeX509(new X509Certificate(titularLargo.certPem)), 'VERIFACTU_CERT_FICHERO');
    const emisorLargo = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'EMPRESA SA'), firmante: crearCa('C'.repeat(192)) });
    falla(() => metadatosDeX509(new X509Certificate(emisorLargo.certPem)), 'VERIFACTU_CERT_FICHERO');
    // En el limite, si.
    const justo = crearCertificado({ sujeto: sujetoRepresentante('A10952364', 'E'.repeat(191)), firmante: ca });
    expect(metadatosDeX509(new X509Certificate(justo.certPem)).titular).toHaveLength(191);
  });

  it('sinEscapesDn quita los escapes de RFC 2253 (carácter y hexadecimal)', () => {
    expect(sinEscapesDn('IFBIOSOLUCIONES\\, S.A.')).toBe('IFBIOSOLUCIONES, S.A.');
    expect(sinEscapesDn('A\\+B \\"C\\" \\<D\\> E\\; F\\\\G')).toBe('A+B "C" <D> E; F\\G');
    expect(sinEscapesDn('\\ espacio al principio y al final\\ ')).toBe(' espacio al principio y al final ');
    expect(sinEscapesDn('control\\0Afin')).toBe('control\nfin');
    expect(sinEscapesDn('NEWZELAND CENTER, S.L. sin escapes')).toBe('NEWZELAND CENTER, S.L. sin escapes');
  });
});
