import { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../utils/http-errors';
import { autorizado } from '../services/rbac.service';

/**
 * Middleware de autorizacion por permiso. Deriva los permisos de los roles del
 * usuario (que viajan en el JWT) y exige el permiso indicado.
 *
 * Uso: router.post('/', authorize('contabilidad:write'), handler)
 * Con varios permisos basta con tener UNO: authorize('compras:write', 'ventas:write').
 */
export function authorize(...permisosNecesarios: string[]): RequestHandler {
  if (permisosNecesarios.length === 0) throw new Error('authorize() necesita al menos un permiso.');
  const permisoNecesario = permisosNecesarios.join(' o ');
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized('Usuario no autenticado.'));

    // Misma regla que Carmen (rbac.service, cubrePermisos): 'admin:global' es
    // EXCLUSIVO del admin global de plataforma (el comodin de rol no lo concede);
    // el admin global tiene acceso a todo lo demas; y en rutas de empresa cuentan
    // solo los roles en ESA empresa (tokens antiguos: la lista general).
    if (autorizado(req.user, req.companyId, permisosNecesarios)) return next();
    if (permisosNecesarios.length === 1 && permisosNecesarios[0] === 'admin:global') {
      return next(forbidden('Requiere admin global de plataforma.'));
    }
    return next(forbidden(`Falta permiso: ${permisoNecesario}`));
  };
}
