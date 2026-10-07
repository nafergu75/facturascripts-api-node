// Contrasena provisional: el servidor obliga a cambiarla (prisma simulado).
//
// Cuando la contrasena la pone un administrador (alta o restablecimiento), el
// usuario solo puede ver GET /auth/me y usar POST /auth/cambiar-contrasena hasta
// que ponga una suya. Lo hace cumplir authMiddleware leyendo la BD, no la
// pantalla ni el token.
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
import { CODIGO_CAMBIO_CONTRASENA, authMiddleware, authMiddlewarePermitiendoProvisional } from '../middleware/auth.middleware';
import { authService, huellaContrasena } from '../services/auth.service';
import { validarContrasena } from '../services/admin.service';
import {
  caducidadContrasenaProvisional,
  contrasenaProvisionalCaducada,
  DIAS_CONTRASENA_PROVISIONAL,
  generarContrasenaProvisional,
  MENSAJE_PROVISIONAL_CADUCADA,
} from '../utils/password';
import type { AuthUser } from '../types/express';

const findUnique = prisma.user.findUnique as unknown as jest.Mock;
const HASH = 'sal:hash-actual';

function enBd(u: Record<string, unknown> | null) {
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
          memberships: ((u.memberships as Array<{ companyId: string; role: string }>) ?? []).map((m) => ({
            ...m,
            company: { id: m.companyId, codigo: null, name: m.companyId },
          })),
        },
  );
}

const token = (claims: Partial<Parameters<typeof authService.generateToken>[0]> = {}) =>
  authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: [], huellaContrasena: huellaContrasena(HASH), ...claims });

/** Pasa una peticion falsa por un middleware y devuelve lo que recibe next() y el req. */
function pasar(mw: typeof authMiddleware, t: string | null, user?: Partial<AuthUser>) {
  const headers: Record<string, string> = t ? { authorization: `Bearer ${t}` } : {};
  const req = { headers, header: (n: string) => headers[n.toLowerCase()], user } as unknown as { user?: AuthUser };
  return new Promise<{ error: unknown; req: { user?: AuthUser } }>((resolve) => mw(req as never, {} as never, ((e: unknown) => resolve({ error: e, req })) as never));
}

const ACCESO = [{ companyId: 'A', role: 'contable' }];

describe('bloqueo de la contrasena provisional en authMiddleware', () => {
  it('con el indicador en la BD: 403 con el codigo; la variante permitida deja pasar', async () => {
    enBd({ debeCambiarContrasena: true, memberships: ACCESO });
    const bloqueado = await pasar(authMiddleware, token());
    expect(bloqueado.error).toMatchObject({
      statusCode: 403,
      message: 'Antes de seguir tienes que poner una contraseña tuya.',
      details: { codigo: CODIGO_CAMBIO_CONTRASENA },
    });
    expect(CODIGO_CAMBIO_CONTRASENA).toBe('CAMBIO_CONTRASENA_OBLIGATORIO');

    const permitido = await pasar(authMiddlewarePermitiendoProvisional, token());
    expect(permitido.error).toBeUndefined();
    expect(permitido.req.user?.debeCambiarContrasena).toBe(true);
  });

  it('el atajo de una sesion ya verificada (authMiddleware repetido en linea) tambien corta', async () => {
    const r = await pasar(authMiddleware, null, { userId: 'u1', roles: [], companies: [], sesionVerificada: true, debeCambiarContrasena: true });
    expect(r.error).toMatchObject({ statusCode: 403, details: { codigo: CODIGO_CAMBIO_CONTRASENA } });
    const ok = await pasar(authMiddlewarePermitiendoProvisional, null, { userId: 'u1', roles: [], companies: [], sesionVerificada: true, debeCambiarContrasena: true });
    expect(ok.error).toBeUndefined();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('un token viejo (otra huella) o un usuario desactivado siguen dando 401, no 403', async () => {
    enBd({ debeCambiarContrasena: true, passwordHash: 'sal:hash-nuevo', memberships: ACCESO });
    expect((await pasar(authMiddleware, token())).error).toMatchObject({ statusCode: 401 });
    expect((await pasar(authMiddlewarePermitiendoProvisional, token())).error).toMatchObject({ statusCode: 401 });

    enBd({ debeCambiarContrasena: true, isActive: false, memberships: ACCESO });
    expect((await pasar(authMiddleware, token())).error).toMatchObject({ statusCode: 401 });
  });

  it('el bloqueo no depende de la huella: un token sin claim pwd tambien se para', async () => {
    enBd({ debeCambiarContrasena: true, memberships: ACCESO });
    const sinHuella = authService.generateToken({ userId: 'u1', email: 'u1@test.local', roles: [], companies: ['A'] });
    expect((await pasar(authMiddleware, sinHuella)).error).toMatchObject({ statusCode: 403, details: { codigo: CODIGO_CAMBIO_CONTRASENA } });
  });

  it('sin el campo en la BD (prisma simulado de siempre) no bloquea', async () => {
    enBd({ memberships: ACCESO });
    const r = await pasar(authMiddleware, token());
    expect(r.error).toBeUndefined();
    expect(r.req.user?.debeCambiarContrasena).toBe(false);
  });

  it('por HTTP: las rutas de empresa dan 403 con el codigo y /auth/me responde', async () => {
    enBd({ debeCambiarContrasena: true, memberships: ACCESO });
    const t = token();
    for (const ruta of ['/companies', '/companies/A', '/companies/A/clientes', '/admin/usuarios', '/users']) {
      const res = await request(app).get(ruta).set('Authorization', `Bearer ${t}`);
      expect(`${ruta} ${res.status} ${res.body?.details?.codigo}`).toBe(`${ruta} 403 ${CODIGO_CAMBIO_CONTRASENA}`);
    }
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${t}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ debeCambiarContrasena: true, personalizadoPorEmpresa: { A: false } });
  });
});

