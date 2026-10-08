/**
 * Los roles de empresa son los mismos en la BD (enum Role), en lo que se puede
 * asignar (ROLES_VALIDOS) y en los permisos (rbac). Antes 'tesoreria' tenia
 * permisos en rbac pero no existia en la BD ni se podia asignar.
 */
import { describe, it, expect } from '@jest/globals';
import { Role } from '@prisma/client';
import { ROLES_VALIDOS } from '../services/admin.service';
import { permisosDeRoles } from '../services/rbac.service';

describe('roles de empresa coherentes', () => {
  it('el enum de la BD y los roles asignables son los mismos', () => {
    expect([...Object.values(Role)].sort()).toEqual([...ROLES_VALIDOS].sort());
  });

  it('cada rol asignable tiene permisos', () => {
    for (const rol of ROLES_VALIDOS) expect(permisosDeRoles([rol]).length).toBeGreaterThan(0);
  });

  it('no queda un rol tesoreria con permisos que nadie puede tener', () => {
    expect(permisosDeRoles(['tesoreria'])).toEqual([]);
  });
});
