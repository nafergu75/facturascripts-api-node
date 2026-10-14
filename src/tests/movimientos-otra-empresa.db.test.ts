// PATCH y DELETE de un movimiento manual no tocan nunca los de otra empresa.
//
// Regresion: el controlador hacia prisma.movement.update/delete con where: { id },
// sin mirar la empresa. companyScope y authorize solo miran la de la URL: con
// contabilidad:write en la empresa A se podia cambiar o borrar un movimiento de
// la B conociendo su id. Desde lector-editable (13-10-2026) cambiar y borrar
// estan retirados (410 MOVIMIENTOS_RETIRADOS, ver movimientos-retirados.db.test.ts):
// ni los de otra empresa ni los propios se tocan.
// Autenticacion y permisos reales (BD).
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const EMPRESA_A = `mov-a-${SUFIJO}`;
const EMPRESA_B = `mov-b-${SUFIJO}`;
const EMAIL = `mov-${SUFIJO}@test.local`;
let token = '';

const movimiento = (companyId: string, description: string) =>
  prisma.movement.create({
    data: { companyId, type: 'income', amount: 100, category: 'Ventas', description, date: new Date('2026-05-01T00:00:00Z'), fiscalYear: 2026, status: 'approved' },
  });

describeBd('movimientos manuales de otra empresa (permisos reales)', () => {
  beforeAll(async () => {
    for (const id of [EMPRESA_A, EMPRESA_B]) {
      await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    }
    // Puede todo en A; en B no es miembro.
    const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
    await prisma.membership.create({ data: { userId: u.id, companyId: EMPRESA_A, role: 'admin' } });
    token = authService.generateToken({ userId: u.id, email: EMAIL, roles: [], companies: [] });
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { companyId: { in: [EMPRESA_A, EMPRESA_B] } } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.company.deleteMany({ where: { id: { in: [EMPRESA_A, EMPRESA_B] } } });
  });

  it('PATCH /companies/A/movements/:id con un movimiento de B da 410 y no lo cambia', async () => {
    const deB = await movimiento(EMPRESA_B, 'De la empresa B');
    const res = await request(app)
      .patch(`/companies/${EMPRESA_A}/movements/${deB.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Cambiado desde A', amount: 1 });

    expect(res.status).toBe(410);
    expect(res.body.details).toMatchObject({ codigo: 'MOVIMIENTOS_RETIRADOS' });
    const tras = await prisma.movement.findUnique({ where: { id: deB.id } });
    expect(tras).toMatchObject({ companyId: EMPRESA_B, description: 'De la empresa B' });
    expect(Number(tras?.amount)).toBe(100);
  });

  it('DELETE /companies/A/movements/:id con un movimiento de B da 410 y no lo borra', async () => {
    const deB = await movimiento(EMPRESA_B, 'De la empresa B');
    const res = await request(app).delete(`/companies/${EMPRESA_A}/movements/${deB.id}`).set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(410);
    expect(await prisma.movement.findUnique({ where: { id: deB.id } })).not.toBeNull();
  });

  it('los de su propia empresa tampoco se cambian ni se borran (retirado)', async () => {
    const deA = await movimiento(EMPRESA_A, 'De la empresa A');
    const cambio = await request(app)
      .patch(`/companies/${EMPRESA_A}/movements/${deA.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ description: 'Cambiado' });
    expect(cambio.status).toBe(410);
    expect((await prisma.movement.findUnique({ where: { id: deA.id } }))?.description).toBe('De la empresa A');

    const borrado = await request(app).delete(`/companies/${EMPRESA_A}/movements/${deA.id}`).set('Authorization', `Bearer ${token}`);
    expect(borrado.status).toBe(410);
    expect(await prisma.movement.findUnique({ where: { id: deA.id } })).not.toBeNull();
  });
});
