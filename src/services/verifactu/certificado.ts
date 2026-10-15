/**
 * Lectura del certificado electronico (.pfx / .p12) que sube el administrador
 * para VERI*FACTU (spec verifactu, 2.5; plan F2, 6.2). Puro salvo el reloj.
 *
 * Seguridad (aviso GHSA-86w9-cpqp-85rv de node-forge sobre la verificacion de
 * firmas RSA): node-forge se usa SOLO para abrir el PKCS#12 y sacar sus partes
 * (la comprobacion de su MAC es HMAC, no RSA). Nunca se verifica una firma con
 * forge. La contraseña se comprueba con tls.createSecureContext de Node, y los
 * datos del certificado (titular, NIF, emisor, serie, validez y huella) salen de
 * crypto.X509Certificate a partir del DER.
 *
 * Antes de descifrar nada hay un tope: fichero de 64 KB, contraseña de 128
 * caracteres y 1.000.000 de iteraciones (un PKCS#12 con millones de
 * iteraciones dejaria la funcion colgada).
 *
 * La clave privada y la contraseña nunca salen de aqui: solo los metadatos.
 */
import { createPrivateKey, X509Certificate, type KeyObject } from 'crypto';
import { createSecureContext } from 'tls';
import forge from 'node-forge';
import { HttpError } from '../../utils/http-errors';

export const CERT_MAX_BYTES = 64 * 1024;
export const CONTRASENA_MAX = 128;
export const ITERACIONES_MAX = 1_000_000;
/** Profundidad maxima al entrar en los OCTET STRING que llevan DER dentro. */
const PROFUNDIDAD_MAX = 8;
const NODOS_MAX = 20_000;

export type TipoCertificado = 'REPRESENTANTE_PJ' | 'PERSONA_FISICA' | 'SELLO' | 'OTRO';

export interface MetadatosLeidos {
  titular: string;
  /** NIF de la empresa (organizationIdentifier VATES-...) o de la persona (serialNumber IDCES-...). */
  nifTitular: string;
  /** NIF de la persona en un certificado de representante. */
  nifRepresentante: string | null;
  tipo: TipoCertificado;
  emisor: string;
  numeroSerie: string;
  validoDesde: Date;
  caducaEn: Date;
  huellaSha256: string;
}

export type CodigoCertificado =
  | 'VERIFACTU_CERT_FICHERO'
  | 'VERIFACTU_CERT_GRANDE'
  | 'VERIFACTU_CERT_CONTRASENA'
  | 'VERIFACTU_CERT_ITERACIONES'
  | 'VERIFACTU_CERT_CIFRADO_ANTIGUO'
  | 'VERIFACTU_CERT_SIN_CLAVE'
  | 'VERIFACTU_CERT_CLAVE_NO_ADMITIDA'
  | 'VERIFACTU_CERT_CADUCADO'
  | 'VERIFACTU_CERT_AUN_NO_VALIDO';

/** Error de lectura: 400 con el campo del formulario (certificado o contrasena) y su codigo. */
export class ErrorCertificado extends HttpError {
  constructor(public readonly codigo: CodigoCertificado, mensaje: string) {
    const campo = codigo === 'VERIFACTU_CERT_CONTRASENA' ? 'contrasena' : 'certificado';
    super(400, mensaje, { campo, codigo, code: codigo });
    this.name = 'ErrorCertificado';
  }
}

