import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config/env';

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
