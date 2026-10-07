/**
 * Contexto de Carmen en una petición: quién pregunta, en qué empresa y con qué
 * permisos. Los permisos salen de permisosEnEmpresa, la misma función que usa
 * authorize.middleware: Carmen no amplía nunca lo que el usuario ya puede ver.
 */
import type { AuthUser } from '../../types/express';
import { cubrePermisos, permisosEnEmpresa } from '../rbac.service';
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

/**
 * Tiene al menos uno de los permisos (con comodines '*' y 'recurso:*'). Es la
 * misma regla que authorize.middleware (rbac.service, cubrePermisos).
 */
export function tiene(ctx: Pick<CarmenCtx, 'permisos'> & Partial<Pick<CarmenCtx, 'esAdminGlobal'>>, ...necesarios: string[]): boolean {
  return cubrePermisos(ctx.permisos, necesarios, ctx.esAdminGlobal === true);
}
