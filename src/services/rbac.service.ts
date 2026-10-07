import { NombreRol, Permiso } from '../domain/rbac.model';

/** Catalogo de permisos del sistema (semilla en codigo). */
export const PERMISOS: Permiso[] = [
  { id: 'p1', code: 'contabilidad:read' },
  { id: 'p2', code: 'contabilidad:write' },
  { id: 'p3', code: 'tesoreria:read' },
  { id: 'p4', code: 'tesoreria:write' },
  { id: 'p5', code: 'aeat:read' },
  { id: 'p6', code: 'ventas:read' },
  { id: 'p7', code: 'ventas:write' },
  { id: 'p8', code: 'config:write' },
  // Administracion de plataforma (solo admin global, ver authorize.middleware).
  { id: 'p9', code: 'admin:global' },
  { id: 'p10', code: 'admin:empresa' },
  // Modulo Impuestos (calendario fiscal, autorrelleno, presentaciones).
  { id: 'p11', code: 'impuestos:read' },
  { id: 'p12', code: 'impuestos:write' },
  // Facturas de gasto y lector de gastos.
  { id: 'p13', code: 'compras:read' },
  { id: 'p14', code: 'compras:write' },
  // Nominas y trabajadores (datos personales y salariales): solo admin y contable.
  { id: 'p15', code: 'nominas:read' },
  { id: 'p16', code: 'nominas:write' },
];

/** Permisos por rol (admin = comodin total). */
const ROL_PERMISOS: Record<NombreRol, string[]> = {
  admin: ['*'],
  contable: ['contabilidad:read', 'contabilidad:write', 'aeat:read', 'tesoreria:read', 'impuestos:read', 'impuestos:write', 'compras:read', 'compras:write', 'nominas:read', 'nominas:write'],
  tesoreria: ['tesoreria:read', 'tesoreria:write', 'contabilidad:read'],
  ventas: ['ventas:read', 'ventas:write', 'contabilidad:read'],
  'solo-lectura': ['contabilidad:read', 'tesoreria:read', 'aeat:read', 'ventas:read', 'impuestos:read', 'compras:read'],
};

/** Devuelve los permisos (codigos) derivados de un conjunto de roles. */
export function permisosDeRoles(roles: string[]): string[] {
  const set = new Set<string>();
  for (const rol of roles) {
    // En la BD el rol es `solo_lectura` (enum de Prisma, sin guiones); aqui, `solo-lectura`.
    const permisos = ROL_PERMISOS[rol.replace(/_/g, '-') as NombreRol];
    if (permisos) permisos.forEach((p) => set.add(p));
  }
  return [...set];
}

/** Comprueba si la lista de permisos cubre el permiso necesario (soporta comodines). */
export function usuarioTienePermiso(permisos: string[], permisoNecesario: string): boolean {
  if (permisos.includes('*')) return true;
  if (permisos.includes(permisoNecesario)) return true;
  // comodin por recurso: 'contabilidad:*' cubre 'contabilidad:read'
  const [recurso] = permisoNecesario.split(':');
  return permisos.includes(`${recurso}:*`);
}

/** Lo justo del usuario autenticado para calcular sus permisos (ver AuthUser). */
export interface UsuarioConRoles {
  roles?: string[];
  rolesPorEmpresa?: Record<string, string[]>;
  esAdminGlobal?: boolean;
}

/**
 * Permisos del usuario en una empresa. Cuentan solo los roles en ESA empresa
 * (rolesPorEmpresa); los tokens antiguos, sin rolesPorEmpresa, usan la lista
 * general. El admin global lo tiene todo ('*'). Sin empresa, la lista general.
 * La usan authorize.middleware y Carmen, para que las dos decidan igual.
 */
export function permisosEnEmpresa(user: UsuarioConRoles, companyId?: string): string[] {
  if (user.esAdminGlobal) return ['*'];
  const roles = companyId && user.rolesPorEmpresa ? (user.rolesPorEmpresa[companyId] ?? []) : (user.roles ?? []);
  return permisosDeRoles(roles);
}

/**
 * Decisión de permiso: basta con UNO de los necesarios. 'admin:global' (pedido
 * solo) es exclusivo del admin global de plataforma; el admin global pasa todo
 * lo demás. Es la única regla: la usan authorize.middleware (rutas) y Carmen
 * (cada intención), para que las dos decidan exactamente igual.
 */
export function cubrePermisos(permisos: Iterable<string>, necesarios: string[], esAdminGlobal = false): boolean {
  if (necesarios.length === 1 && necesarios[0] === 'admin:global') return esAdminGlobal;
  if (esAdminGlobal) return true;
  const lista = [...permisos];
  return necesarios.some((p) => usuarioTienePermiso(lista, p));
}

/** ¿Puede el usuario, en esa empresa, con al menos uno de estos permisos? */
export function autorizado(user: UsuarioConRoles, companyId: string | undefined, necesarios: string[]): boolean {
  return cubrePermisos(permisosEnEmpresa(user, companyId), necesarios, user.esAdminGlobal === true);
}
