import { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { unauthorized } from '../utils/http-errors';
import { mismaHuella, sesionDeBd } from '../services/auth.service';
import type { AuthUser } from '../types/express';

/** Lee y valida el JWT del header. Devuelve el usuario del token o el error a devolver. */
function usuarioDelToken(header: string): AuthUser | Error {
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return unauthorized('Falta el token Bearer en el header Authorization.');
  }

  let payload: jwt.JwtPayload;
  try {
    // Solo con el atajo de desarrollo activado de forma explicita
    // (NODE_ENV=development + ALLOW_INSECURE_DEV_AUTH=1) se aceptan tokens
    // sin firma valida, para probar con tokens dummy del frontend.
    if (config.allowInsecureDevAuth) {
      try {
        payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
      } catch {
        // Atajo de desarrollo: decodifica sin validar firma
        const decoded = jwt.decode(token);
        if (!decoded || typeof decoded !== 'object') return unauthorized('Token invalido o no decodificable.');
        payload = decoded as jwt.JwtPayload;
      }
    } else {
      // Modo normal: validacion estricta de la firma
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    }
  } catch {
    return unauthorized('Token JWT invalido o expirado.');
  }

  // Un refresh token solo sirve para /auth/refresh, nunca como token de acceso.
  if (payload.type === 'refresh') return unauthorized('Usa el token de acceso, no el de refresco.');
  if (!payload.sub && !payload.userId) return unauthorized('Payload de token invalido.');

  return {
    userId: String(payload.sub ?? payload.userId),
    email: payload.email as string | undefined,
    roles: (payload.roles as string[] | undefined) ?? [],
    rolesPorEmpresa: payload.rolesPorEmpresa as Record<string, string[]> | undefined,
    companies: ((payload.companies as Array<string | number> | undefined) ?? []).map(String),
    esAdminGlobal: payload.esAdminGlobal === true,
    empresaSeleccionada: payload.empresaSeleccionada as string | undefined,
    huellaContrasena: typeof payload.pwd === 'string' ? payload.pwd : undefined,
  };
}

/**
 * Valida el JWT del header `Authorization: Bearer <token>` y puebla req.user.
 *
 * El token dura 24 h y solo "recuerda" como estaba el usuario al entrar. Por
 * eso, ademas de la firma, se mira la BD en cada peticion y se usa lo que dice
 * ella, no el token:
 * - usuario desactivado o borrado -> 401 al momento;
 * - contrasena cambiada desde que se emitio el token (huella `pwd`) -> 401;
 * - empresas, rol en cada empresa y modo administrador global: los ACTUALES.
 *   Quitar un acceso, bajar un rol o quitar el modo administrador surte efecto
 *   en la siguiente peticion; dar un acceso o subir un rol, tambien, sin tener
 *   que volver a entrar.
 *
 * companyScope y authorize trabajan despues con estos datos frescos.
 */
export const authMiddleware: RequestHandler = (req, _res, next) => {
  // Algunas rutas repiten authMiddleware en linea: si esta peticion ya se
  // contrasto con la BD, ni se repite la consulta ni se pisan los datos frescos
  // con los del token.
  if (req.user?.sesionVerificada) return next();

  const delToken = usuarioDelToken(req.header('authorization') ?? '');
  if (delToken instanceof Error) return next(delToken);

  sesionDeBd(delToken.userId)
    .then((bd) => {
      if (!bd) {
        // Atajo de desarrollo: tokens dummy de usuarios que no estan en la BD.
        if (config.allowInsecureDevAuth) {
          req.user = delToken;
          return next();
        }
        return next(unauthorized('Tu usuario ya no existe. Inicia sesión de nuevo.'));
      }
      if (!bd.activo) return next(unauthorized('Tu usuario está desactivado. Habla con el administrador de la plataforma.'));
      // Tokens emitidos antes de llevar huella: valen hasta que caducan (24 h).
      if (delToken.huellaContrasena !== undefined && !mismaHuella(delToken.huellaContrasena, bd.huellaContrasena)) {
        return next(unauthorized('Tu contraseña ha cambiado. Inicia sesión de nuevo con la nueva.'));
      }
      req.user = {
        ...delToken,
        esAdminGlobal: bd.esAdminGlobal,
        companies: bd.companies,
        roles: bd.roles,
        rolesPorEmpresa: bd.rolesPorEmpresa,
        sesionVerificada: true,
      };
      return next();
    })
    .catch(next);
};
