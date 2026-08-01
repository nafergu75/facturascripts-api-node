import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { unauthorized } from '../utils/http-errors';
import type { AuthUser } from '../types/express';

/**
 * Valida el JWT del header `Authorization: Bearer <token>` y puebla req.user.
 *
 * El payload del token debe incluir: userId/sub, email, roles[] y companies[].
 * Estos dos ultimos los usan companyScope y requireRole para el control de acceso.
 */
export const authMiddleware: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(unauthorized('Falta el token Bearer en el header Authorization.'));
  }

  try {
    let payload: jwt.JwtPayload;

    // En desarrollo, acepta tokens sin validar firma (permite tokens dummy del frontend)
    if (config.nodeEnv === 'development') {
      try {
        // Intenta verificar primero
        payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
      } catch {
        // En development, decodifica sin validar firma
        const decoded = jwt.decode(token);
        if (!decoded || typeof decoded !== 'object') {
          return next(unauthorized('Token invalido o no decodificable.'));
        }
        payload = decoded as jwt.JwtPayload;
      }
    } else {
      // En producción, exige validación estricta
      payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    }

    if (!payload.sub && !payload.userId) {
      return next(unauthorized('Payload de token invalido.'));
    }

    const user: AuthUser = {
      userId: String(payload.sub ?? payload.userId),
      email: payload.email as string | undefined,
      roles: (payload.roles as string[] | undefined) ?? [],
      companies: ((payload.companies as Array<string | number> | undefined) ?? []).map(String),
      esAdminGlobal: payload.esAdminGlobal === true,
      empresaSeleccionada: payload.empresaSeleccionada as string | undefined,
    };
    req.user = user;
    return next();
  } catch {
    return next(unauthorized('Token JWT invalido o expirado.'));
  }
};