describe('caducidad de la contrasena provisional', () => {
  const AYER = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const MANANA = new Date(Date.now() + 24 * 60 * 60 * 1000);

  it('caduca solo si es provisional y la fecha ya paso; sin fecha no caduca', () => {
    expect(DIAS_CONTRASENA_PROVISIONAL).toBe(7);
    const ahora = new Date('2026-10-07T10:00:00Z');
    expect(caducidadContrasenaProvisional(ahora).toISOString()).toBe('2026-10-14T10:00:00.000Z');
    expect(contrasenaProvisionalCaducada({ debeCambiarContrasena: true, contrasenaProvisionalHasta: AYER })).toBe(true);
    expect(contrasenaProvisionalCaducada({ debeCambiarContrasena: true, contrasenaProvisionalHasta: MANANA })).toBe(false);
    expect(contrasenaProvisionalCaducada({ debeCambiarContrasena: true, contrasenaProvisionalHasta: null })).toBe(false);
    expect(contrasenaProvisionalCaducada({ debeCambiarContrasena: false, contrasenaProvisionalHasta: AYER })).toBe(false);
    expect(contrasenaProvisionalCaducada({})).toBe(false);
  });

  it('authMiddleware da 401 con la caducada, tambien en /auth/me; sin caducar sigue el 403', async () => {
    enBd({ debeCambiarContrasena: true, contrasenaProvisionalHasta: AYER, memberships: ACCESO });
    const caducada = { statusCode: 401, message: MENSAJE_PROVISIONAL_CADUCADA };
    expect((await pasar(authMiddleware, token())).error).toMatchObject(caducada);
    expect((await pasar(authMiddlewarePermitiendoProvisional, token())).error).toMatchObject(caducada);
    const me = await request(app).get('/auth/me').set('Authorization', `Bearer ${token()}`);
    expect(me.status).toBe(401);
    expect(me.body.message).toBe(MENSAJE_PROVISIONAL_CADUCADA);

    enBd({ debeCambiarContrasena: true, contrasenaProvisionalHasta: MANANA, memberships: ACCESO });
    expect((await pasar(authMiddleware, token())).error).toMatchObject({ statusCode: 403, details: { codigo: CODIGO_CAMBIO_CONTRASENA } });
    expect((await pasar(authMiddlewarePermitiendoProvisional, token())).error).toBeUndefined();
  });
});

describe('contrasena provisional generada por el servidor', () => {
  it('16 caracteres del alfabeto sin confusiones, valida y distinta cada vez', () => {
    const vistas = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generarContrasenaProvisional();
      expect(c).toMatch(/^[abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/);
      expect(validarContrasena(c, 'alguien@test.local')).toBe(c);
      vistas.add(c);
    }
    expect(vistas.size).toBe(200);
  });
});
