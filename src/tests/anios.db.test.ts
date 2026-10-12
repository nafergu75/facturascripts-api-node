/**
 * Regla común de años (spec arranque-2027, A.2): GET /companies/:id/anios para
 * cualquier miembro de la empresa, validarEjercicio y la lista de años.
 * Autenticación y permisos reales (BD). Reloj falso solo para Date.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { aniosEmpresa, aniosSeleccionables, rangoAnios, validarEjercicio } from '../utils/anios';
import { relojEn, relojReal } from './reloj-falso';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const CON_DATOS = `anios-a-${SUFIJO}`;
const VACIA = `anios-b-${SUFIJO}`;
const AJENA = `anios-c-${SUFIJO}`;
const GESTORIA = `anios-d-${SUFIJO}`;
const EMAIL = `anios-${SUFIJO}@test.local`;
let userId = '';
/** Token firmado con el reloj del momento (con el reloj falso, caduca respecto a él). */
const token = () => authService.generateToken({ userId, email: EMAIL, roles: [], companies: [] });

beforeAll(async () => {
  for (const id of [CON_DATOS, VACIA, AJENA, GESTORIA]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  // Datos de 2023 (asiento), 2024 (ejercicio) y 2025 (banco).
  await prisma.fiscalYear.create({ data: { companyId: CON_DATOS, label: '2024', fechaInicio: '2024-01-01', fechaFin: '2024-12-31', estado: 'CLOSED' } });
  await prisma.journalEntry.create({
    data: { companyId: CON_DATOS, fecha: new Date('2023-06-30T00:00:00Z'), numeroAsiento: `A-${SUFIJO}`, descripcion: 'Prueba', origen: 'AJUSTE_MANUAL' },
  });
  const cuenta = await prisma.bankAccount.create({ data: { companyId: CON_DATOS, iban: 'ES9121000418450200051332', subcuentaCodigo: '572000001' } });
  await prisma.bankMovement.create({
    data: { companyId: CON_DATOS, cuentaBancariaId: cuenta.id, fecha: '2025-03-15', importe: 10, concepto: 'Prueba', origen: 'csv' },
  });
  // 2026 lo llevó la gestoría (Traer la contabilidad de 2026) y tiene datos de la carga.
  await prisma.fiscalYear.create({
    data: { companyId: GESTORIA, label: '2026', fechaInicio: '2026-01-01', fechaFin: '2026-12-31', estado: 'OPEN', llevanza: 'EXTERNA' },
  });
  // Solo ve Nóminas en las dos primeras; en la tercera no es miembro.
  const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
  for (const companyId of [CON_DATOS, VACIA, GESTORIA]) {
    await prisma.membership.create({ data: { userId: u.id, companyId, role: 'solo_lectura', permisosPersonalizados: ['nominas:read'] } });
  }
  userId = u.id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.bankMovement.deleteMany({ where: { companyId: CON_DATOS } });
  await prisma.bankAccount.deleteMany({ where: { companyId: CON_DATOS } });
  await prisma.journalEntry.deleteMany({ where: { companyId: CON_DATOS } });
  await prisma.fiscalYear.deleteMany({ where: { companyId: { in: [CON_DATOS, VACIA, GESTORIA] } } });
  await prisma.company.deleteMany({ where: { id: { in: [CON_DATOS, VACIA, AJENA, GESTORIA] } } });
});

afterEach(relojReal);

describe('GET /companies/:id/anios', () => {
  it('cualquier miembro lo ve, aunque solo tenga Nóminas (no pide contabilidad:read)', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const res = await request(app).get(`/companies/${CON_DATOS}/anios`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      primero: 2023,
      actual: 2026,
      conDatos: [2025, 2024, 2023],
      ejercicios: [{ anio: 2024, estado: 'CERRADO_SIN_ASIENTOS' }],
      primeroEnApp: 2023,
      aniosGestoria: [],
    });
    // La lista de ejercicios sí pide contabilidad:read.
    const fys = await request(app).get(`/companies/${CON_DATOS}/fiscal-years`).set('Authorization', `Bearer ${token()}`);
    expect(fys.status).toBe(403);
  });

  it('fuera de la empresa, 403', async () => {
    const res = await request(app).get(`/companies/${AJENA}/anios`).set('Authorization', `Bearer ${token()}`);
    expect(res.status).toBe(403);
  });

  it('empresa sin nada: primero = actual', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const res = await request(app).get(`/companies/${VACIA}/anios`).set('Authorization', `Bearer ${token()}`);
    expect(res.body.data).toEqual({ primero: 2026, actual: 2026, conDatos: [], ejercicios: [], primeroEnApp: 2026, aniosGestoria: [] });
  });

  it('con 2026 de la gestoría, el primer año en la app es 2027 (el que abren el 303 y el Estado fiscal)', async () => {
    relojEn('2027-01-18T10:00:00Z');
    const res = await request(app).get(`/companies/${GESTORIA}/anios`).set('Authorization', `Bearer ${token()}`);
    expect(res.body.data).toMatchObject({ primero: 2026, actual: 2027, primeroEnApp: 2027, aniosGestoria: [2026] });
  });

  it('a las 00:30 del 1-1-2027 en Madrid el año actual ya es 2027', async () => {
    relojEn('2026-12-31T23:30:00Z');
    const res = await request(app).get(`/companies/${VACIA}/anios`).set('Authorization', `Bearer ${token()}`);
    expect(res.body.data).toMatchObject({ primero: 2027, actual: 2027 });
  });
});

