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
 *
 * Solo se pide repetir cuando el fallo es pasajero (tiempo, conexion, otra
 * operacion a la vez). Un error que se repetiria igual (un dato que choca con
 * otro, por ejemplo) pide avisar a soporte si vuelve a pasar.
 */
import { Prisma } from '@prisma/client';
import { logger } from '../config/logger';
import { esErrorDeConexion } from '../config/reintentoConexion';
import { HttpError } from './http-errors';

/** Codigo de los 503 (y 500) por un fallo de la base de datos (en `details.codigo`). */
export const CODIGO_FALLO_BD = 'FALLO_BD';

export const TEXTO_BD_LENTA = 'La base de datos ha tardado demasiado en responder.';
export const TEXTO_BD_OCUPADA = 'La base de datos estaba ocupada con otra operación al mismo tiempo.';
export const TEXTO_BD_ERROR = 'La base de datos ha dado un error inesperado.';

/** Lo que se dice tras un fallo que no es pasajero, en vez de «vuelve a intentarlo». */
export const TEXTO_AVISAR_SOPORTE = 'Si vuelve a pasar, avisa a soporte.';

/**
 * Lo que se dice a la persona tras la causa: que ha pasado con lo que pedia
 * («El asiento no se ha creado») y, si tiene sentido, que lo repita. `repetir`
 * solo se dice si el fallo es pasajero; si no lo es, se cambia por
 * TEXTO_AVISAR_SOPORTE. Sin `repetir`, solo el resultado.
 */
export interface QueHacerFalloBD {
  resultado: string;
  repetir?: string;
}

/** Al registrar una factura leida, si la base de datos falla antes de grabarla (no queda nada registrado). */
export const QUE_HACER_REGISTRAR: QueHacerFalloBD = {
  resultado: 'La factura no se ha registrado',
  repetir: 'vuelve a intentarlo dentro de un momento',
};

/**
 * Al registrar una compra, si la base de datos falla justo despues de grabarla:
 * la factura y su asiento ya estan, asi que no se dice que no se ha registrado.
 */
export const QUE_HACER_GASTO_YA_REGISTRADO: QueHacerFalloBD = {
  resultado: 'La factura sí está registrada: búscala en Compras antes de volver a registrarla',
};

/** Lo que se le dice a quien registro la factura cuando su asiento automatico no se ha podido crear. */
export const TEXTO_FACTURA_REGISTRADA = 'La factura sí está registrada.';

/** Prisma: sin conexion, tiempo agotado al conectar o al esperar conexion, transaccion caducada. */
const CODIGOS_TIEMPO = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028']);
/** Prisma: conflicto de escritura o bloqueo con otra transaccion (deadlock). */
const CODIGO_OCUPADA = 'P2034';
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
 * de un error que ya se ha traducido con errorFalloBD (lleva la causa en details).
 */
export function causaFalloBD(err: unknown): string | null {
  if (err instanceof HttpError) {
    const d = err.details as { codigo?: unknown; causa?: unknown } | undefined;
    return d?.codigo === CODIGO_FALLO_BD && typeof d.causa === 'string' ? d.causa : null;
  }
  if (!esFalloTecnicoBD(err)) return null;
  const codigo = codigoDe(err);
  if (err instanceof Prisma.PrismaClientInitializationError || (codigo !== null && CODIGOS_TIEMPO.has(codigo)) || TEXTO_TIEMPO.test(mensajeDe(err))) {
    return TEXTO_BD_LENTA;
  }
  return codigo === CODIGO_OCUPADA ? TEXTO_BD_OCUPADA : TEXTO_BD_ERROR;
}

/** Causas de un fallo que se arregla solo (tiempo, conexion, otra operacion a la vez): tiene sentido repetir. */
const CAUSAS_PASAJERAS = new Set([TEXTO_BD_LENTA, TEXTO_BD_OCUPADA]);

/** El texto para la persona: la causa y que hacer (repetir solo si el fallo es pasajero). */
function textoFalloBD(causa: string, queHacer: QueHacerFalloBD): string {
  if (!queHacer.repetir) return `${causa} ${queHacer.resultado}.`;
  return CAUSAS_PASAJERAS.has(causa) ? `${causa} ${queHacer.resultado}: ${queHacer.repetir}.` : `${causa} ${queHacer.resultado}. ${TEXTO_AVISAR_SOPORTE}`;
}

/**
 * Si es un fallo tecnico, lo deja en el log y devuelve el error para la
 * persona: un 503 si es pasajero y un 500 si no, con la causa y que hacer. En
 * `details` van el codigo FALLO_BD, la causa, el codigo de Prisma, si lo hay
 * (la pista para soporte, sin el texto tecnico), y `extra`.
 * null si no lo es (el que llama sigue como siempre).
 */
export function errorFalloBD(err: unknown, queHacer: QueHacerFalloBD, contexto: string, extra: Record<string, unknown> = {}): HttpError | null {
  const causa = causaFalloBD(err);
  if (!causa) return null;
  if (err instanceof HttpError) return err;
  const codigoBD = codigoDe(err);
  logger.error(`Fallo de la base de datos al ${contexto}`, { codigo: codigoBD, detalle: mensajeDe(err) });
  const e = new HttpError(CAUSAS_PASAJERAS.has(causa) ? 503 : 500, textoFalloBD(causa, queHacer), {
    codigo: CODIGO_FALLO_BD,
    causa,
    ...(codigoBD ? { codigoBD } : {}),
    ...extra,
  });
  // El original, para el log y la auditoria (no va en la respuesta: solo salen message y details).
  (e as Error & { cause?: unknown }).cause = err;
  return e;
}

/**
 * Texto tecnico de un fallo de la base de datos, para el log y la auditoria
 * (tambien el del original de un error de errorFalloBD). null si no lo es.
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
