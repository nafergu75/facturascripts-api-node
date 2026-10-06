import { Prisma } from '@prisma/client';
import { logger } from './logger';

/**
 * Reintenta una consulta cuando falla por no poder conectar con la base de
 * datos. En Vercel, tras un rato sin uso, la primera conexion con TiDB puede
 * tardar mas de los 5 s que espera Prisma y la primera peticion (a menudo el
 * login) devolvia un 500.
 *
 * Solo se reintenta si el error es de CONEXION: la consulta no ha llegado a
 * ejecutarse, asi que repetirla es seguro aunque sea una escritura. Cualquier
 * otro error se devuelve tal cual, sin reintentar.
 */
const CODIGOS_CONEXION = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
export const ESPERAS_MS = [1000, 2000];

export function esErrorDeConexion(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  const codigo = (e as { code?: string; errorCode?: string } | null)?.code ?? (e as { errorCode?: string } | null)?.errorCode;
  if (codigo && CODIGOS_CONEXION.has(codigo)) return true;
  return /Can't reach database server|Timed out fetching a new connection|Server has closed the connection/i.test(
    String((e as Error | null)?.message ?? ''),
  );
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ejecuta `consulta` y, si falla por conexion, la repite tras cada espera. */
export async function conReintento<T>(consulta: () => Promise<T>, etiqueta: string, esperas: number[] = ESPERAS_MS): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await consulta();
    } catch (e) {
      if (intento >= esperas.length || !esErrorDeConexion(e)) throw e;
      logger.warn(`database: sin conexion en ${etiqueta}; reintento ${intento + 1} de ${esperas.length} en ${esperas[intento]} ms.`);
      await esperar(esperas[intento]);
    }
  }
}

export const reintentoConexion = Prisma.defineExtension({
  name: 'reintento-conexion',
  query: {
    $allModels: {
      $allOperations({ model, operation, args, query }) {
        return conReintento(() => query(args), `${model}.${operation}`);
      },
    },
  },
});
