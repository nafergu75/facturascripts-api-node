/**
 * Roles de empresa: los mismos que el enum Role de la BD (alli 'solo_lectura').
 * No hay rol 'tesoreria': estaba aqui con permisos, pero no en el enum ni en
 * ROLES_VALIDOS, asi que nadie podia tenerlo. tesoreria:write lo tiene el
 * administrador.
 */
export type NombreRol = 'admin' | 'contable' | 'ventas' | 'solo-lectura';

export interface Rol {
  id: string;
  name: NombreRol;
  description?: string;
}

export interface Permiso {
  id: string;
  code: string; // ej: 'contabilidad:write', 'aeat:read', 'tesoreria:write'
  description?: string;
}

export interface UserRole {
  userId: string;
  roleId: string;
}

export interface RolePermission {
  roleId: string;
  permisoId: string;
}
