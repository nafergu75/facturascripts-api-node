import { Prisma } from '@prisma/client';
import { logger } from './logger';
import { clienteGlobalEnTransaccion, dentroDeTransaccion, sitioDeLaConsulta } from './guardaTransaccion';

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

/**
 * El pool no tenia ninguna conexion libre en el tiempo de espera (P2024). No es
 * que la base de datos no responda: todas las conexiones del pool estan ocupadas.
 */
export function esPoolAgotado(e: unknown): boolean {
  const codigo = (e as { code?: string } | null)?.code;
  return codigo === 'P2024' || /Timed out fetching a new connection/i.test(String((e as Error | null)?.message ?? ''));
}

/**
 * Dentro del callback de una transaccion, el pool agotado no se repite: con una
 * sola conexion (produccion) la tiene la propia transaccion y no se va a soltar
 * mientras esta consulta espera. Repetirla solo alargaria la espera hasta que
 * la transaccion caduca (P2028), que es lo que paso el 14-10-2026.
 */
const reintentableEnTransaccion = (e: unknown) => esErrorDeConexion(e) && !esPoolAgotado(e);

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ejecuta `consulta` y, si falla por conexion (o lo que diga `reintentable`), la repite tras cada espera. */
export async function conReintento<T>(
  consulta: () => Promise<T>,
  etiqueta: string,
  esperas: number[] = ESPERAS_MS,
  reintentable: (e: unknown) => boolean = esErrorDeConexion,
): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await consulta();
    } catch (e) {
      if (intento >= esperas.length || !reintentable(e)) throw e;
      logger.warn(`database: sin conexion en ${etiqueta}; reintento ${intento + 1} de ${esperas.length} en ${esperas[intento]} ms.`);
      await esperar(esperas[intento]);
    }
  }
}

/**
 * La consulta va dentro de una transaccion (interactiva o en lote). Prisma lo
 * indica en los parametros internos que pasa a la extension.
 */
export function vaEnTransaccion(parametros: unknown): boolean {
  return !!(parametros as { __internalParams?: { transaction?: unknown } } | null)?.__internalParams?.transaction;
}

export const reintentoConexion = Prisma.defineExtension({
  name: 'reintento-conexion',
  query: {
    // Todas las operaciones, tambien las consultas en crudo ($queryRaw...), para
    // vigilar las del cliente global dentro de una transaccion.
    $allOperations(parametros) {
      const { model, operation, args, query } = parametros;
      // Dentro de una transaccion no se repite la consulta suelta: si se ha
      // perdido la conexion, la transaccion entera ya no vale (MySQL la deshace)
      // y repetir solo esa consulta no la arregla: alargaria la transaccion con
      // las esperas o, si la primera llego a ejecutarse, la duplicaria. Falla la
      // transaccion completa y decide quien la lanzo.
      if (vaEnTransaccion(parametros)) return query(args);
      const etiqueta = model ? `${model}.${operation}` : operation;
      // Cliente global dentro del callback de una transaccion (deberia ir con tx):
      // en los tests falla aqui mismo; fuera, se avisa (config/guardaTransaccion).
      const enCallback = dentroDeTransaccion();
      if (enCallback) clienteGlobalEnTransaccion(etiqueta, sitioDeLaConsulta(parametros));
      // Las consultas en crudo fuera de una transaccion siguen sin reintento.
      if (!model) return query(args);
      return conReintento(() => query(args), etiqueta, ESPERAS_MS, enCallback ? reintentableEnTransaccion : esErrorDeConexion);
    },
  },
});
