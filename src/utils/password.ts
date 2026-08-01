import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Hash/verify de contrasenas (placeholder funcional con scrypt de Node).
 * Cuando integremos la BD de usuarios se podra cambiar a bcrypt/argon2 si se desea.
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;

  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = scryptSync(plain, salt, 64);
  return hashBuf.length === testBuf.length && timingSafeEqual(hashBuf, testBuf);
}
