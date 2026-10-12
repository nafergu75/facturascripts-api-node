/**
 * El ejercicio del año en curso se crea solo al abrir la lista de ejercicios
 * (spec arranque-2027, A.2.4 y B.9), si la empresa ya lleva contabilidad en la
 * app. Reloj falso solo para Date: el 1-1-2027 a las 00:30 de Madrid.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { asegurarEjercicioEnCurso, fiscalYearsService } from '../services/fiscalYears.service';
import { relojEn, relojReal } from './reloj-falso';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const CON_EJERCICIO = `fyc-a-${SUFIJO}`;
const CON_ASIENTO = `fyc-b-${SUFIJO}`;
const VACIA = `fyc-c-${SUFIJO}`;
const SOLAPADA = `fyc-d-${SUFIJO}`;
const SOLO_POSTERIOR = `fyc-e-${SUFIJO}`;
const ASIENTO_POSTERIOR = `fyc-f-${SUFIJO}`;
const TODAS = [CON_EJERCICIO, CON_ASIENTO, VACIA, SOLAPADA, SOLO_POSTERIOR, ASIENTO_POSTERIOR];

beforeAll(async () => {
  for (const id of TODAS) await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.fiscalYear.create({ data: { companyId: CON_EJERCICIO, label: '2026', fechaInicio: '2026-01-01', fechaFin: '2026-12-31' } });
  await prisma.journalEntry.create({
    data: { companyId: CON_ASIENTO, fecha: new Date('2026-05-01T00:00:00Z'), numeroAsiento: `A-${SUFIJO}`, descripcion: 'Prueba', origen: 'AJUSTE_MANUAL' },
  });
  // Un ejercicio antiguo con otro nombre que ya cubre 2027.
  await prisma.fiscalYear.create({ data: { companyId: SOLAPADA, label: 'Ejercicio 2027', fechaInicio: '2027-01-01', fechaFin: '2027-12-31' } });
  // Empresa que empieza en 2027: solo tiene ese ejercicio (o un asiento de 2027).
  await prisma.fiscalYear.create({ data: { companyId: SOLO_POSTERIOR, label: '2027', fechaInicio: '2027-01-01', fechaFin: '2027-12-31' } });
  await prisma.journalEntry.create({
    data: { companyId: ASIENTO_POSTERIOR, fecha: new Date('2027-01-01T00:00:00Z'), numeroAsiento: `B-${SUFIJO}`, descripcion: 'Apertura', origen: 'AJUSTE_MANUAL' },
  });
});

afterAll(async () => {
  await prisma.journalEntry.deleteMany({ where: { companyId: { in: [CON_ASIENTO, ASIENTO_POSTERIOR] } } });
  await prisma.fiscalYear.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.auditLog.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.company.deleteMany({ where: { id: { in: TODAS } } });
});

afterEach(relojReal);

const labels = async (companyId: string) => (await prisma.fiscalYear.findMany({ where: { companyId }, orderBy: { label: 'asc' } })).map((f) => f.label);

describe('ejercicio del año en curso', () => {
  it('a las 00:30 del 1-1-2027 (Madrid) la lista ya trae el 2027, una sola vez y con su rastro', async () => {
    relojEn('2026-12-31T23:30:00Z');
    const [lista] = await Promise.all([fiscalYearsService.listar(CON_EJERCICIO, 'u-prueba'), fiscalYearsService.listar(CON_EJERCICIO, 'u-prueba')]);
    expect(lista[0]).toMatchObject({ label: '2027', fechaInicio: '2027-01-01', fechaFin: '2027-12-31', estado: 'OPEN', estadoEfectivo: 'ABIERTO' });
    expect(await labels(CON_EJERCICIO)).toEqual(['2026', '2027']);
    const rastro = await prisma.auditLog.findMany({ where: { companyId: CON_EJERCICIO, action: 'CREATE_FISCAL_YEAR_AUTO' } });
    expect(rastro).toHaveLength(1);
  });

  it('a las 23:30 del 31-12-2026 (Madrid) todavía no', async () => {
    relojEn('2026-12-31T22:30:00Z');
    expect(await asegurarEjercicioEnCurso(CON_ASIENTO)).toMatchObject({ label: '2026' });
    expect(await labels(CON_ASIENTO)).toEqual(['2026']);
  });

  it('con un asiento y sin ejercicios, también se crea', async () => {
    relojEn('2027-01-02T09:00:00Z');
    await fiscalYearsService.listar(CON_ASIENTO);
    expect(await labels(CON_ASIENTO)).toEqual(['2026', '2027']);
  });

  it('una empresa sin nada no recibe ejercicios que no ha pedido', async () => {
    relojEn('2027-01-02T09:00:00Z');
    expect(await fiscalYearsService.listar(VACIA)).toEqual([]);
  });

  it('si otro ejercicio ya cubre ese año, no se toca', async () => {
    relojEn('2027-01-02T09:00:00Z');
    expect(await asegurarEjercicioEnCurso(SOLAPADA)).toBeNull();
    expect(await labels(SOLAPADA)).toEqual(['Ejercicio 2027']);
  });

  it('una empresa que empieza en 2027 no recibe el ejercicio 2026 en noviembre de 2026', async () => {
    relojEn('2026-11-02T09:00:00Z');
    expect(await asegurarEjercicioEnCurso(SOLO_POSTERIOR)).toBeNull();
    expect((await fiscalYearsService.listar(SOLO_POSTERIOR, 'u-prueba')).map((f) => f.label)).toEqual(['2027']);
    expect(await asegurarEjercicioEnCurso(ASIENTO_POSTERIOR)).toBeNull();
    expect(await labels(ASIENTO_POSTERIOR)).toEqual([]);
  });

  it('y el 1-1-2027 tampoco crea nada: su ejercicio ya está', async () => {
    relojEn('2027-01-02T09:00:00Z');
    expect(await asegurarEjercicioEnCurso(SOLO_POSTERIOR)).toBeNull();
    expect(await labels(SOLO_POSTERIOR)).toEqual(['2027']);
  });
});
