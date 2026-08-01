import { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../utils/http-errors';

/**
 * Control de acceso por rol. Permite el paso si el usuario tiene al menos uno
 * de los roles indicados. Sin roles indicados, solo exige estar autenticado.
 *
 * Uso: router.post('/', requireRole('admin', 'contable'), controller.create)
 */
export function requireRole(...allowed: string[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      return next(unauthorized('Usuario no autenticado.'));
    }
    const roles = req.user.roles ?? [];
    if (allowed.length === 0 || roles.some((r) => allowed.includes(r))) {
      return next();
    }
    return next(forbidden('Rol insuficiente para esta operacion.'));
  };
}
