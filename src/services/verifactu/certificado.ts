/**
 * Lectura del certificado electronico (.pfx / .p12) que sube el administrador
 * para VERI*FACTU (spec verifactu, 2.5; plan F2, 6.2). Puro salvo el reloj.
 *
 * Seguridad (aviso GHSA-86w9-cpqp-85rv de node-forge sobre la verificacion de
 * firmas RSA): node-forge se usa SOLO para abrir el PKCS#12 y sacar sus partes
 * (la comprobacion de su MAC es HMAC, no RSA). Nunca se verifica una firma con
 * forge. La contraseña la comprueba el MAC al abrirlo y otra vez
 * tls.createSecureContext de Node, y los datos del certificado (titular, NIF,
 * emisor, serie, validez y huella) salen de crypto.X509Certificate a partir del DER.
 *
 * Tope de trabajo (un PKCS#12 hecho a mano con muchas iteraciones dejaria el
 * hilo colgado, y con el a los demas usuarios de la instancia):
 *  - antes de descifrar nada: fichero de 64 KB, contraseña de 128 caracteres
 *    y, en lo que se ve sin descifrar, 1.000.000 de iteraciones por parte, 4
 *    partes protegidas con contraseña y 3.000.000 de iteraciones en total;
 *  - al abrirlo con forge, que descifra tambien lo que va escondido dentro de
 *    otra parte cifrada: cada derivacion de clave se cuenta ANTES de hacerla
 *    (como mucho 6, y un presupuesto de iteraciones por tipo). El PBKDF2 lo
 *    hace el de Node (nativo), no el de forge, que es 30 veces mas lento;
 *  - OpenSSL (tls.createSecureContext) va DESPUES de forge: solo abre lo que
 *    forge ya ha abierto dentro del presupuesto.
 * El millon por parte no se baja: Firefox (NSS) exporta los .p12 con cuentas
 * altas (en su registro de errores se habla de hasta un millón; sin comprobar
 * con un fichero real), y Windows y OpenSSL con unas 2.000.
 *
 * La clave privada y la contraseña nunca salen de aqui: solo los metadatos.
 */
import { createPrivateKey, X509Certificate, type KeyObject } from 'crypto';
import { createSecureContext } from 'tls';
import forge from 'node-forge';
import { HttpError } from '../../utils/http-errors';

export const CERT_MAX_BYTES = 64 * 1024;
export const CONTRASENA_MAX = 128;
/** Iteraciones de una parte (MAC, contenedor cifrado o clave cifrada). */
export const ITERACIONES_MAX = 1_000_000;
/** Partes protegidas con contraseña que se ven sin descifrar (MAC, certificados y clave: 3 en un .p12 normal). */
export const PARTES_CIFRADAS_MAX = 4;
/** Suma de las iteraciones que se ven sin descifrar. */
export const ITERACIONES_TOTAL_MAX = 3_000_000;
/** Derivaciones de clave al abrirlo (un PBE de PKCS#12 hace dos: clave e IV). */
export const DERIVACIONES_MAX = 6;
/** Suma de iteraciones de PBKDF2 (nativo: unos 0,25 s por millon). */
export const PRESUPUESTO_PBKDF2 = 3_000_000;
/** Suma de iteraciones del derivador de PKCS#12 (MAC y 3DES; en JavaScript: unos 2 s por millon). */
export const PRESUPUESTO_PKCS12 = 1_000_000;
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

export interface ResumenIteraciones {
  /** La mayor cuenta de iteraciones. */
  max: bigint;
  /** La suma de todas. */
  suma: bigint;
  /** Cuantas partes protegidas con contraseña (MAC incluido). */
  partes: number;
}

