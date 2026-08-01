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
];

/** Permisos por rol (admin = comodin total). */
const ROL_PERMISOS: Record<NombreRol, string[]> = {
  admin: ['*'],
  contable: ['contabilidad:read', 'contabilidad:write', 'aeat:read', 'tesoreria:read', 'impuestos:read', 'impuestos:write'],
  tesoreria: ['tesoreria:read', 'tesoreria:write', 'contabilidad:read'],
  ventas: ['ventas:read', 'ventas:write', 'contabilidad:read'],
  'solo-lectura': ['contabilidad:read', 'tesoreria:read', 'aeat:read', 'ventas:read', 'impuestos:read'],
};

/** Devuelve los permisos (codigos) derivados de un conjunto de roles. */
export function permisosDeRoles(roles: string[]): string[] {
  const set = new Set<string>();
  for (const rol of roles) {
    const permisos = ROL_PERMISOS[rol as NombreRol];
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
