/**
 * Un único rango de ejercicio en todas las rutas (spec arranque-2027, A.2.2 y
 * B.14): de 1990 al año que viene, hora de España. Antes GET
 * /impuestos/modelos?ejercicio=20270 creaba un calendario absurdo y cada ruta
 * aceptaba un rango distinto.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { anioEspana } from '../utils/fechas';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const EMPRESA = `vej-${SUFIJO}`;
const EMAIL = `vej-${SUFIJO}@test.local`;
let token = '';

beforeAll(async () => {
  await prisma.company.create({ data: { id: EMPRESA, name: 'Validar Ejercicio SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
  await prisma.membership.create({ data: { userId: u.id, companyId: EMPRESA, role: 'admin' } });
  token = authService.generateToken({ userId: u.id, email: EMAIL, roles: [], companies: [] });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.modeloImpuesto.deleteMany({ where: { companyId: EMPRESA } });
  await prisma.periodo.deleteMany({ where: { companyId: EMPRESA } });
  await prisma.company.deleteMany({ where: { id: EMPRESA } });
});

const get = (ruta: string) => request(app).get(`/companies/${EMPRESA}${ruta}`).set('Authorization', `Bearer ${token}`);

describe('ejercicio fuera de rango: 400 con el mismo texto en todas las rutas', () => {
  const maximo = anioEspana() + 1;
  const RUTAS = [
    '/impuestos/modelos?ejercicio=',
    '/periodos?ejercicio=',
    '/compliance/alertas?ejercicio=',
    '/cuadre-bancos?ejercicio=',
    '/tax-models/349?ejercicio=',
    '/reports/income?year=',
    '/movements/stats/fiscal?anio=',
  ];

  it.each(RUTAS)('%s20270', async (ruta) => {
    const res = await get(`${ruta}20270`);
    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? res.body.message).toMatch(new RegExp(`entre 1990 y ${maximo}`));
  });

  it('GET /impuestos/modelos?ejercicio=20270 ya no crea filas', async () => {
    await get('/impuestos/modelos?ejercicio=20270');
    await get(`/periodos?ejercicio=${maximo + 1}`);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: EMPRESA } })).toBe(0);
    expect(await prisma.periodo.count({ where: { companyId: EMPRESA } })).toBe(0);
  });

  it('el año que viene sí vale', async () => {
    expect((await get(`/periodos?ejercicio=${maximo}`)).status).toBe(200);
  });
});
