// Permisos por empresa y tipo de token.
//
// Regresiones:
// - El token llevaba la UNION de roles de todas las empresas del usuario, y
//   authorize la aplicaba a cualquier empresa: admin en A + solo-lectura en B
//   daba permisos de admin en B.
// - Un refresh token (7 dias) se aceptaba como token de acceso.
//
// Los roles por empresa se leen de la BD en cada peticion (authMiddleware): la
// BD de estos tests es un mock con las membresias del usuario.
jest.mock('../config/database', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(async () => ({
        isActive: true,
        isGlobalAdmin: false,
        passwordHash: 'sal:hash',
        memberships: [
          { companyId: 'A', role: 'admin' },
          { companyId: 'B', role: 'solo_lectura' },
        ],
      })),
    },
  },
}));

import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { authMiddleware } from '../middleware/auth.middleware';
import { authorize } from '../middleware/authorize.middleware';
import { rolesPorEmpresaDe } from '../services/auth.service';

type Siguiente = jest.Mock<void, [unknown?]>;

function ejecutar(mw: (req: never, res: never, next: never) => void, req: Record<string, unknown>): unknown {
  const next: Siguiente = jest.fn();
  mw(req as never, {} as never, next as never);
  return next.mock.calls[0]?.[0];
}

/** authMiddleware consulta la BD: se espera a que llame a next. */
function autenticar(token: string): Promise<{ req: Record<string, unknown>; error: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const req: Record<string, unknown> = { headers, header: (n: string) => headers[n.toLowerCase()] };
  return new Promise((resolve) => {
    authMiddleware(req as never, {} as never, ((error?: unknown) => resolve({ req, error })) as never);
  });
}

const firmar = (payload: Record<string, unknown>) => jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });

describe('roles por empresa', () => {
  const token = firmar({
    sub: 'u1',
    roles: ['admin', 'solo-lectura'],
    companies: ['A', 'B'],
    rolesPorEmpresa: { A: ['admin'], B: ['solo-lectura'] },
  });

  it('admin en A puede escribir en A', async () => {
    const { req } = await autenticar(token);
    req.companyId = 'A';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toBeUndefined();
  });

  it('solo-lectura en B NO puede escribir en B aunque sea admin en A', async () => {
    const { req } = await autenticar(token);
    req.companyId = 'B';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toMatchObject({ statusCode: 403 });
    expect(ejecutar(authorize('contabilidad:read') as never, req)).toBeUndefined();
  });

  it('cuentan los roles de la BD, no los que dice el token', async () => {
    // Token antiguo que dice "contable en B": en la BD es solo lectura.
    const { req } = await autenticar(firmar({ sub: 'u1', roles: ['contable'], companies: ['B'], rolesPorEmpresa: { B: ['contable'] } }));
    req.companyId = 'B';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toMatchObject({ statusCode: 403 });
  });

  it('rolesPorEmpresaDe agrupa las membresias', () => {
    expect(
      rolesPorEmpresaDe([
        { companyId: 'A', role: 'admin' },
        { companyId: 'B', role: 'solo-lectura' },
        { companyId: 'B', role: 'ventas' },
      ]),
    ).toEqual({ A: ['admin'], B: ['solo-lectura', 'ventas'] });
  });
});

describe('tipo de token', () => {
  it('rechaza un refresh token usado como token de acceso', async () => {
    const { error } = await autenticar(firmar({ sub: 'u1', type: 'refresh', jti: 'x' }));
    expect(error).toMatchObject({ statusCode: 401 });
  });

  it('rechaza tokens firmados con otro algoritmo', async () => {
    const hs512 = jwt.sign({ sub: 'u1', roles: [] }, config.jwtSecret, { algorithm: 'HS512' });
    expect((await autenticar(hs512)).error).toMatchObject({ statusCode: 401 });
  });
});
