/**
 * Fallos tecnicos de la base de datos frente a errores pensados para el usuario.
 *
 * Al contabilizar, un error de negocio (una cuenta que no vale, un mes cerrado)
 * llega como HttpError con su texto para la persona y se ensena tal cual. Un
 * fallo tecnico (una transaccion que caduca, la conexion que se corta, un error
 * de Prisma) no: su texto es para el log. Antes el lector de ventas enseno
 * «Invalid `prisma.journalEntry.create()` invocation: Transaction API error...».
 * Ahora la persona lee la causa en castellano y que hacer, y el detalle tecnico
 * va solo al log.
 */
import { Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { esErrorDeConexion } from '../config/reintentoConexion';
import { HttpError } from './http-errors';

/** Codigo de los 503 por un fallo de la base de datos (en `details.codigo`). */
export const CODIGO_FALLO_BD = 'FALLO_BD';

export const TEXTO_BD_LENTA = 'La base de datos ha tardado demasiado en responder.';
export const TEXTO_BD_ERROR = 'La base de datos ha dado un error inesperado.';

/** Que hacer si la base de datos falla al registrar una factura leida (no queda nada registrado). */
export const QUE_HACER_REGISTRAR = 'La factura no se ha registrado: vuelve a intentarlo dentro de un momento.';

/** Lo que se le dice a quien registro la factura cuando su asiento automatico no se ha podido crear. */
export const TEXTO_FACTURA_REGISTRADA = 'La factura sí está registrada.';

/** Prisma: sin conexion, tiempo agotado al conectar o al esperar conexion, transaccion caducada. */
const CODIGOS_TIEMPO = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
const TEXTO_TIEMPO = /timed out|timeout|expired transaction|transaction already closed|can't reach database server|server has closed the connection|connection (reset|refused|closed)/i;

const codigoDe = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};
const mensajeDe = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? '');

/** Error de Prisma o de conexion (no un HttpError ni un error con texto para el usuario). */
export function esFalloTecnicoBD(err: unknown): boolean {
  if (err instanceof HttpError) return false;
  if (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientValidationError
  ) {
    return true;
  }
  const codigo = codigoDe(err);
  if (codigo && /^P\d{4}$/.test(codigo)) return true;
  return esErrorDeConexion(err) || /Invalid `(prisma|tx)\.|Transaction API error/i.test(mensajeDe(err));
}

/**
 * La causa, en castellano, de un fallo tecnico (null si no lo es). Tambien la
 * de un 503 que ya se ha traducido con errorFalloBD (lleva la causa en details).
 */
export function causaFalloBD(err: unknown): string | null {
  if (err instanceof HttpError) {
    const d = err.details as { codigo?: unknown; causa?: unknown } | undefined;
    return d?.codigo === CODIGO_FALLO_BD && typeof d.causa === 'string' ? d.causa : null;
  }
  if (!esFalloTecnicoBD(err)) return null;
  const codigo = codigoDe(err);
  const tiempo = err instanceof Prisma.PrismaClientInitializationError || (codigo !== null && CODIGOS_TIEMPO.has(codigo)) || TEXTO_TIEMPO.test(mensajeDe(err));
  return tiempo ? TEXTO_BD_LENTA : TEXTO_BD_ERROR;
}

/**
 * Si es un fallo tecnico, lo deja en el log y devuelve el 503 para la persona:
 * la causa y `queHacer` («El asiento no se ha creado: vuelve a pulsar...»).
 * null si no lo es (el que llama sigue como siempre).
 */
export function errorFalloBD(err: unknown, queHacer: string, contexto: string): HttpError | null {
  const causa = causaFalloBD(err);
  if (!causa) return null;
  if (err instanceof HttpError) return err;
  logger.error(`Fallo de la base de datos al ${contexto}`, { codigo: codigoDe(err), detalle: mensajeDe(err) });
  const e = new HttpError(503, `${causa} ${queHacer}`, { codigo: CODIGO_FALLO_BD, causa });
  // El original, para el log y la auditoria (no va en la respuesta: solo salen message y details).
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}

/**
 * Texto tecnico de un fallo de la base de datos, para el log y la auditoria
 * (tambien el del original de un 503 de errorFalloBD). null si no lo es.
 */
export function detalleFalloBD(err: unknown): string | null {
  if (!causaFalloBD(err)) return null;
  const original = err instanceof HttpError ? (err as Error & { cause?: unknown }).cause : err;
  return original === undefined ? null : mensajeDe(original) || String(original);
}

/**
 * Motivo para la persona de un asiento automatico que no se ha creado (la
 * factura si esta registrada). Los errores de negocio, con su texto; los
 * tecnicos, con la causa en castellano.
 */
export function motivoSinAsiento(err: unknown): string {
  const causa = causaFalloBD(err);
  if (causa) return `${causa} ${TEXTO_FACTURA_REGISTRADA}`;
  return err instanceof Error ? err.message : String(err);
}