export const MENSAJES_CERTIFICADO = {
  fichero: 'El fichero no es un certificado .pfx o .p12, o está dañado.',
  grande: 'El fichero pasa de 64 KB: no parece un certificado .pfx o .p12.',
  sinContrasena: 'Escribe la contraseña del certificado (como mucho 128 caracteres).',
  contrasena: 'La contraseña del certificado no es correcta.',
  iteraciones: 'El certificado está protegido de una forma que la app no admite. Expórtalo de nuevo desde el almacén de certificados o desde el navegador.',
  cifradoAntiguo:
    'El certificado usa un cifrado antiguo (RC2) que la app no admite. Expórtalo de nuevo con la clave privada y el cifrado AES256-SHA256: en Windows, desde el almacén de certificados («Exportar», marcando «Exportar la clave privada» y eligiendo AES256-SHA256).',
  sinClave: 'El fichero no trae la clave privada del certificado (o trae más de una). Expórtalo de nuevo marcando «Exportar la clave privada».',
  claveNoAdmitida: 'La clave privada del certificado es de un tipo que la app no admite.',
  caducado: (fecha: string) => `El certificado caducó el ${fecha}. Sube uno vigente.`,
  aunNoValido: (fecha: string) => `El certificado no es válido hasta el ${fecha}.`,
};

/** dd-mm-aaaa en hora de Madrid. */
export function fechaCorta(d: Date): string {
  const p = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return `${v('day')}-${v('month')}-${v('year')}`;
}

// ---------- Tope de iteraciones (antes de descifrar) ----------

const OID_PBKDF2 = '1.2.840.113549.1.5.12';
/** PBES1 (PKCS#5) y los PBE de PKCS#12: sus parametros son SEQUENCE { salt, iteraciones }. */
const esPbeConIteraciones = (oid: string) => oid.startsWith('1.2.840.113549.1.12.1.') || ['1.2.840.113549.1.5.1', '1.2.840.113549.1.5.3', '1.2.840.113549.1.5.4', '1.2.840.113549.1.5.6', '1.2.840.113549.1.5.10', '1.2.840.113549.1.5.11'].includes(oid);

type Nodo = forge.asn1.Asn1;
const T = forge.asn1.Type;
const C = forge.asn1.Class;

/** forge.asn1.fromDer con sus opciones (los tipos de @types/node-forge solo admiten el booleano). */
const fromDer = (bytes: string, opciones: { strict: boolean; parseAllBytes?: boolean; decodeBitStrings?: boolean }): Nodo =>
  (forge.asn1.fromDer as unknown as (b: string, o: typeof opciones) => Nodo)(bytes, opciones);

const hijos = (n: Nodo | undefined): Nodo[] => (n && Array.isArray(n.value) ? (n.value as Nodo[]) : []);
const esSecuencia = (n: Nodo | undefined) => !!n && n.tagClass === C.UNIVERSAL && n.type === T.SEQUENCE && Array.isArray(n.value);

function entero(n: Nodo | undefined): bigint | null {
  if (!n || n.tagClass !== C.UNIVERSAL || n.type !== T.INTEGER || typeof n.value !== 'string') return null;
  let v = 0n;
  for (let i = 0; i < n.value.length; i++) v = v * 256n + BigInt(n.value.charCodeAt(i));
  return v;
}

function oidDe(n: Nodo | undefined): string | null {
  if (!n || n.tagClass !== C.UNIVERSAL || n.type !== T.OID || typeof n.value !== 'string') return null;
  try {
    return forge.asn1.derToOid(n.value);
  } catch {
    return null;
  }
}

/**
 * La mayor cuenta de iteraciones del PKCS#12: la del MAC (MacData) y las de
 * PBKDF2 y los PBE de cada parte cifrada. Entra en los OCTET STRING que llevan
 * DER dentro (hasta PROFUNDIDAD_MAX niveles y NODOS_MAX nodos).
 */
