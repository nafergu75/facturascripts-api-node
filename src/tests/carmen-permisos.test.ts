/**
 * Carmen decide los permisos con la misma regla que authorize.middleware
 * (rbac.service, cubrePermisos): para cada rol, empresa y permiso del
 * catálogo, y para la lista de permisos de cada intención, Carmen deja pasar
 * exactamente a quien deja pasar la ruta.
 */
jest.mock('../config/database', () => ({ prisma: {} }));

import type { Request } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { PERMISOS, autorizado, cubrePermisos } from '../services/rbac.service';
import { construirContexto, tiene } from '../services/carmen/contexto';
import { INTENCIONES } from '../services/carmen/intenciones/catalogo';
import type { AuthUser } from '../types/express';

const ROLES = ['admin', 'contable', 'tesoreria', 'ventas', 'solo_lectura'];

/** Usuario con un rol en E1 y otro distinto en E2 (los permisos son por empresa). */
const usuarios: Array<[string, AuthUser]> = [
  ...ROLES.map((r): [string, AuthUser] => [r, { userId: 'U', roles: [r, 'admin'], rolesPorEmpresa: { E1: [r], E2: ['admin'] }, companies: ['E1', 'E2'] }]),
  ['sin rol en E1', { userId: 'U', roles: ['admin'], rolesPorEmpresa: { E1: [], E2: ['admin'] }, companies: ['E1', 'E2'] }],
  ['token antiguo (sin rolesPorEmpresa)', { userId: 'U', roles: ['ventas'], companies: ['E1'] }],
  ['admin global', { userId: 'U', roles: [], rolesPorEmpresa: {}, companies: [], esAdminGlobal: true }],
];

/** Lo que decide la ruta: authorize(...) llama a next() sin error. */
function pasaLaRuta(user: AuthUser, companyId: string, permisos: string[]): boolean {
  let error: unknown = 'sin llamar';
  authorize(...permisos)({ user, companyId } as unknown as Request, {} as never, (e?: unknown) => {
    error = e;
  });
  return error === undefined;
}

const listas: string[][] = [
  ...PERMISOS.map((p) => [p.code]),
  ...INTENCIONES.filter((i) => i.permisos.length).map((i) => i.permisos),
  ['compras:read', 'contabilidad:read'],
];

describe('un solo criterio de permisos para las rutas y para Carmen', () => {
  it.each(usuarios)('%s: Carmen y authorize deciden igual en cada permiso y en cada intención', (_n, user) => {
    for (const companyId of ['E1', 'E2']) {
      const ctx = construirContexto(user, companyId, '2026-10-07');
      for (const permisos of listas) {
        const ruta = pasaLaRuta(user, companyId, permisos);
        expect({ companyId, permisos, carmen: tiene(ctx, ...permisos) }).toEqual({ companyId, permisos, carmen: ruta });
        expect(autorizado(user, companyId, permisos)).toBe(ruta);
      }
    }
  });

  it("'admin:global' es solo del admin global, aunque el rol de empresa sea admin ('*')", () => {
    expect(cubrePermisos(['*'], ['admin:global'])).toBe(false);
    expect(cubrePermisos([], ['admin:global'], true)).toBe(true);
    expect(cubrePermisos(['contabilidad:*'], ['contabilidad:read'])).toBe(true);
    expect(cubrePermisos(['ventas:read'], ['compras:read', 'ventas:read'])).toBe(true);
    expect(cubrePermisos(['ventas:read'], ['compras:read'])).toBe(false);
  });
});
