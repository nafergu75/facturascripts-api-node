/**
 * Arranque de 2027 (spec arranque-2027):
 *  - B.8: fecha de inicio en la app por empresa (los periodos de antes no se
 *    crean ni cuentan como pendientes) y «presentado fuera de la app», de un
 *    modelo o de todo un ejercicio.
 *  - B.7: régimen fiscal por fecha de efecto. Guardar los ajustes en 2027 ya no
 *    cambia el calendario de 2026 (antes se deducía de updatedAt).
 * Autenticación y permisos reales. Reloj falso solo para Date: el token se
 * firma con el mismo reloj que la petición.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { relojEn, relojReal } from './reloj-falso';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const NUEVA = `iap-a-${SUFIJO}`; // arranca en la app el 1-1-2027
const FUERA = `iap-b-${SUFIJO}`; // marca lo de 2026 como presentado fuera
const REGIMEN = `iap-c-${SUFIJO}`; // pasa al SII desde octubre de 2026
const ANTIGUA = `iap-d-${SUFIJO}`; // guardó sus ajustes antes de existir las vigencias
const TODAS = [NUEVA, FUERA, REGIMEN, ANTIGUA];
const EMAIL = `iap-${SUFIJO}@test.local`;
let userId = '';

const token = () => authService.generateToken({ userId, email: EMAIL, roles: [], companies: [] });
const get = (empresa: string, ruta: string) => request(app).get(`/companies/${empresa}${ruta}`).set('Authorization', `Bearer ${token()}`);
const post = (empresa: string, ruta: string, body: object = {}) =>
  request(app).post(`/companies/${empresa}${ruta}`).set('Authorization', `Bearer ${token()}`).send(body);
const put = (empresa: string, ruta: string, body: object) => request(app).put(`/companies/${empresa}${ruta}`).set('Authorization', `Bearer ${token()}`).send(body);
const modelos = async (empresa: string, ejercicio: number, tab = 'activos') =>
  (await get(empresa, `/impuestos/modelos?ejercicio=${ejercicio}&tab=${tab}`)).body.data as Array<{ id: string; codigo: string; periodo: string; estado: string; origen?: string }>;
const periodos303 = async (empresa: string, ejercicio: number) =>
  (await prisma.modeloImpuesto.findMany({ where: { companyId: empresa, codigo: '303', ejercicio } })).map((f) => f.periodo).sort();

beforeAll(async () => {
  for (const id of TODAS) await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
  userId = u.id;
  for (const companyId of TODAS) await prisma.membership.create({ data: { userId, companyId, role: 'admin' } });
});

afterAll(async () => {
  relojReal();
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.modeloImpuesto.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.ajustesFiscalesVigencia.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.ajustesFiscales.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.auditLog.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.company.deleteMany({ where: { id: { in: TODAS } } });
});

afterEach(relojReal);

describe('fecha de inicio en la app (B.8)', () => {
  it('se guarda en Configuración > Impuestos y se lee en el GET', async () => {
    relojEn('2026-11-02T10:00:00Z');
    const r = await put(NUEVA, '/ajustes-fiscales', { inicioEnApp: '2027-01-01' });
    expect(r.status).toBe(200);
    expect(r.body.data.inicioEnApp).toBe('2027-01-01');
    expect((await get(NUEVA, '/ajustes-fiscales')).body.data.inicioEnApp).toBe('2027-01-01');
  });

  it('una fecha que no existe o fuera de rango: 400 con el campo', async () => {
    relojEn('2026-11-02T10:00:00Z');
    for (const inicioEnApp of ['2027-02-30', '01/01/2027', '2028-01-01', '1989-12-31']) {
      const r = await put(NUEVA, '/ajustes-fiscales', { inicioEnApp });
      expect([inicioEnApp, r.status, r.body.error?.details ?? r.body.details]).toEqual([inicioEnApp, 400, { campo: 'inicioEnApp' }]);
    }
  });

  it('el 2-1-2027, los modelos de 2026 no se crean ni salen como pendientes; los de 2027, sí', async () => {
    relojEn('2027-01-02T10:00:00Z');
    expect(await modelos(NUEVA, 2026)).toEqual([]);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: NUEVA, ejercicio: 2026 } })).toBe(0);
    const de2027 = await modelos(NUEVA, 2027);
    expect(de2027.some((m) => m.codigo === '303' && m.periodo === '1T')).toBe(true);
  });

  it('las filas de antes que ya existían dejan de contar como pendientes (sin borrarlas)', async () => {
    relojEn('2027-01-02T10:00:00Z');
    await prisma.modeloImpuesto.create({ data: { companyId: NUEVA, codigo: '303', ejercicio: 2026, periodo: '4T' } });
    expect(await modelos(NUEVA, 2026)).toEqual([]);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: NUEVA, ejercicio: 2026 } })).toBe(1);
    // Se puede quitar la fecha: vuelven a contar.
    await put(NUEVA, '/ajustes-fiscales', { inicioEnApp: null });
    expect((await modelos(NUEVA, 2026)).length).toBeGreaterThan(10);
  });
});

describe('presentado fuera de la app (B.8)', () => {
  it('un modelo: sale de pendientes, 409 si se repite y «no presentado» lo deshace', async () => {
    relojEn('2026-11-02T10:00:00Z');
    const id = 'cal-303-2026-1T';
    const r = await post(FUERA, `/impuestos/modelos/${id}/presentado-fuera-app`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ codigo: '303', periodo: '1T', estado: 'presentado', origen: 'fuera-app' });
    expect((await post(FUERA, `/impuestos/modelos/${r.body.data.id}/presentado-fuera-app`)).status).toBe(409);
    expect((await modelos(FUERA, 2026, 'presentados')).map((m) => `${m.codigo}:${m.periodo}`)).toEqual(['303:1T']);
    const deshecho = await post(FUERA, `/impuestos/modelos/${r.body.data.id}/no-presentado`);
    expect(deshecho.status).toBe(200);
    expect(deshecho.body.data.estado).toBe('expirado');
    expect(deshecho.body.data.origen).toBeUndefined();
    const rastro = await prisma.auditLog.findMany({ where: { companyId: FUERA, action: { in: ['MODELO_PRESENTADO_FUERA_APP', 'MODELO_NO_PRESENTADO_FUERA_APP'] } } });
    expect(rastro).toHaveLength(2);
  });

  it('todo el ejercicio: el 2-1-2027 marca lo terminado de 2026 y no toca lo omitido', async () => {
    relojEn('2027-01-02T10:00:00Z');
    const clave349 = { companyId: FUERA, codigo: '349', ejercicio: 2026, periodo: '2T' };
    const omitido = await prisma.modeloImpuesto.upsert({
      where: { companyId_codigo_ejercicio_periodo: clave349 },
      create: { ...clave349, estado: 'omitido' },
      update: { estado: 'omitido' },
    });
    const r = await post(FUERA, '/impuestos/ejercicios/2026/presentado-fuera-app');
    expect(r.status).toBe(200);
    const marcados = (r.body.data.marcados as Array<{ codigo: string; periodo: string; origen: string }>).map((m) => `${m.codigo}:${m.periodo}`);
    expect(marcados).toEqual(expect.arrayContaining(['303:1T', '303:4T', '111:4T', '390:0A', '347:0A', '200:0A', '190:0A']));
    expect(marcados).not.toContain('349:2T');
    expect(await modelos(FUERA, 2026)).toEqual([]);
    expect((await prisma.modeloImpuesto.findUniqueOrThrow({ where: { id: omitido.id } })).estado).toBe('omitido');
    // Ejercicio por venir: 400.
    expect((await post(FUERA, '/impuestos/ejercicios/2028/presentado-fuera-app')).status).toBe(400);
  });

  it('en noviembre de 2026 solo marca lo ya terminado (el 4T y los anuales siguen pendientes)', async () => {
    relojEn('2026-11-02T10:00:00Z');
    const r = await post(REGIMEN, '/impuestos/ejercicios/2026/presentado-fuera-app');
    const marcados = (r.body.data.marcados as Array<{ codigo: string; periodo: string }>).map((m) => `${m.codigo}:${m.periodo}`);
    expect(marcados).toEqual(expect.arrayContaining(['303:1T', '303:3T']));
    expect(marcados).not.toContain('303:4T');
    expect(marcados).not.toContain('390:0A');
    // Se deshace para el siguiente bloque.
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: REGIMEN } });
  });
});

describe('régimen fiscal por fecha de efecto (B.7)', () => {
  it('el paso al SII mensual desde octubre de 2026 se apunta con su fecha de efecto', async () => {
    relojEn('2026-09-15T10:00:00Z');
    await modelos(REGIMEN, 2026); // el calendario de 2026 ya existe (trimestral)
    const r = await put(REGIMEN, '/ajustes-fiscales', { periodicidadIva: 'MENSUAL', sii: true });
    expect(r.status).toBe(200);
    const vigencias = await prisma.ajustesFiscalesVigencia.findMany({ where: { companyId: REGIMEN }, orderBy: { desde: 'asc' } });
    expect(vigencias.map((v) => [v.desde, v.periodicidadIva, v.sii])).toEqual([['2026-10-01', 'MENSUAL', true]]);
    expect(await periodos303(REGIMEN, 2026)).toEqual(['10', '11', '12', '1T', '2T', '3T']);
  });

  it('en 2027, guardar otra vez no cambia 2026, y 2027 sale entero mensual y sin 390 ni 347', async () => {
    relojEn('2027-01-05T10:00:00Z');
    // Antes: con updatedAt en 2027, 2026 pasaba a los ajustes por defecto.
    expect((await put(REGIMEN, '/ajustes-fiscales', { periodicidadIva: 'MENSUAL', sii: true, inicioEnApp: null })).status).toBe(200);
    await modelos(REGIMEN, 2026);
    expect(await periodos303(REGIMEN, 2026)).toEqual(['10', '11', '12', '1T', '2T', '3T']);
    const de2027 = await modelos(REGIMEN, 2027);
    expect(de2027.filter((m) => m.codigo === '303')).toHaveLength(12);
    expect(de2027.some((m) => m.codigo === '390' || m.codigo === '347')).toBe(false);
    // Un mes de 2026 que aún no tenía fila se abre por su id virtual.
    await prisma.modeloImpuesto.deleteMany({ where: { companyId: REGIMEN, codigo: '303', ejercicio: 2026, periodo: '11' } });
    expect((await get(REGIMEN, '/impuestos/modelos/cal-303-2026-11')).status).toBe(200);
  });

  it('una empresa que guardó sus ajustes en 2026, antes de las vigencias, conserva su calendario de 2026 al guardar en 2027', async () => {
    relojEn('2026-03-10T10:00:00Z');
    await prisma.ajustesFiscales.create({ data: { companyId: ANTIGUA, periodicidadIva: 'MENSUAL', sii: true } });
    relojEn('2027-01-05T10:00:00Z');
    // Solo cambia la fecha de inicio: el régimen de 2026 se apunta tal como estaba.
    expect((await put(ANTIGUA, '/ajustes-fiscales', { inicioEnApp: '2026-01-01' })).status).toBe(200);
    const vigencias = await prisma.ajustesFiscalesVigencia.findMany({ where: { companyId: ANTIGUA } });
    expect(vigencias.map((v) => [v.desde, v.periodicidadIva])).toEqual([['2026-01-01', 'MENSUAL']]);
    await modelos(ANTIGUA, 2026);
    expect((await periodos303(ANTIGUA, 2026)).length).toBe(12);
  });
});
