export type NombreRol = 'admin' | 'contable' | 'tesoreria' | 'ventas' | 'solo-lectura';

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
