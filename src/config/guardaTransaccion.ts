import { AsyncLocalStorage } from 'async_hooks';
import { logger } from './logger';

/**
 * Consultas con el cliente global (`prisma`) dentro del callback de una
 * transaccion interactiva (`prisma.$transaction(async (tx) => ...)`).
 *
 * En produccion (Vercel + TiDB) el pool tiene UNA conexion (connection_limit=1)
 * y la ocupa la transaccion mientras dura. Una consulta con `prisma` en vez de
 * con `tx` dentro del callback se queda esperando conexion hasta el
 * pool_timeout (P2024) y la transaccion acaba caducando (P2028). El 14-10-2026
 * «Registrar cobro» respondio 500 a los 30 s por esto. En local no se ve: el
 * pool tiene varias conexiones y la consulta coge otra.
 *
 * El cliente compartido (config/database) marca el callback de cada
 * transaccion. Si dentro llega una consulta del cliente global (o se abre otra
 * transaccion):
 *  - en los tests (NODE_ENV=test) falla en el acto y queda anotada, para que
 *    jest.cerrar-bd la ensene aunque el codigo se trague el error;
 *  - fuera de los tests se avisa en el log con la consulta y se sigue.
 */
const callback = new AsyncLocalStorage<true>();

/** true si el codigo corre dentro del callback de una transaccion interactiva del cliente compartido. */
export function dentroDeTransaccion(): boolean {
  return callback.getStore() === true;
}

/** Ejecuta el callback de una transaccion marcado como tal. */
export function enCallbackDeTransaccion<T>(fn: () => T): T {
  return callback.run(true, fn);
}

/** Error de los tests: una consulta con el cliente global dentro de una transaccion. */
export class ClienteGlobalEnTransaccion extends Error {
  constructor(consulta: string) {
    super(
      `Consulta ${consulta} con el cliente global (prisma) dentro de una transacción: usa el cliente de la transacción (tx). ` +
        'En producción el pool tiene una sola conexión y la consulta se queda esperando hasta que la transacción caduca.',
    );
    this.name = 'ClienteGlobalEnTransaccion';
  }
}

const infracciones: string[] = [];

/** Las consultas globales dentro de transacciones vistas en este proceso (en los tests). */
export function infraccionesTransaccion(): readonly string[] {
  return infracciones;
}

/** Solo para los tests de la propia guarda: olvida las infracciones que han provocado a proposito. */
export function olvidarInfracciones(): void {
  infracciones.length = 0;
}

/** En los tests falla; fuera, solo avisa. BD_GUARDA_TRANSACCION=aviso lo deja en aviso tambien en los tests. */
const estricta = () => process.env.NODE_ENV === 'test' && process.env.BD_GUARDA_TRANSACCION !== 'aviso';

/**
 * Donde se hizo la consulta (fichero:linea), si Prisma lo sabe: lo guarda en sus
 * parametros internos (`callsite`). La pila del error no lo dice: Prisma la corta.
 */
export function sitioDeLaConsulta(parametros: unknown): string | null {
  try {
    const callsite = (parametros as { __internalParams?: { callsite?: { getLocation?: () => unknown } } } | null)?.__internalParams?.callsite;
    const l = callsite?.getLocation?.() as { fileName?: string; lineNumber?: number } | null | undefined;
    if (!l?.fileName) return null;
    const fichero = l.fileName.startsWith(process.cwd()) ? l.fileName.slice(process.cwd().length + 1) : l.fileName;
    return `${fichero.split('\\').join('/')}:${l.lineNumber ?? '?'}`;
  } catch {
    return null;
  }
}

/** Una consulta (`modelo.operacion`) con el cliente global dentro del callback de una transaccion. */
export function clienteGlobalEnTransaccion(consulta: string, sitio: string | null = null): void {
  const error = new ClienteGlobalEnTransaccion(sitio ? `${consulta} (${sitio})` : consulta);
  if (estricta()) {
    infracciones.push(error.stack ?? error.message);
    throw error;
  }
  logger.warn(`database: ${error.message}`, { consulta, stack: error.stack });
}
