import { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../utils/http-errors';
import { permisosDeRoles, usuarioTienePermiso } from '../services/rbac.service';

/**
 * Middleware de autorizacion por permiso. Deriva los permisos de los roles del
 * usuario (que viajan en el JWT) y exige el permiso indicado.
 *
 * Uso: router.post('/', authorize('contabilidad:write'), handler)
 */
export function authorize(permisoNecesario: string): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized('Usuario no autenticado.'));

    // 'admin:global' es EXCLUSIVO del admin global de plataforma (no del 'admin'
    // de una empresa). El comodin de rol no lo concede.
    if (permisoNecesario === 'admin:global') {
      if (req.user.esAdminGlobal) return next();
      return next(forbidden('Requiere admin global de plataforma.'));
    }

    // El admin global tiene acceso a todo lo demas.
    if (req.user.esAdminGlobal) return next();

    const permisos = permisosDeRoles(req.user.roles ?? []);
    if (usuarioTienePermiso(permisos, permisoNecesario)) return next();
    return next(forbidden(`Falta permiso: ${permisoNecesario}`));
  };
}
