import { RequestHandler } from 'express';
import { badRequest, forbidden, unauthorized } from '../utils/http-errors';
import { config } from '../config/env';

/**
 * Control de acceso multiempresa.
 *
 * 1. Obtiene companyId (prioriza params, luego query, luego body).
 * 2. Comprueba que ese companyId esta en la lista de empresas del usuario
 *    autenticado (req.user.companies). Si no, responde 403.
 * 3. Adjunta el companyId normalizado a req.companyId.
 *
 * Requiere que authMiddleware se haya ejecutado antes (necesita req.user).
 */
export const companyScope: RequestHandler = (req, _res, next) => {
  if (!req.user) {
    return next(unauthorized('Usuario no autenticado.'));
  }

  const raw =
    (req.params.companyId as string | undefined) ??
    (req.query.companyId as string | undefined) ??
    (req.body?.companyId as string | undefined);

  if (!raw) {
    return next(badRequest('Falta companyId (en params, query o body).'));
  }

  const companyId = String(raw);

  // El admin GLOBAL puede acceder a cualquier empresa valida; el resto, solo a
  // las empresas de su token (memberships).
  // En desarrollo, aceptamos cualquier companyId para facilitar testing
  if (!req.user.esAdminGlobal && !req.user.companies.includes(companyId)) {
    if (config.nodeEnv !== 'development') {
      return next(forbidden('El usuario no tiene acceso a esta empresa.', { companyId }));
    }
    // En development, aceptamos cualquier empresa
  }

  req.companyId = companyId;
  return next();
};