describe('aniosSeleccionables', () => {
  it('filtros: de primero a actual + 1 con los años con datos, de mayor a menor', async () => {
    const ahora = new Date('2027-01-02T09:00:00Z');
    expect(await aniosSeleccionables(CON_DATOS, { ahora })).toEqual([2028, 2027, 2026, 2025, 2024, 2023]);
    expect(await aniosSeleccionables(CON_DATOS, { ahora, extra: 0 })).toEqual([2027, 2026, 2025, 2024, 2023]);
  });

  it('una empresa que arranca en 2027 ve [2028, 2027] y [2027] en los modelos', async () => {
    const ahora = new Date('2027-01-02T09:00:00Z');
    expect(await aniosSeleccionables(VACIA, { ahora })).toEqual([2028, 2027]);
    expect(await aniosSeleccionables(VACIA, { ahora, extra: 0 })).toEqual([2027]);
    expect((await aniosEmpresa(VACIA, ahora)).primero).toBe(2027);
  });

  it('rangoAnios une los años fuera del rango', () => {
    expect(rangoAnios(2025, 2027, [2020, 2026])).toEqual([2027, 2026, 2025, 2020]);
  });
});

describe('validarEjercicio', () => {
  const ahora = new Date('2026-10-12T10:00:00Z');

  it('de 1990 al año siguiente por defecto', () => {
    expect(validarEjercicio('2027', { ahora })).toBe(2027);
    expect(validarEjercicio(1990, { ahora })).toBe(1990);
    expect(() => validarEjercicio('2028', { ahora })).toThrow(/entre 1990 y 2027/);
    expect(() => validarEjercicio('1989', { ahora })).toThrow(/entre 1990 y 2027/);
  });

  it('hasta el actual cuando se pide', () => {
    expect(() => validarEjercicio('2027', { ahora, hasta: 'actual' })).toThrow(/entre 1990 y 2026/);
  });

  it('rechaza lo que no es un año de cuatro cifras (20270, 2026.5, vacío)', () => {
    for (const v of ['20270', '2026.5', '', undefined, null, 'abc', ' ']) {
      expect(() => validarEjercicio(v, { ahora })).toThrow(/cuatro cifras/);
    }
  });

  it('el máximo sale de la hora de España', () => {
    expect(validarEjercicio('2028', { ahora: new Date('2026-12-31T23:30:00Z') })).toBe(2028);
  });
});
