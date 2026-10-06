import { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../utils/http-errors';
import { esAdminGlobalVigente } from '../services/admin.service';

/**
 * Va DETRAS de authorize('admin:global') en las rutas de /admin. authorize se
 * fia del token, que dura 24 h; esto vuelve a mirar la BD, de modo que quitar
 * el modo administrador o desactivar a alguien le cierra el panel al momento.
 */
export const adminGlobalVigente: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized('Usuario no autenticado.'));
  esAdminGlobalVigente(req.user.userId)
    .then((vigente) =>
      vigente ? next() : next(forbidden('Ya no tienes el modo administrador. Cierra sesión y vuelve a entrar.')),
    )
    .catch(next);
};