export function maxIteraciones(raiz: Nodo): bigint {
  let max = 0n;
  let nodos = 0;
  const anotar = (v: bigint | null) => {
    if (v !== null && v > max) max = v;
  };
  // MacData: tercer elemento del PFX, con las iteraciones en su tercer elemento.
  const macData = hijos(raiz)[2];
  if (esSecuencia(macData)) anotar(entero(hijos(macData)[2]));

  const recorrer = (n: Nodo, profundidad: number) => {
    if (++nodos > NODOS_MAX) throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
    if (esSecuencia(n)) {
      const [primero, params] = hijos(n);
      const oid = oidDe(primero);
      if (oid && esSecuencia(params)) {
        if (oid === OID_PBKDF2 || esPbeConIteraciones(oid)) anotar(entero(hijos(params)[1]));
      }
    }
    if (Array.isArray(n.value)) {
      for (const h of n.value as Nodo[]) recorrer(h, profundidad);
      return;
    }
    if (n.tagClass === C.UNIVERSAL && n.type === T.OCTETSTRING && typeof n.value === 'string' && profundidad < PROFUNDIDAD_MAX && n.value.length > 1) {
      let dentro: Nodo | null = null;
      try {
        dentro = fromDer(n.value, { strict: true, parseAllBytes: true, decodeBitStrings: false });
      } catch {
        dentro = null;
      }
      if (dentro) recorrer(dentro, profundidad + 1);
    }
  };
  recorrer(raiz, 0);
  return max;
}

// ---------- Datos del certificado (crypto.X509Certificate) ----------

/**
 * Quita los escapes de RFC 2253 con los que Node escribe subject e issuer:
 * «IFBIOSOLUCIONES\, S.A.» -> «IFBIOSOLUCIONES, S.A.». Escapa con «\» los
 * caracteres especiales (, + " \ < > ; # y el espacio del principio o del final)
 * y con «\XX» (hexadecimal) los de control. Ninguno de los especiales es una
 * cifra hexadecimal, así que no hay ambigüedad.
 */
export function sinEscapesDn(v: string): string {
  return v.replace(/\\([0-9A-Fa-f]{2})|\\([\s\S])/g, (_m, hex: string | undefined, c: string | undefined) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : (c ?? ''),
  );
}

/** «C=ES\nO=EMPRESA\, SA\n...» -> pares (clave, valor), partiendo cada linea por el primer «=» y sin los escapes. */
function campos(dn: string): Array<[string, string]> {
  return String(dn ?? '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('=');
      // Primero los escapes y despues el recorte: un espacio final escapado («\ ») no se pierde a medias.
      return i > 0 ? ([l.slice(0, i).trim(), sinEscapesDn(l.slice(i + 1)).trim()] as [string, string]) : null;
    })
    .filter((x): x is [string, string] => !!x);
}
const campo = (pares: Array<[string, string]>, ...claves: string[]) => pares.find(([k]) => claves.includes(k))?.[1] ?? null;

/** VATES-A10952364 -> A10952364 (organizationIdentifier, ETSI EN 319 412-1). */
const nifDeOrganizacion = (v: string | null) => {
  const m = /^VAT([A-Z]{2})-(.+)$/i.exec(v ?? '');
  return m ? m[2].toUpperCase() : null;
};
/** IDCES-12345678Z -> 12345678Z; tambien PASES-, TINES- o el NIF sin prefijo. */
const nifDePersona = (v: string | null) => {
  if (!v) return null;
  const m = /^(?:IDC|PAS|TIN|PNO)([A-Z]{2})-(.+)$/i.exec(v);
  if (m) return m[2].toUpperCase();
  return /^[0-9XYZKLM][0-9]{7}[A-Z]$/i.test(v) ? v.toUpperCase() : null;
};

/** Los datos que se guardan y se enseñan del certificado del titular. */
export function metadatosDeX509(x: X509Certificate): MetadatosLeidos {
  const sujeto = campos(x.subject);
  const emisor = campos(x.issuer);
  const nifOrg = nifDeOrganizacion(campo(sujeto, 'organizationIdentifier', '2.5.4.97'));
  const nifPersona = nifDePersona(campo(sujeto, 'serialNumber', '2.5.4.5'));
  const organizacion = campo(sujeto, 'O');
  const cn = campo(sujeto, 'CN');
  let tipo: TipoCertificado = 'OTRO';
  if (nifOrg && nifPersona) tipo = 'REPRESENTANTE_PJ';
  else if (nifPersona) tipo = 'PERSONA_FISICA';
  else if (nifOrg) tipo = 'SELLO';
  const titular = (nifOrg ? organizacion : cn) ?? organizacion ?? cn ?? '';
  return {
    titular,
    nifTitular: nifOrg ?? nifPersona ?? '',
    nifRepresentante: nifOrg && nifPersona ? nifPersona : null,
    tipo,
    emisor: campo(emisor, 'CN') ?? campo(emisor, 'O') ?? '',
    numeroSerie: x.serialNumber.toUpperCase(),
    validoDesde: new Date(x.validFrom),
    caducaEn: new Date(x.validTo),
    huellaSha256: x.fingerprint256.replace(/:/g, '').toUpperCase(),
  };
}

