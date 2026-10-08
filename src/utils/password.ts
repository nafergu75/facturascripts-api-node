import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'crypto';

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

/** Sin caracteres que se confunden al dictarlos o copiarlos a mano (0/O, 1/l/I). */
const ALFABETO = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Contrasena provisional (la que genera el servidor al dar de alta un usuario o
 * al restablecer la de otro). crypto.randomInt elige cada caracter sin sesgo de
 * modulo. Cumple siempre las reglas de admin.service (validarContrasena): 16
 * caracteres y nunca un mismo caracter repetido (si saliera, se repite).
 */
export function generarContrasenaProvisional(longitud = 16): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < longitud; i++) c += ALFABETO[randomInt(ALFABETO.length)];
    if (!/^(.)\1*$/.test(c)) return c;
  }
}

/** Dias que vale la contrasena provisional que pone un administrador. */
export const DIAS_CONTRASENA_PROVISIONAL = 7;

/** Fecha hasta la que vale una contrasena provisional puesta ahora. */
export function caducidadContrasenaProvisional(ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() + DIAS_CONTRASENA_PROVISIONAL * 24 * 60 * 60 * 1000);
}

/**
 * ¿La contrasena provisional ya no vale? Solo si tiene que cambiarla y tiene
 * fecha de caducidad pasada. Sin fecha (NULL) no caduca: la propia, o cuando el
 * administrador solo pidio que cambiara la que ya tenia.
 */
export function contrasenaProvisionalCaducada(
  u: { debeCambiarContrasena?: boolean | null; contrasenaProvisionalHasta?: Date | null },
  ahora: Date = new Date(),
): boolean {
  return u.debeCambiarContrasena === true && u.contrasenaProvisionalHasta instanceof Date && u.contrasenaProvisionalHasta.getTime() <= ahora.getTime();
}

/** Mensaje (401) cuando la contrasena provisional ha caducado. */
export const MENSAJE_PROVISIONAL_CADUCADA = 'Tu contraseña provisional ha caducado. Pide al administrador que te genere otra.';
