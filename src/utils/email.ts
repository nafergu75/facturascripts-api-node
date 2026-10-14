/**
 * Email de un cliente o de un proveedor.
 *
 * Se guarda sin espacios alrededor y con la forma nombre@empresa.com. Vacio =
 * sin email (null, no ''). Lo que no tiene esa forma o no cabe en la columna
 * (VARCHAR(191): antes daba un 500) da un motivo claro.
 */

/** Largo maximo de la columna `email` (String de Prisma: VARCHAR(191)). */
export const LARGO_MAXIMO_EMAIL = 191;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ResultadoEmail = { ok: true; email: string | null } | { ok: false; motivo: string };

export function normalizarEmail(valor: unknown): ResultadoEmail {
  if (valor === undefined || valor === null) return { ok: true, email: null };
  const e = String(valor).trim();
  if (!e) return { ok: true, email: null };
  if (!EMAIL.test(e)) return { ok: false, motivo: 'El email no es válido. Escríbelo como nombre@empresa.com.' };
  if (e.length > LARGO_MAXIMO_EMAIL) return { ok: false, motivo: `El email es demasiado largo (${LARGO_MAXIMO_EMAIL} caracteres como mucho).` };
  return { ok: true, email: e };
}
