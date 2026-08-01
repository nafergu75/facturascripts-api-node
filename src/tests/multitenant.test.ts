import { authorize } from '../middleware/authorize.middleware';
import { companyScope } from '../middleware/companyScope.middleware';
import type { AuthUser } from '../types/express';

function correr(mw: ReturnType<typeof authorize> | typeof companyScope, user: AuthUser | undefined, params: Record<string, string> = {}) {
  const req = { user, params, query: {}, body: {} } as never;
  let err: { statusCode?: number } | undefined;
  const res = {} as never;
  const next = (e?: unknown) => { err = e as { statusCode?: number } | undefined; };
  (mw as (r: never, s: never, n: typeof next) => void)(req, res, next);
  return { req: req as { companyId?: string }, err };
}

const global: AuthUser = { userId: 'g', roles: [], companies: [], esAdminGlobal: true };
const adminEmpresa: AuthUser = { userId: 'a', roles: ['admin'], companies: ['1'], esAdminGlobal: false };
const contable: AuthUser = { userId: 'c', roles: ['contable'], companies: ['1'], esAdminGlobal: false };

describe('Multiempresa - authorize(admin:global)', () => {
  it('admin global pasa', () => {
    expect(correr(authorize('admin:global'), global).err).toBeUndefined();
  });
  it('admin de empresa (rol admin) NO pasa a admin:global', () => {
    expect(correr(authorize('admin:global'), adminEmpresa).err?.statusCode).toBe(403);
  });
  it('admin global pasa cualquier permiso normal', () => {
    expect(correr(authorize('contabilidad:write'), global).err).toBeUndefined();
  });
  it('contable no pasa ventas:write pero si contabilidad:read', () => {
    expect(correr(authorize('ventas:write'), contable).err?.statusCode).toBe(403);
    expect(correr(authorize('contabilidad:read'), contable).err).toBeUndefined();
  });
});

describe('Multiempresa - companyScope', () => {
  it('admin global accede a una empresa que NO esta en su token', () => {
    const { req, err } = correr(companyScope, global, { companyId: '99' });
    expect(err).toBeUndefined();
    expect(req.companyId).toBe('99');
  });
  it('usuario normal NO accede a empresa ajena', () => {
    expect(correr(companyScope, contable, { companyId: '99' }).err?.statusCode).toBe(403);
  });
  it('usuario normal accede a su empresa', () => {
    expect(correr(companyScope, contable, { companyId: '1' }).err).toBeUndefined();
  });
});
