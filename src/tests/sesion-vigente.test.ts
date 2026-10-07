// Lo que dice el token (dura 24 h) frente a lo que dice la BD ahora.
//
// Regresion: companyScope y authorize se fiaban de las empresas, los roles y el
// modo administrador guardados en el token. Quitar un acceso, desactivar a un
// usuario o quitarle el modo administrador no surtia efecto hasta que el token
// caducaba; dar un acceso nuevo no servia hasta volver a entrar; las rutas
// antiguas /users se saltaban las protecciones del panel, y restablecer la
// contrasena no echaba a quien ya hubiera entrado con ella.
jest.mock('../config/database', () => ({
  prisma: {
    user: { findUnique: jest.fn(), findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    company: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, name: `Empresa ${where.id}`, fsBaseUrl: '', isActive: true })),
    },
    revokedToken: {
      findUnique: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: { data: unknown }) => data),
    },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authMiddleware } from '../middleware/auth.middleware';
import { authService, huellaContrasena } from '../services/auth.service';

const findUnique = prisma.user.findUnique as unknown as jest.Mock;
const HASH = 'sal:hash-actual';

type Membresia = { companyId: string; role: string };

/** Como esta el usuario u1 en la BD; null = no existe. */
function enBd(u: { isActive?: boolean; isGlobalAdmin?: boolean; passwordHash?: string; memberships?: Membresia[] } | null) {
  findUnique.mockImplementation(async () =>
    u === null
      ? null
      : {
          id: 'u1',
          email: 'u1@test.local',
          createdAt: new Date('2026-01-01'),
          isActive: true,
          isGlobalAdmin: false,
          passwordHash: HASH,
          ...u,
          // refresh() lee tambien la empresa de cada acceso.
          memberships: (u.memberships ?? []).map((m) => ({ ...m, company: { id: m.companyId, codigo: null, name: m.companyId } })),
        },
  );
}

const token = (claims: Partial<Parameters<typeof authService.generateToken>[0]> = {}) =>
  authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: [], huellaContrasena: huellaContrasena(HASH), ...claims });

const como = (t: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${t}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${t}`).send(body),
  put: (ruta: string, body: object = {}) => request(app).put(ruta).set('Authorization', `Bearer ${t}`).send(body),
  delete: (ruta: string) => request(app).delete(ruta).set('Authorization', `Bearer ${t}`),
});

describe('accesos a empresas', () => {
  it('quitar el acceso surte efecto aunque el token todavia tenga la empresa', async () => {
    enBd({ memberships: [] });
    const t = token({ roles: ['contable'], companies: ['A'], rolesPorEmpresa: { A: ['contable'] } });
    expect((await como(t).get('/companies/A')).status).toBe(403);
    expect((await como(t).get('/companies/A/clientes')).status).toBe(403);
  });

  it('dar acceso a una empresa sirve en la siguiente peticion, sin volver a entrar', async () => {
    enBd({ memberships: [{ companyId: 'A', role: 'contable' }] });
    const res = await como(token()).get('/companies/A');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: 'A' });
  });
});

describe('usuario desactivado o borrado', () => {
  it('desactivado: 401 en la siguiente peticion', async () => {
    enBd({ isActive: false, memberships: [{ companyId: 'A', role: 'admin' }] });
    const res = await como(token({ companies: ['A'] })).get('/companies/A');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/desactivado/);
  });

  it('borrado: 401', async () => {
    enBd(null);
    expect((await como(token({ companies: ['A'] })).get('/companies/A')).status).toBe(401);
  });
});

describe('modo administrador global', () => {
  it('quitarlo cierra /users, /admin y el acceso a todas las empresas al momento', async () => {
    enBd({ isGlobalAdmin: false });
    const t = token({ esAdminGlobal: true });
    expect((await como(t).get('/users')).status).toBe(403);
    expect((await como(t).put('/users/u2', { isActive: true })).status).toBe(403);
    expect((await como(t).delete('/users/u2')).status).toBe(403);
    expect((await como(t).get('/admin/usuarios')).status).toBe(403);
    expect((await como(t).get('/companies/Z/clientes')).status).toBe(403);
  });

  it('darlo sirve en la siguiente peticion, sin volver a entrar', async () => {
    enBd({ isGlobalAdmin: true });
    expect((await como(token()).get('/users')).status).toBe(200);
  });
});

describe('/users aplica las mismas reglas que el panel', () => {
  beforeEach(() => enBd({ isGlobalAdmin: true }));
  const admin = () => como(token({ esAdminGlobal: true }));

  it('nadie se desactiva a si mismo', async () => {
    expect((await admin().put('/users/u1', { isActive: false })).status).toBe(400);
    expect((await admin().delete('/users/u1')).status).toBe(400);
  });

  it(`contrasena de al menos 12 caracteres, al crear y al cambiarla`, async () => {
    expect((await admin().put('/users/u2', { password: 'x' })).status).toBe(400);
    expect((await admin().post('/users', { email: 'nuevo@test.local', password: 'corta' })).status).toBe(400);
  });

  it('isActive tiene que ser true o false', async () => {
    expect((await admin().put('/users/u2', { isActive: 'no' })).status).toBe(400);
  });
});

describe('cambiar la contrasena cierra las sesiones abiertas', () => {
  it('un token emitido con la contrasena anterior deja de valer', async () => {
    enBd({ passwordHash: 'sal:hash-nuevo', memberships: [{ companyId: 'A', role: 'contable' }] });
    const res = await como(token({ companies: ['A'] })).get('/companies/A');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/contraseña/);
  });

  it('un token sin huella (de antes de este cambio) vale hasta que caduca', async () => {
    enBd({ memberships: [{ companyId: 'A', role: 'contable' }] });
    const sinHuella = authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: ['A'] });
    expect((await como(sinHuella).get('/companies/A')).status).toBe(200);
  });

  it('refresh rechaza un refresh token emitido con la contrasena anterior', async () => {
    const viejo = authService.signRefreshToken('u1', 'sal:hash-viejo');
    enBd({ passwordHash: 'sal:hash-nuevo' });
    await expect(authService.refresh(viejo)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refresh rechaza un refresh token sin huella', async () => {
    enBd({});
    await expect(authService.refresh(authService.signRefreshToken('u1'))).rejects.toMatchObject({ statusCode: 401 });
  });

  it('con la contrasena de siempre, refresh funciona y el token nuevo lleva la huella', async () => {
    enBd({ memberships: [{ companyId: 'A', role: 'contable' }] });
    const r = await authService.refresh(authService.signRefreshToken('u1', HASH));
    expect(r.user.companies).toEqual(['A']);
    expect((await como(r.token).get('/companies/A')).status).toBe(200);
  });
});

describe('authMiddleware repetido en la misma ruta', () => {
  it('no repite la consulta ni pisa los datos de la BD con los del token', async () => {
    enBd({ memberships: [{ companyId: 'A', role: 'contable' }] });
    const t = token({ companies: ['Z'], rolesPorEmpresa: { Z: ['admin'] } });
    const headers: Record<string, string> = { authorization: `Bearer ${t}` };
    const req = { headers, header: (n: string) => headers[n.toLowerCase()] } as unknown as { user?: { companies: string[] } };
    const pasar = () => new Promise<unknown>((resolve) => authMiddleware(req as never, {} as never, resolve as never));
    expect(await pasar()).toBeUndefined();
    expect(await pasar()).toBeUndefined();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(req.user?.companies).toEqual(['A']);
  });
});
