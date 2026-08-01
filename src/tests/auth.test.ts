// Mockeamos la BD (Prisma) para no depender de MySQL en los tests unitarios.
// revokedToken se respalda con un Map en memoria para simular persistencia entre llamadas.
jest.mock('../config/database', () => {
  const revokedStore = new Map<string, { jti: string; userId: string; expiresAt: Date }>();
  return {
    prisma: {
      user: { findUnique: jest.fn() },
      revokedToken: {
        findUnique: jest.fn(({ where: { jti } }) => Promise.resolve(revokedStore.get(jti) ?? null)),
        create: jest.fn(({ data }) => {
          revokedStore.set(data.jti, data);
          return Promise.resolve(data);
        }),
        upsert: jest.fn(({ where: { jti }, create }) => {
          revokedStore.set(jti, create);
          return Promise.resolve(create);
        }),
        deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
    },
    connectDatabase: jest.fn(),
    disconnectDatabase: jest.fn(),
  };
});

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../app';
import { config } from '../config/env';
import { prisma } from '../config/database';
import { hashPassword } from '../utils/password';
import { authService } from '../services/auth.service';

const findUnique = prisma.user.findUnique as jest.Mock;

const demoUser = {
  id: 'u1',
  email: 'demo@empresa.com',
  passwordHash: hashPassword('demo1234'),
  isActive: true,
  isGlobalAdmin: false,
  memberships: [{ companyId: '1', role: 'admin', company: { id: '1', codigo: 'DEMO', name: 'Empresa Demo' } }],
};

beforeEach(() => {
  findUnique.mockReset();
});

describe('Auth / healthchecks', () => {
  it('GET /auth/health responde 200', async () => {
    const res = await request(app).get('/auth/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /health (global) responde 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('Auth / login (BD via Prisma)', () => {
  it('login valido devuelve JWT con companies del usuario', async () => {
    findUnique.mockResolvedValue(demoUser);

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'demo@empresa.com', password: 'demo1234' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.companies).toContain('1');

    const payload = jwt.verify(res.body.data.token, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.companies).toContain('1');
    expect(payload.roles).toContain('admin');
  });

  it('password incorrecta responde 401', async () => {
    findUnique.mockResolvedValue(demoUser);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'demo@empresa.com', password: 'mala' });
    expect(res.status).toBe(401);
  });

  it('usuario inexistente responde 401', async () => {
    findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'nadie@empresa.com', password: 'x' });
    expect(res.status).toBe(401);
  });

  it('email invalido responde 400 (validacion)', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'no-es-email', password: 'x' });
    expect(res.status).toBe(400);
  });
});

// Tests de la logica de rotacion/revocacion contra authService directamente (sin pasar
// por HTTP): evita consumir el rate limit de /auth, compartido por login+refresh+logout
// dentro de este mismo archivo de test.
describe('authService.refresh/logout — rotacion y revocacion por jti', () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(demoUser);
  });

  it('login emite un refreshToken con jti unico', async () => {
    const result = await authService.login({ email: 'demo@empresa.com', password: 'demo1234' });
    const payload = jwt.verify(result.refreshToken, config.jwtSecret) as jwt.JwtPayload;
    expect(payload.type).toBe('refresh');
    expect(typeof payload.jti).toBe('string');
  });

  it('refresh rota el token (nuevo jti) y reusar el antiguo es rechazado', async () => {
    const login = await authService.login({ email: 'demo@empresa.com', password: 'demo1234' });
    const refreshed = await authService.refresh(login.refreshToken);

    const oldPayload = jwt.verify(login.refreshToken, config.jwtSecret) as jwt.JwtPayload;
    const newPayload = jwt.verify(refreshed.refreshToken, config.jwtSecret) as jwt.JwtPayload;
    expect(newPayload.jti).not.toBe(oldPayload.jti);

    // Reusar el refresh original (ya rotado/consumido) = posible robo: debe rechazarse.
    await expect(authService.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('logout revoca el refresh token: un refresh posterior es rechazado', async () => {
    const login = await authService.login({ email: 'demo@empresa.com', password: 'demo1234' });
    await authService.logout(login.refreshToken);
    await expect(authService.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('Auth / refresh y logout — wiring de rutas HTTP', () => {
  it('POST /auth/refresh y /auth/logout responden correctamente', async () => {
    findUnique.mockResolvedValue(demoUser);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'demo@empresa.com', password: 'demo1234' });

    const refresh = await request(app)
      .post('/auth/refresh')
      .send({ refreshToken: login.body.data.refreshToken });
    expect(refresh.status).toBe(200);
    expect(refresh.body.data.refreshToken).not.toBe(login.body.data.refreshToken);

    const logout = await request(app)
      .post('/auth/logout')
      .send({ refreshToken: refresh.body.data.refreshToken });
    expect(logout.status).toBe(200);
  });
});
