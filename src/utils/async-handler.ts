import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Envuelve un handler async y reenvia cualquier rechazo al middleware de error. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
