import { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../utils/http-errors';
import { permisosDeRoles, usuarioTienePermiso } from '../services/rbac.service';

/**
 * Middleware de autorizacion por permiso. Deriva los permisos de los roles del
 * usuario y exige el permiso indicado. Los roles y el modo administrador son
 * los ACTUALES de la BD: authMiddleware sustituye con ellos lo que traia el JWT.
 *
 * Uso: router.post('/', authorize('contabilidad:write'), handler)
 * Con varios permisos basta con tener UNO: authorize('compras:write', 'ventas:write').
 */
export function authorize(...permisosNecesarios: string[]): RequestHandler {
  if (permisosNecesarios.length === 0) throw new Error('authorize() necesita al menos un permiso.');
  const permisoNecesario = permisosNecesarios.join(' o ');
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized('Usuario no autenticado.'));

    // 'admin:global' es EXCLUSIVO del admin global de plataforma (no del 'admin'
    // de una empresa). El comodin de rol no lo concede.
    if (permisosNecesarios.length === 1 && permisosNecesarios[0] === 'admin:global') {
      if (req.user.esAdminGlobal) return next();
      return next(forbidden('Esto solo lo puede hacer un administrador global de la plataforma.'));
    }

    // El admin global tiene acceso a todo lo demas.
    if (req.user.esAdminGlobal) return next();

    // En rutas de empresa cuentan solo los roles en ESA empresa. Tokens antiguos
    // (sin rolesPorEmpresa) y rutas sin empresa usan la lista general.
    const roles =
      req.companyId && req.user.rolesPorEmpresa
        ? (req.user.rolesPorEmpresa[req.companyId] ?? [])
        : (req.user.roles ?? []);
    const permisos = permisosDeRoles(roles);
    if (permisosNecesarios.some((p) => usuarioTienePermiso(permisos, p))) return next();
    return next(forbidden(`Falta permiso: ${permisoNecesario}`));
  };
}
