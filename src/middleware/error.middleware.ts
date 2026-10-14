import { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../utils/http-errors';
import { logger } from '../config/logger';
import { config } from '../config/env';
import { errorFalloBD, QUE_HACER_GENERICO } from '../utils/errores-bd';

/** Handler para rutas no encontradas (404). */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    statusCode: 404,
  });
};

/** Manejador global de errores. Responde JSON { message, statusCode }. */
export const errorMiddleware: ErrorRequestHandler = (errOriginal, req, res, _next) => {
  // Un fallo de la base de datos (tiempo agotado, sin conexion, transaccion
  // caducada...) que nadie ha traducido antes: la persona lee la causa en
  // castellano y que hacer, con un 503 si es pasajero, nunca «Error interno del
  // servidor». errorFalloBD deja el detalle tecnico en el log.
  const deBD =
    errOriginal instanceof HttpError ? null : errorFalloBD(errOriginal, QUE_HACER_GENERICO, `atender ${req.method} ${req.originalUrl.split('?')[0]}`);
  const err = deBD ?? errOriginal;
  const isHttp = err instanceof HttpError;
  const statusCode = isHttp ? err.statusCode : 500;
  const rawMessage = err instanceof Error ? err.message : 'Error interno del servidor';

  if (statusCode >= 500 && !deBD) {
    // El detalle interno (mensaje + stack) se registra en servidor, NUNCA se
    // devuelve al cliente: evita filtrar rutas, SQL, nombres de tabla, etc.
    logger.error(`Unhandled error: ${rawMessage}`, err);
  }

  // Para errores 5xx exponemos un mensaje generico (OWASP: no leak de internals).
  // Los errores HttpError (4xx) si llevan su mensaje, son intencionados y seguros.
  const message = isHttp ? rawMessage : 'Error interno del servidor';

  const body: Record<string, unknown> = { message, statusCode };
  if (isHttp && err.details !== undefined) {
    body.details = err.details;
  }

  res.status(statusCode).json(body);
};
