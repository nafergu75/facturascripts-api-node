/**
 * «Nuevo movimiento» retirado (decisión del usuario, 13-10-2026): crear,
 * cambiar y borrar movimientos a mano da 410 MOVIMIENTOS_RETIRADOS, sin tocar
 * la tabla; las rutas siguen pidiendo su permiso (403 sin él) y el GET sigue
 * listando los movimientos anotados antes.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import movementsRoutes from '../routes/movements.routes';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `mov-retirados-${SUF}`;
const OTRA = `mov-retirados-otra-${SUF}`;

function app(permisos: string[], empresa = E) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-mov', email: 'u@test.local', roles: ['x'], companies: [empresa], rolesPorEmpresa: { [empresa]: ['x'] }, permisosPorEmpresa: { [empresa]: permisos } } as never;
    req.companyId = empresa;
    next();
  });
  a.use('/movements', movementsRoutes);
  a.use(errorMiddleware);
  return a;
}

const ESCRIBE = ['contabilidad:read', 'contabilidad:write'];
let propio = '';
let ajeno = '';

beforeAll(async () => {
  for (const id of [E, OTRA]) await prisma.company.create({ data: { id, name: `Movimientos ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  const base = { type: 'income', amount: 100, category: 'Ventas', description: 'Anotado a mano', date: new Date('2026-02-01T00:00:00Z'), fiscalYear: 2026, status: 'approved' };
  propio = (await prisma.movement.create({ data: { ...base, companyId: E } })).id;
  ajeno = (await prisma.movement.create({ data: { ...base, companyId: OTRA } })).id;
});

describe('movimientos a mano retirados', () => {
  it('POST, PATCH y DELETE: 410 MOVIMIENTOS_RETIRADOS y la tabla no cambia', async () => {
    const antes = await prisma.movement.count({ where: { companyId: { in: [E, OTRA] } } });
    const crear = await request(app(ESCRIBE)).post('/movements').send({ type: 'expense', amount: 50, category: 'Otros', description: 'x', date: '2026-03-01' });
    expect(crear.status).toBe(410);
    expect(crear.body).toMatchObject({ message: 'Los movimientos ya no se anotan ni se cambian a mano: registra la factura de venta o de gasto.', details: { codigo: 'MOVIMIENTOS_RETIRADOS' } });
    for (const id of [propio, ajeno]) {
      const cambiar = await request(app(ESCRIBE)).patch(`/movements/${id}`).send({ amount: 1 });
      expect(cambiar.status).toBe(410);
      expect(cambiar.body.details.codigo).toBe('MOVIMIENTOS_RETIRADOS');
      const borrar = await request(app(ESCRIBE)).delete(`/movements/${id}`);
      expect(borrar.status).toBe(410);
    }
    expect(await prisma.movement.count({ where: { companyId: { in: [E, OTRA] } } })).toBe(antes);
    expect((await prisma.movement.findUniqueOrThrow({ where: { id: ajeno } })).description).toBe('Anotado a mano');
  });

  it('sin permiso de escritura, 403 como antes', async () => {
    expect((await request(app(['contabilidad:read'])).post('/movements').send({})).status).toBe(403);
    expect((await request(app(['contabilidad:read'])).delete(`/movements/${propio}`)).status).toBe(403);
  });

  it('el GET sigue listando los movimientos anotados antes', async () => {
    const r = await request(app(['contabilidad:read'])).get('/movements');
    expect(r.status).toBe(200);
    expect((r.body.data as Array<{ id: string }>).map((m) => m.id)).toEqual([propio]);
  });
});