// ---------- Lectura ----------

/**
 * forge.pkcs12.pkcs12FromAsn1 con la contraseña bien codificada en cada parte:
 * el MAC y los PBE de PKCS#12 (3DES) usan la contraseña como BMPString, que
 * forge ya hace bien; pero en PBES2 (AES, lo que exportan hoy Windows y
 * OpenSSL) la clave sale de PBKDF2 con la contraseña en UTF-8, y forge usaria
 * el byte bajo de cada caracter: con una «ñ» no abriria un certificado bueno.
 * Mientras dura la llamada (sincrona), su PBKDF2 recibe la contraseña en UTF-8
 * (igual que antes si es ASCII).
 */
export function abrirPkcs12(asn1: forge.asn1.Asn1, contrasena: string): forge.pkcs12.Pkcs12Pfx {
  const p5 = forge.pkcs5 as unknown as { pbkdf2: (...a: unknown[]) => unknown };
  const original = p5.pbkdf2;
  p5.pbkdf2 = (clave: unknown, ...resto: unknown[]) => original(typeof clave === 'string' ? forge.util.encodeUtf8(clave) : clave, ...resto);
  try {
    return forge.pkcs12.pkcs12FromAsn1(asn1, false, contrasena);
  } finally {
    p5.pbkdf2 = original;
  }
}

const binario = (b: Buffer) => b.toString('binary');
const aBuffer = (s: string) => Buffer.from(s, 'binary');

/**
 * Lee el PKCS#12 con su contraseña y devuelve los metadatos del certificado
 * del titular, o lanza ErrorCertificado. Comprueba tambien que este vigente en `ahora`.
 */
