/**
 * Ayuda de los tests: cuantas sentencias SQL manda cada transaccion
 * interactiva mientras se ejecuta `fn`.
 *
 * En produccion (TiDB Serverless) cada sentencia es un viaje de red y la
 * transaccion tiene un tiempo maximo: cuantas menos, mejor. Se cuentan con el
 * contador «Questions» de la propia conexion de la transaccion (MySQL y
 * MariaDB), asi que entran tambien las lecturas que Prisma hace tras cada
 * create. Solo vale con la BD real.
 */
import { prisma } from '../config/database';

type ConRaw = { $queryRawUnsafe: (sql: string) => Promise<unknown> };

async function preguntas(tx: ConRaw): Promise<number> {
  const filas = (await tx.$queryRawUnsafe("SHOW SESSION STATUS LIKE 'Questions'")) as Array<Record<string, unknown>>;
  const fila = filas[0] ?? {};
  return Number(fila.Value ?? fila.value ?? Object.values(fila)[1]);
}

export async function consultasEnTransacciones<T>(fn: () => Promise<T>): Promise<{ resultado: T; porTransaccion: number[] }> {
  const original = prisma.$transaction.bind(prisma) as (arg: unknown, opciones?: unknown) => Promise<unknown>;
  const porTransaccion: number[] = [];
  const espia = jest.spyOn(prisma, '$transaction').mockImplementation(((arg: unknown, opciones?: unknown) => {
    if (typeof arg !== 'function') return original(arg, opciones);
    return original(async (tx: ConRaw) => {
      const antes = await preguntas(tx);
      const r = await (arg as (tx: ConRaw) => Promise<unknown>)(tx);
      // La consulta del contador tambien cuenta: se descuenta.
      porTransaccion.push((await preguntas(tx)) - antes - 1);
      return r;
    }, opciones);
  }) as never);
  try {
    return { resultado: await fn(), porTransaccion };
  } finally {
    espia.mockRestore();
  }
}
