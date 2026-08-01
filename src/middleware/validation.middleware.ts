import { RequestHandler } from 'express';
import { ZodSchema } from 'zod';
import { badRequest } from '../utils/http-errors';

type Source = 'body' | 'query' | 'params';

/**
 * Valida req[source] contra un esquema Zod. En caso de error responde 400 con
 * el detalle de los campos. Si pasa, sustituye req[source] por los datos saneados.
 */
export function validate(schema: ZodSchema, source: Source = 'body'): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return next(badRequest('Datos de entrada invalidos.', result.error.flatten().fieldErrors));
    }
    (req as unknown as Record<string, unknown>)[source] = result.data;
    return next();
  };
}
