import { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../utils/http-errors';
import { logger } from '../config/logger';
import { config } from '../config/env';

/** Handler para rutas no encontradas (404). */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
    statusCode: 404,
  });
};

/** Manejador global de errores. Responde JSON { message, statusCode }. */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const isHttp = err instanceof HttpError;
  const statusCode = isHttp ? err.statusCode : 500;
  const rawMessage = err instanceof Error ? err.message : 'Error interno del servidor';

  if (statusCode >= 500) {
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
