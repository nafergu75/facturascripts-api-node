// Permisos por empresa y tipo de token.
//
// Regresiones:
// - El token llevaba la UNION de roles de todas las empresas del usuario, y
//   authorize la aplicaba a cualquier empresa: admin en A + solo-lectura en B
//   daba permisos de admin en B.
// - Un refresh token (7 dias) se aceptaba como token de acceso.
jest.mock('../config/database', () => ({ prisma: {} }));

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

function autenticar(token: string): { req: Record<string, unknown>; error: unknown } {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const req: Record<string, unknown> = { headers, header: (n: string) => headers[n.toLowerCase()] };
  return { req, error: ejecutar(authMiddleware as never, req) };
}

const firmar = (payload: Record<string, unknown>) => jwt.sign(payload, config.jwtSecret, { expiresIn: '1h' });

describe('roles por empresa', () => {
  const token = firmar({
    sub: 'u1',
    roles: ['admin', 'solo-lectura'],
    companies: ['A', 'B'],
    rolesPorEmpresa: { A: ['admin'], B: ['solo-lectura'] },
  });

  it('admin en A puede escribir en A', () => {
    const { req } = autenticar(token);
    req.companyId = 'A';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toBeUndefined();
  });

  it('solo-lectura en B NO puede escribir en B aunque sea admin en A', () => {
    const { req } = autenticar(token);
    req.companyId = 'B';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toMatchObject({ statusCode: 403 });
    expect(ejecutar(authorize('contabilidad:read') as never, req)).toBeUndefined();
  });

  it('tokens antiguos sin rolesPorEmpresa siguen usando la lista de roles', () => {
    const { req } = autenticar(firmar({ sub: 'u1', roles: ['contable'], companies: ['A'] }));
    req.companyId = 'A';
    expect(ejecutar(authorize('contabilidad:write') as never, req)).toBeUndefined();
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
  it('rechaza un refresh token usado como token de acceso', () => {
    const { error } = autenticar(firmar({ sub: 'u1', type: 'refresh', jti: 'x' }));
    expect(error).toMatchObject({ statusCode: 401 });
  });

  it('rechaza tokens firmados con otro algoritmo', () => {
    const hs512 = jwt.sign({ sub: 'u1', roles: [] }, config.jwtSecret, { algorithm: 'HS512' });
    expect(autenticar(hs512).error).toMatchObject({ statusCode: 401 });
  });
});
