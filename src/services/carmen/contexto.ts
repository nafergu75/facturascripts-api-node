/**
 * Contexto de Carmen en una petición: quién pregunta, en qué empresa y con qué
 * permisos. Los permisos salen de permisosEnEmpresa, la misma función que usa
 * authorize.middleware: Carmen no amplía nunca lo que el usuario ya puede ver.
 */
import type { AuthUser } from '../../types/express';
import { permisosEnEmpresa, usuarioTienePermiso } from '../rbac.service';
import { hoyEspana } from '../../utils/fechas';
import type { CarmenCtx } from './tipos';

export function construirContexto(user: AuthUser, companyId: string, hoy: string = hoyEspana()): CarmenCtx {
  const permisos = permisosEnEmpresa(user, companyId);
  const roles = user.rolesPorEmpresa ? (user.rolesPorEmpresa[companyId] ?? []) : (user.roles ?? []);
  const esAdminGlobal = user.esAdminGlobal === true;
  const esAdminEmpresa = esAdminGlobal || roles.includes('admin');
  return {
    companyId,
    userId: user.userId,
    permisos: new Set(permisos),
    esAdminGlobal,
    esAdminEmpresa,
    // En main no hay permiso propio de nóminas: admin global, o admin o contable en la empresa.
    puedeNominas: esAdminGlobal || roles.includes('admin') || roles.includes('contable'),
    hoy,
  };
}

/** Tiene al menos uno de los permisos (con comodines '*' y 'recurso:*'). */
export function tiene(ctx: Pick<CarmenCtx, 'permisos'>, ...necesarios: string[]): boolean {
  const lista = [...ctx.permisos];
  return necesarios.some((p) => usuarioTienePermiso(lista, p));
}