/**
 * Las iteraciones que se ven en el PKCS#12 sin descifrar nada: la del MAC
 * (MacData) y las de PBKDF2 y los PBE de cada parte cifrada. Entra en los
 * OCTET STRING que llevan DER dentro (hasta PROFUNDIDAD_MAX niveles y
 * NODOS_MAX nodos). Lo que va dentro de una parte cifrada no se ve: eso lo
 * cuenta abrirPkcs12 antes de cada derivacion.
 */
export function resumenIteraciones(raiz: Nodo): ResumenIteraciones {
  let max = 0n;
  let suma = 0n;
  let partes = 0;
  let nodos = 0;
  const anotar = (v: bigint | null) => {
    if (v === null) return;
    partes++;
    suma += v;
    if (v > max) max = v;
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
  return { max, suma, partes };
}

/** La mayor cuenta de iteraciones que se ve sin descifrar. */
export function maxIteraciones(raiz: Nodo): bigint {
  return resumenIteraciones(raiz).max;
}

const errorIteraciones = () => new ErrorCertificado('VERIFACTU_CERT_ITERACIONES', MENSAJES_CERTIFICADO.iteraciones);

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

/** Largos maximos de las columnas de VerifactuCertificado (NIF VarChar(20); titular, emisor y serie VARCHAR(191)). */
export const LARGO_NIF_MAX = 20;
export const LARGO_TEXTO_MAX = 191;
const largo = (s: string) => Array.from(s).length;

/**
 * Los datos que se guardan y se enseñan del certificado del titular. Un
 * certificado con un NIF, titular, emisor o serie mas largos de lo que caben
 * (solo uno hecho a mano) es un fichero no valido: 400, no un 500 al guardarlo.
 */
export function metadatosDeX509(x: X509Certificate): MetadatosLeidos {
  const m = leerMetadatosDeX509(x);
  const nifs = [m.nifTitular, m.nifRepresentante ?? ''];
  const textos = [m.titular, m.emisor, m.numeroSerie];
  if (nifs.some((v) => largo(v) > LARGO_NIF_MAX) || textos.some((v) => largo(v) > LARGO_TEXTO_MAX)) {
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }
  return m;
}

function leerMetadatosDeX509(x: X509Certificate): MetadatosLeidos {
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

/** Resumenes que el PBKDF2 nativo de Node acepta por su nombre (el de forge.md.*.algorithm). */
const RESUMENES_NATIVOS = new Set(['sha1', 'sha256', 'sha384', 'sha512']);

type Funcion = (...a: unknown[]) => unknown;

/**
 * forge.pkcs12.pkcs12FromAsn1 con un presupuesto de trabajo y la contraseña
 * bien codificada en cada parte. Mientras dura la llamada (sincrona), las tres
 * derivaciones de clave de forge pasan por aqui:
 *  - cada una se cuenta ANTES de hacerla, tambien las de las partes que van
 *    escondidas dentro de otra cifrada (que el recorrido previo no ve): mas
 *    de ITERACIONES_MAX en una, mas de DERIVACIONES_MAX o mas del presupuesto
 *    de su tipo -> VERIFACTU_CERT_ITERACIONES, sin calcular nada;
 *  - PBKDF2 (PBES2, el AES que exportan hoy Windows, OpenSSL y Firefox) se
 *    hace con el de Node, y con la contraseña en UTF-8 como OpenSSL y Windows
 *    (forge usaria el byte bajo de cada caracter: con una «ñ» no abriria un
 *    certificado bueno);
 *  - el MAC y los PBE de PKCS#12 (3DES) usan la contraseña como BMPString,
 *    que forge ya hace bien.
 */
export function abrirPkcs12(asn1: forge.asn1.Asn1, contrasena: string): forge.pkcs12.Pkcs12Pfx {
  const p5 = forge.pkcs5 as unknown as { pbkdf2: Funcion };
  const p12 = forge.pkcs12 as unknown as { generateKey: Funcion };
  const pbe = (forge.pki as unknown as { pbe: { generatePkcs12Key: Funcion } }).pbe;
  const originales = { pbkdf2: p5.pbkdf2, generateKey: p12.generateKey, generatePkcs12Key: pbe.generatePkcs12Key };
  const gasto = { derivaciones: 0, pbkdf2: 0, pkcs12: 0 };
  const gastar = (tipo: 'pbkdf2' | 'pkcs12', iteraciones: unknown) => {
    const n = Number(iteraciones);
    gasto.derivaciones++;
    if (!Number.isSafeInteger(n) || n < 1 || n > ITERACIONES_MAX) throw errorIteraciones();
    gasto[tipo] += n;
    if (gasto.derivaciones > DERIVACIONES_MAX || gasto.pbkdf2 > PRESUPUESTO_PBKDF2 || gasto.pkcs12 > PRESUPUESTO_PKCS12) throw errorIteraciones();
  };
  p5.pbkdf2 = (clave: unknown, sal: unknown, iteraciones: unknown, largo: unknown, md: unknown, ...resto: unknown[]) => {
    gastar('pbkdf2', iteraciones);
    // Con el nombre del resumen (no su objeto), forge llama al PBKDF2 nativo de Node.
    const algoritmo = md && typeof md === 'object' ? (md as { algorithm?: unknown }).algorithm : undefined;
    const resumen = typeof algoritmo === 'string' && RESUMENES_NATIVOS.has(algoritmo) ? algoritmo : md;
    return originales.pbkdf2(typeof clave === 'string' ? forge.util.encodeUtf8(clave) : clave, sal, iteraciones, largo, resumen, ...resto);
  };
  const contado =
    (original: Funcion): Funcion =>
    (clave, sal, id, iteraciones, ...resto) => {
      gastar('pkcs12', iteraciones);
      return original(clave, sal, id, iteraciones, ...resto);
    };
  p12.generateKey = contado(originales.generateKey);
  pbe.generatePkcs12Key = contado(originales.generatePkcs12Key);
  try {
    return forge.pkcs12.pkcs12FromAsn1(asn1, false, contrasena);
  } finally {
    p5.pbkdf2 = originales.pbkdf2;
    p12.generateKey = originales.generateKey;
    pbe.generatePkcs12Key = originales.generatePkcs12Key;
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

  // 3. Tope de lo que se ve, antes de descifrar nada.
  const visto = resumenIteraciones(asn1);
  if (visto.max > BigInt(ITERACIONES_MAX) || visto.partes > PARTES_CIFRADAS_MAX || visto.suma > BigInt(ITERACIONES_TOTAL_MAX)) throw errorIteraciones();

  // 4. Las bolsas del PKCS#12, con forge (solo para abrirlo) y con su presupuesto: comprueba
  //    la contraseña (MAC) y abre tambien las partes escondidas sin pasar del tope.
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    p12 = abrirPkcs12(asn1, contrasena);
  } catch (e) {
    if (e instanceof ErrorCertificado) throw e;
    const msg = String((e as Error)?.message ?? '').toLowerCase();
    if (msg.includes('mac could not be verified') || msg.includes('wrong password') || msg.includes('failed to decrypt')) {
      throw new ErrorCertificado('VERIFACTU_CERT_CONTRASENA', MENSAJES_CERTIFICADO.contrasena);
    }
    // RC4, RC2 de 128 bits, 3DES de dos claves...: PBE antiguos de PKCS#12.
    if (msg.includes('pkcs #12 pbe data block. unsupported oid')) throw new ErrorCertificado('VERIFACTU_CERT_CIFRADO_ANTIGUO', MENSAJES_CERTIFICADO.cifradoAntiguo);
    throw new ErrorCertificado('VERIFACTU_CERT_FICHERO', MENSAJES_CERTIFICADO.fichero);
  }

  // 5. Con Node (OpenSSL), DESPUES de forge: lo que abre ya cabe en el presupuesto. Rechaza el
  //    cifrado antiguo (RC2-40, que forge si abre) y comprueba la clave.
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
