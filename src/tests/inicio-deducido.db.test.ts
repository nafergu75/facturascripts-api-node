/**
 * Inicio en la app deducido (spec arranque-2027, B.8): si la empresa no indica
 * su fecha de inicio en Configuración > Impuestos, cuenta el primer día con
 * datos suyos en la app (ejercicio, factura, asiento, banco o nómina) y, si no
 * tiene nada, el día del alta. Así una empresa recién dada de alta no ve como
 * vencidos modelos de periodos en los que no estaba, y la que empieza en 2027
 * no recibe el calendario de 2026. Reloj falso solo para Date.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { listarModelosImpuesto, inicioImplicito, calendarioFiscalSoloLectura } from '../services/impuestosModulo.service';
import { obtenerAjustesFiscales } from '../services/ajustesFiscales.service';
import { inicioLlevanzaApp, primerDiaConDatos } from '../utils/anios';
import { relojEn, relojReal } from './reloj-falso';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const VACIA = `ided-a-${SUFIJO}`; // dada de alta el 12-10-2026, sin nada
const DE_2027 = `ided-b-${SUFIJO}`; // dada de alta el 12-10-2026, solo con el ejercicio 2027
const CON_FACTURA = `ided-c-${SUFIJO}`; // primer asiento el 10-5-2025
const INDICADA = `ided-d-${SUFIJO}`; // datos de 2025, pero indica inicio el 1-1-2024
const DE_MARZO = `ided-e-${SUFIJO}`; // primer asiento el 15-3-2027
const TODAS = [VACIA, DE_2027, CON_FACTURA, INDICADA, DE_MARZO];
const ALTA = new Date('2026-10-12T08:00:00Z');

const claves = (lista: Array<{ codigo: string; periodo: string }>) => lista.map((m) => `${m.codigo}:${m.periodo}`).sort();

beforeAll(async () => {
  for (const id of TODAS) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k', createdAt: ALTA } });
  }
  await prisma.fiscalYear.create({ data: { companyId: DE_2027, label: '2027', fechaInicio: '2027-01-01', fechaFin: '2027-12-31' } });
  for (const companyId of [CON_FACTURA, INDICADA]) {
    await prisma.journalEntry.create({
      data: { companyId, fecha: new Date('2025-05-10T00:00:00Z'), numeroAsiento: `A-${SUFIJO}`, descripcion: 'Primer gasto', origen: 'AJUSTE_MANUAL' },
    });
  }
  await prisma.journalEntry.create({
    data: { companyId: DE_MARZO, fecha: new Date('2027-03-15T00:00:00Z'), numeroAsiento: `A-${SUFIJO}`, descripcion: 'Primer gasto', origen: 'AJUSTE_MANUAL' },
  });
  await prisma.ajustesFiscales.create({ data: { companyId: INDICADA, inicioEnApp: '2024-01-01' } });
});

afterAll(async () => {
  relojReal();
  await prisma.journalEntry.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.modeloImpuesto.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.ajustesFiscales.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.fiscalYear.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.auditLog.deleteMany({ where: { companyId: { in: TODAS } } });
  await prisma.company.deleteMany({ where: { id: { in: TODAS } } });
});

afterEach(relojReal);

describe('primer día con datos e inicio deducido', () => {
  it('sale de los datos y, sin datos, del alta', async () => {
    expect(await primerDiaConDatos(VACIA)).toBeNull();
    expect(await inicioImplicito(VACIA)).toBe('2026-10-12');
    expect(await inicioImplicito(DE_2027)).toBe('2027-01-01');
    expect(await primerDiaConDatos(CON_FACTURA)).toBe('2025-05-10');
  });
});

describe('modelos con el inicio deducido', () => {
  it('una empresa dada de alta hoy no tiene modelos vencidos de este año', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const lista = await listarModelosImpuesto(VACIA, 2026);
    expect(lista.filter((m) => m.estado === 'expirado')).toEqual([]);
    expect(claves(lista)).toEqual(expect.arrayContaining(['303:4T', '111:4T', '390:0A']));
    expect(lista.some((m) => ['1T', '2T', '3T'].includes(m.periodo))).toBe(false);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: VACIA, periodo: { in: ['1T', '2T', '3T'] } } })).toBe(0);
  });

  it('Configuración > Impuestos enseña el inicio deducido y el calendario sin lo anterior', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const r = await obtenerAjustesFiscales(VACIA);
    expect(r.inicioEnApp).toBeNull();
    expect(r.inicioDeducido).toBe('2026-10-12');
    expect(r.calendario.modelos.filter((m) => m.estado === 'expirado')).toEqual([]);
    expect(r.calendario.modelos.some((m) => m.periodo === '1T')).toBe(false);
  });

  it('una empresa que empieza en 2027 no recibe nada de 2026, ni en el panel de Carmen', async () => {
    relojEn('2027-01-02T10:00:00Z');
    expect(await listarModelosImpuesto(DE_2027, 2026)).toEqual([]);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: DE_2027, ejercicio: 2026 } })).toBe(0);
    const carmen = await calendarioFiscalSoloLectura(DE_2027, '2027-01-02');
    expect(carmen.some((m) => m.ejercicio === 2026)).toBe(false);
    expect(claves(await listarModelosImpuesto(DE_2027, 2027))).toEqual(expect.arrayContaining(['303:1T', '111:1T']));
  });

  it('con un asiento de mayo de 2025, el 1T de 2025 no cuenta y el 2T sí', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const lista = await listarModelosImpuesto(CON_FACTURA, 2025);
    expect(lista.some((m) => m.codigo === '303' && m.periodo === '1T')).toBe(false);
    expect(lista.find((m) => m.codigo === '303' && m.periodo === '2T')).toMatchObject({ estado: 'expirado' });
  });

  it('la fecha indicada manda sobre la deducida', async () => {
    relojEn('2026-10-12T10:00:00Z');
    const lista = await listarModelosImpuesto(INDICADA, 2025);
    expect(lista.find((m) => m.codigo === '303' && m.periodo === '1T')).toMatchObject({ estado: 'expirado' });
    expect((await obtenerAjustesFiscales(INDICADA)).inicioDeducido).toBeNull();
  });
});

/**
 * Inicio de la llevanza en la app para los abonos (integracion-4): decide si el
 * 303 de la factura que rectifica se presentó fuera. Manda la fecha indicada;
 * si no hay, la deducida, pero nunca antes del 1-1-2027 (2026 se lleva fuera).
 */
describe('inicioLlevanzaApp', () => {
  it('la fecha indicada en Configuración > Impuestos manda, aunque sea anterior a 2027', async () => {
    expect(await inicioLlevanzaApp(INDICADA)).toBe('2024-01-01');
  });

  it('sin fecha indicada y con datos de 2025 o dada de alta en 2026, el 1-1-2027', async () => {
    expect(await inicioLlevanzaApp(CON_FACTURA)).toBe('2027-01-01');
    expect(await inicioLlevanzaApp(VACIA)).toBe('2027-01-01');
    expect(await inicioLlevanzaApp(DE_2027)).toBe('2027-01-01');
  });

  it('sin fecha indicada, si los datos empiezan después del 1-1-2027 cuenta ese día', async () => {
    expect(await inicioLlevanzaApp(DE_MARZO)).toBe('2027-03-15');
  });

  it('una empresa que no existe se queda con el 1-1-2027', async () => {
    expect(await inicioLlevanzaApp(`ided-nada-${SUFIJO}`)).toBe('2027-01-01');
  });
});
