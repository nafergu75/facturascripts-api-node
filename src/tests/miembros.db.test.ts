/**
 * GET /companies/:id/miembros (Configuración > Tu acceso y usuarios), sobre BD real.
 * Solo el administrador de la empresa (o el admin global) ve quién entra en
 * ella; nunca datos de otras empresas ni hashes.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import miembrosRoutes from '../routes/miembros.routes';
import { companyScope } from '../middleware/companyScope.middleware';
import { errorMiddleware } from '../middleware/error.middleware';
import { areasDePerfil, permisosDeAreas } from '../services/rbac.service';

const SUFIJO = Date.now();
const A = `miembros-a-${SUFIJO}`;
const B = `miembros-b-${SUFIJO}`;
/** Contable sin Compras ni Nominas (acceso a medida). */
const A_MEDIDA = { ventas: 'ninguno', compras: 'ninguno', contabilidad: 'modificar', tesoreria: 'ver', impuestos: 'modificar', nominas: 'ninguno' } as const;

/** Usuario con un rol en cada empresa indicada (como lo deja authMiddleware). */
function appCon(rolesPorEmpresa: Record<string, string[]>, esAdminGlobal = false) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      userId: 'u-test',
      roles: Object.values(rolesPorEmpresa).flat(),
      companies: Object.keys(rolesPorEmpresa),
      rolesPorEmpresa,
      esAdminGlobal,
    } as never;
    next();
  });
  const scoped = express.Router({ mergeParams: true });
  scoped.use(companyScope);
  scoped.use('/miembros', miembrosRoutes);
  app.use('/companies/:companyId', scoped);
  app.use(errorMiddleware);
  return app;
}

beforeAll(async () => {
  for (const id of [A, B]) await prisma.company.create({ data: { id, name: id, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  const alta = (email: string, isActive = true) => prisma.user.create({ data: { email, passwordHash: 'hash-secreto', isActive } });
  const ana = await alta(`ana-${SUFIJO}@ejemplo.es`);
  const beto = await alta(`beto-${SUFIJO}@ejemplo.es`, false);
  const carla = await alta(`carla-${SUFIJO}@ejemplo.es`);
  const dani = await alta(`dani-${SUFIJO}@ejemplo.es`);
  await prisma.membership.createMany({
    data: [
      { userId: ana.id, companyId: A, role: 'admin' },
      { userId: beto.id, companyId: A, role: 'solo_lectura' },
      { userId: carla.id, companyId: B, role: 'contable' },
      { userId: dani.id, companyId: B, role: 'contable', permisosPersonalizados: permisosDeAreas(A_MEDIDA) },
    ],
  });
});

describe('GET /miembros', () => {
  it('el administrador de la empresa ve solo a los de su empresa, sin hashes', async () => {
    const res = await request(appCon({ [A]: ['admin'] })).get(`/companies/${A}/miembros`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { userId: expect.any(String), nombre: null, email: `ana-${SUFIJO}@ejemplo.es`, rol: 'admin', activo: true, personalizado: false, areas: null },
      {
        userId: expect.any(String),
        nombre: null,
        email: `beto-${SUFIJO}@ejemplo.es`,
        rol: 'solo_lectura',
        activo: false,
        personalizado: false,
        areas: areasDePerfil('solo_lectura'),
      },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/hash-secreto|passwordHash/);
  });

  it('el contable recibe un 403', async () => {
    expect((await request(appCon({ [A]: ['contable'] })).get(`/companies/${A}/miembros`)).status).toBe(403);
  });

  it('el administrador de una empresa no ve los de otra (403)', async () => {
    expect((await request(appCon({ [A]: ['admin'] })).get(`/companies/${B}/miembros`)).status).toBe(403);
    // Admin en A y contable en B: en B manda su rol de B.
    expect((await request(appCon({ [A]: ['admin'], [B]: ['contable'] })).get(`/companies/${B}/miembros`)).status).toBe(403);
  });

  it('el admin global ve los de cualquier empresa', async () => {
    const res = await request(appCon({}, true)).get(`/companies/${B}/miembros`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { email: string }) => m.email)).toEqual([`carla-${SUFIJO}@ejemplo.es`, `dani-${SUFIJO}@ejemplo.es`]);
  });

  it('dice qué accesos son a medida y con qué áreas', async () => {
    const res = await request(appCon({}, true)).get(`/companies/${B}/miembros`);
    const porEmail = Object.fromEntries(res.body.data.map((m: { email: string }) => [m.email, m]));
    expect(porEmail[`carla-${SUFIJO}@ejemplo.es`]).toMatchObject({ rol: 'contable', personalizado: false, areas: areasDePerfil('contable') });
    expect(porEmail[`dani-${SUFIJO}@ejemplo.es`]).toMatchObject({ rol: 'contable', personalizado: true, areas: A_MEDIDA });
  });
});
