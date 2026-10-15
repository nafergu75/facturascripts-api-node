import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config/env';
import { dentroDeTransaccion } from '../config/guardaTransaccion';

/**
 * Cifrado simetrico AES-256-GCM para secretos en reposo (p.ej. las FS_API_KEY
 * de cada empresa). La clave (ENCRYPTION_KEY) son 32 bytes en hex (64 chars).
 *
 * Formato de salida: "<iv_hex>:<authTag_hex>:<ciphertext_hex>".
 */
const KEY = Buffer.from(config.encryptionKey, 'hex');

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Formato de secreto cifrado invalido.');
  }
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ---------- Version 1 (VERI*FACTU: certificado y su contraseña) ----------
//
// Formato: "v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>", AES-256-GCM con la
// misma ENCRYPTION_KEY y un contexto como datos asociados (AAD): un secreto
// copiado a otra empresa o a otro campo no se descifra. El prefijo de version
// permite rotar la clave sin romper lo guardado.
// Si un dia se rota ENCRYPTION_KEY, hace falta un script que vuelva a cifrar
// los certificados (y las claves de FacturaScripts): no existe todavia.
//
// Ni se cifra ni se descifra dentro de una transaccion (spec verifactu, 2.5):
// el certificado solo se abre fuera, justo antes de usarlo.
const PREFIJO_V1 = 'v1:';

function exigirFueraDeTransaccion(): void {
  if (dentroDeTransaccion()) throw new Error('Cifrado v1: no se cifra ni se descifra dentro de una transacción.');
}

/** Cifra `plano` ligado a `contexto` (p. ej. "verifactu:<companyId>:pfx"). */
export function cifrarV1(plano: string, contexto: string): string {
  exigirFueraDeTransaccion();
  if (!contexto) throw new Error('Cifrado v1: falta el contexto.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(Buffer.from(contexto, 'utf8'));
  const enc = Buffer.concat([cipher.update(plano, 'utf8'), cipher.final()]);
  return `${PREFIJO_V1}${[iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':')}`;
}

/** IV de 12 bytes, etiqueta de 16 y datos en hexadecimal: lo que escribe cifrarV1, y nada mas. */
const FORMATO_V1 = /^([0-9a-f]{24}):([0-9a-f]{32}):((?:[0-9a-f]{2})*)$/;

/**
 * Descifra lo de cifrarV1 con el mismo contexto. Error si falta el prefijo, el
 * contexto no casa o el dato se ha tocado. El IV y la etiqueta tienen que medir
 * lo que mide cifrarV1: Node aceptaria una etiqueta GCM recortada (4 bytes), que
 * se adivina mucho antes.
 */
export function descifrarV1(texto: string, contexto: string): string {
  exigirFueraDeTransaccion();
  if (typeof texto !== 'string' || !texto.startsWith(PREFIJO_V1)) throw new Error('Cifrado v1: falta el prefijo de versión.');
  const m = FORMATO_V1.exec(texto.slice(PREFIJO_V1.length));
  if (!m) throw new Error('Cifrado v1: formato no válido.');
  const [, ivHex, tagHex, dataHex] = m;
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivHex, 'hex'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(contexto, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}