export function leerCertificado(pfx: Buffer, contrasena: string, ahora: Date = new Date()): { metadatos: MetadatosLeidos } {
  // 1. Tamaños.
  if (!Buffer.isBuffer(pfx) || pfx.length === 0) throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  if (pfx.length > CERT_MAX_BYTES) throw new ErrorCertificado('VERIFACTU_CERT_GRANDE', MENSAJES_CERTIFICADO.grande);
  if (typeof contrasena !== 'string' || contrasena.length === 0 || Array.from(contrasena).length > CONTRASENA_MAX) {
    throw new ErrorCertificado('VERIFACTU_CERT_CONTRASENA', MENSAJES_CERTIFICADO.sinContrasena);
  }

  // 2. Que sea DER.
  let asn1: Nodo;
  try {
    asn1 = fromDer(binario(pfx), { strict: true, parseAllBytes: true });
  } catch {
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }

  // 3. Tope de iteraciones, antes de descifrar nada.
  if (maxIteraciones(asn1) > BigInt(ITERACIONES_MAX)) throw new ErrorCertificado('VERIFACTU_CERT_ITERACIONES', MENSAJES_CERTIFICADO.iteraciones);

  // 4. La contraseña, con Node (OpenSSL).
  try {
    createSecureContext({ pfx, passphrase: contrasena });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const msg = String(err.message ?? '').toLowerCase();
    if (msg.includes('mac verify failure') || msg.includes('bad decrypt')) throw new ErrorCertificado('VERIFACTU_CERT_CONTRASENA', MENSAJES_CERTIFICADO.contrasena);
    if (msg.includes('unable to load private key')) throw new ErrorCertificado('VERIFACTU_CERT_SIN_CLAVE', MENSAJES_CERTIFICADO.sinClave);
    if (err.code === 'ERR_CRYPTO_UNSUPPORTED_OPERATION' || msg.includes('unsupported')) {
      throw new ErrorCertificado('VERIFACTU_CERT_CIFRADO_ANTIGUO', MENSAJES_CERTIFICADO.cifradoAntiguo);
    }
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }

  // 5. Las bolsas del PKCS#12, con forge (solo para abrirlo).
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = abrirPkcs12(asn1, contrasena);
  } catch (e) {
    const msg = String((e as Error)?.message ?? '').toLowerCase();
    if (msg.includes('mac could not be verified') || msg.includes('wrong password')) throw new ErrorCertificado('VERIFACTU_CERT_CONTRASENA', MENSAJES_CERTIFICADO.contrasena);
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }

  // 6. La clave privada: exactamente una.
  const bolsasClave = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  if (bolsasClave.length !== 1) throw new ErrorCertificado('VERIFACTU_CERT_SIN_CLAVE', MENSAJES_CERTIFICADO.sinClave);
  const bolsaClave = bolsasClave[0];
  let clave: KeyObject;
  try {
    if (!bolsaClave.key) throw new Error('clave no RSA');
    clave = createPrivateKey(forge.pki.privateKeyToPem(bolsaClave.key as forge.pki.rsa.PrivateKey));
  } catch {
    throw new ErrorCertificado('VERIFACTU_CERT_CLAVE_NO_ADMITIDA', MENSAJES_CERTIFICADO.claveNoAdmitida);
  }

  // 7. El certificado del titular: el que comparte localKeyId con la clave o, si no, el primero que no es de CA y casa con la clave.
  const bolsasCert = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const derDe = (b: forge.pkcs12.Bag): Buffer | null => {
    try {
      if (b.cert) return aBuffer(forge.asn1.toDer(forge.pki.certificateToAsn1(b.cert)).getBytes());
      if (b.asn1) return aBuffer(forge.asn1.toDer(b.asn1).getBytes());
    } catch {
      return null;
    }
    return null;
  };
  const idClave = bolsaClave.attributes?.localKeyId?.[0];
  const candidatas = bolsasCert
    .map((b) => {
      const der = derDe(b);
      let x: X509Certificate | null = null;
      try {
        x = der ? new X509Certificate(der) : null;
      } catch {
        x = null;
      }
      return { b, x };
    })
    .filter((c): c is { b: forge.pkcs12.Bag; x: X509Certificate } => !!c.x);
  const porId = idClave ? candidatas.find((c) => c.b.attributes?.localKeyId?.[0] === idClave && c.x.checkPrivateKey(clave)) : undefined;
  const elegido = porId ?? candidatas.find((c) => !c.x.ca && c.x.checkPrivateKey(clave));
  if (!elegido) throw new ErrorCertificado('VERIFACTU_CERT_SIN_CLAVE', MENSAJES_CERTIFICADO.sinClave);

  // 8. Los datos, de X509Certificate.
  const metadatos = metadatosDeX509(elegido.x);

  // 9. Vigencia.
  if (Number.isNaN(metadatos.caducaEn.getTime()) || Number.isNaN(metadatos.validoDesde.getTime())) {
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }
  if (metadatos.caducaEn.getTime() <= ahora.getTime()) throw new ErrorCertificado('VERIFACTU_CERT_CADUCADO', MENSAJES_CERTIFICADO.caducado(fechaCorta(metadatos.caducaEn)));
  if (metadatos.validoDesde.getTime() > ahora.getTime()) throw new ErrorCertificado('VERIFACTU_CERT_AUN_NO_VALIDO', MENSAJES_CERTIFICADO.aunNoValido(fechaCorta(metadatos.validoDesde)));
  return { metadatos };
}
