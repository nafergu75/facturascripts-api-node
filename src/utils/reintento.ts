import { Prisma } from '@prisma/client';

/** P2002 (indice unico). Con `indices`, solo si el indice que salta contiene alguno de esos textos. */
export function esClaveRepetida(e: unknown, indices?: Array<string | RegExp>): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  if (!indices) return true;
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  const texto = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return indices.some((i) => (typeof i === 'string' ? texto.includes(i) : i.test(texto)));
}

/**
 * Repite la operacion (normalmente una transaccion entera) si falla por un
 * indice unico: dos procesos a la vez han sacado el mismo numero o codigo. Con
 * `indices`, solo ante esos indices; el resto de errores sale tal cual. Como
 * mucho `intentos` repeticiones (3 por defecto).
 */
export async function conReintento<T>(fn: () => Promise<T>, opciones: { indices?: Array<string | RegExp>; intentos?: number } = {}): Promise<T> {
  const max = opciones.intentos ?? 3;
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      if (!esClaveRepetida(e, opciones.indices) || intento >= max) throw e;
    }
  }
}
