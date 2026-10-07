/**
 * Contexto de Carmen en una petición: quién pregunta, en qué empresa y con qué
 * permisos. Los permisos salen de permisosEnEmpresa, la misma función que usa
 * authorize.middleware: Carmen no amplía nunca lo que el usuario ya puede ver.
 */
import type { AuthUser } from '../../types/express';
import { cubrePermisos, permisosEnEmpresa } from '../rbac.service';
import { hoyEspana } from '../../utils/fechas';
import type { CarmenCtx } from './tipos';

/**
 * Permiso de las respuestas con datos de nóminas (gastos de personal, cuentas
 * 64x, 465 y 476): el mismo 'nominas:read' que exigen las rutas de /nominas y
 * /empleados (admin y contable; el admin global también).
 */
export const PERMISO_NOMINAS = 'nominas:read';

/** Grupo con que se guardaban esas respuestas antes de existir 'nominas:read'. */
export const PERMISO_NOMINAS_ANTIGUO = 'nominas';

/** Lo que Carmen necesita del perfil de la empresa (perfilEmpresa.service). */
export interface PerfilCarmen {
  espanola: boolean;
  monedaCuenta: string;
}

/** Empresa sin configuración legal: española y en euros (como perfilEmpresa). */
export const PERFIL_POR_DEFECTO: PerfilCarmen = { espanola: true, monedaCuenta: 'EUR' };

export function construirContexto(user: AuthUser, companyId: string, hoy: string = hoyEspana(), perfil: PerfilCarmen = PERFIL_POR_DEFECTO): CarmenCtx {
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
    // Misma regla que authorize('nominas:read') en las rutas de nóminas.
    puedeNominas: cubrePermisos(permisos, [PERMISO_NOMINAS], esAdminGlobal),
    hoy,
    espanola: perfil.espanola,
    monedaCuenta: perfil.monedaCuenta,
  };
}

/**
 * Tiene al menos uno de los permisos (con comodines '*' y 'recurso:*'). Es la
 * misma regla que authorize.middleware (rbac.service, cubrePermisos).
 */
export function tiene(ctx: Pick<CarmenCtx, 'permisos'> & Partial<Pick<CarmenCtx, 'esAdminGlobal'>>, ...necesarios: string[]): boolean {
  return cubrePermisos(ctx.permisos, necesarios, ctx.esAdminGlobal === true);
}
