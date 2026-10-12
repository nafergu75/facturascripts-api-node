/**
 * 2026 llevado por la gestoria (FiscalYear.llevanza = EXTERNA): solo lectura.
 * Ningun asiento con fecha de 2026 (guarda comun y red de seguridad), el cierre
 * de 2026 da 409, y el diario historico (origen HISTORICO*) se clasifica por
 * su origen, no por su concepto.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { FILTRO_ASIENTOS_APERTURA, FILTRO_ASIENTOS_CIERRE } from '../domain/asientosCierre';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { crearAsientoConApuntes } from '../services/asientos.service';
import { previsualizarCierre } from '../services/cierreEjercicio.service';
import { tipoAsiento } from '../services/contabilidadDatos.service';
import { comprobarFechaAbierta, estadoCierreAnio, exigirFechaContabilizable, periodoNoAbierto } from '../services/periodos.service';
import { grabarAsientos } from '../services/puestaEnMarcha/asientosEnBloque';
import type { HttpError } from '../utils/http-errors';

const SUFIJO = Date.now();
const E = `llevanza-${SUFIJO}`;
const OTRA = `llevanza-app-${SUFIJO}`;

async function empresa(id: string, llevanza2026: 'APP' | 'EXTERNA') {
  await prisma.company.create({ data: { id, name: `Llevanza ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Llevanza ${id}`, nif: 'B10000000' } });
  await asegurarPlanContableEmpresa(id);
  await prisma.fiscalYear.create({ data: { companyId: id, label: '2026', fechaInicio: '2026-01-01', fechaFin: '2026-12-31', llevanza: llevanza2026 } });
  await prisma.fiscalYear.create({ data: { companyId: id, label: '2027', fechaInicio: '2027-01-01', fechaFin: '2027-12-31' } });
}

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

beforeAll(async () => {
  await empresa(E, 'EXTERNA');
  await empresa(OTRA, 'APP');
});

describe('guarda de fechas con 2026 externo', () => {
  it('ninguna fecha de 2026: 409 con el motivo y el enlace a la carga', async () => {
    const e = await error(comprobarFechaAbierta(E, '2026-06-30', 'emitir la factura'));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('2026 lo lleva tu gestoría: en la app no se puede apuntar nada con fecha de 2026. Usa una fecha de 2027.');
    expect(e.details).toEqual({ motivo: 'llevanza_externa', enlace: '/dashboard/contabilidad/arranque' });
    await expect(exigirFechaContabilizable(E, new Date('2026-12-31T00:00:00.000Z'))).rejects.toMatchObject({ statusCode: 409 });
    await expect(comprobarFechaAbierta(E, '2027-01-10')).resolves.toBeUndefined();
  });

  it('en otra empresa (2026 en la app) no cambia nada', async () => {
    await expect(comprobarFechaAbierta(OTRA, '2026-06-30')).resolves.toBeUndefined();
    expect(await periodoNoAbierto(OTRA, '2026-06-30')).toBeNull();
  });

  it('periodoNoAbierto lo explica para las facturas recibidas', async () => {
    expect(await periodoNoAbierto(E, '2026-03-01')).toMatchObject({ motivo: 'llevanza_externa', situacion: '2026 lo lleva tu gestoría', enlace: '/dashboard/contabilidad/arranque' });
  });

  it('red de seguridad: un asiento con apuntes de 2026 no se crea', async () => {
    const apuntes = [
      { subcuenta: '5720000001', debe: 10, haber: 0, concepto: 'x' },
      { subcuenta: '7000000000', debe: 0, haber: 10, concepto: 'x' },
    ];
    await expect(crearAsientoConApuntes(E, { fecha: '2026-05-05', concepto: 'Prueba', apuntes })).rejects.toMatchObject({ statusCode: 409 });
    await expect(prisma.$transaction((tx) => crearAsientoConApuntes(E, { fecha: '2026-05-05', concepto: 'Prueba', apuntes, tx }))).rejects.toMatchObject({ statusCode: 409 });
    const ok = await crearAsientoConApuntes(E, { fecha: '2027-02-01', concepto: 'Prueba 2027', apuntes });
    expect(ok.asiento.fecha).toBe('2027-02-01');
  });

  it('el cierre de 2026 lo hace la gestoría', async () => {
    const e = await error(previsualizarCierre(E, 2026));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe('El cierre de 2026 lo hace tu gestoría: en la app su resultado entra con la apertura de 2027.');
  });
});

describe('diario histórico', () => {
  it('tipo por el origen, no por el concepto', () => {
    expect(tipoAsiento('HISTORICO_APERTURA', 'Asiento de apertura')).toBe('APERTURA');
    expect(tipoAsiento('HISTORICO_REGULARIZACION', 'Regularización')).toBe('REGULARIZACION');
    expect(tipoAsiento('HISTORICO_CIERRE', 'Cierre')).toBe('CIERRE');
    expect(tipoAsiento('HISTORICO', 'Cierre ejercicio 2026 (texto que engaña)')).toBe('NORMAL');
    expect(tipoAsiento('HISTORICO', 'Apertura ejercicio 2026')).toBe('NORMAL');
    expect(tipoAsiento('APERTURA_AJUSTE', 'Ajuste de la apertura')).toBe('APERTURA');
  });

  it('el cierre histórico deja 2026 cerrado; un concepto «Cierre ejercicio» en un asiento histórico normal no', async () => {
    const H = `llevanza-hist-${SUFIJO}`;
    await empresa(H, 'EXTERNA');
    const lineas = [
      { cuenta: '5720000001', nombre: 'Banco', debe: 5, haber: 0 },
      { cuenta: '1000000000', nombre: 'Capital', debe: 0, haber: 5 },
    ];
    await prisma.$transaction((tx) => grabarAsientos(tx, H, [{ fecha: '2026-03-01', concepto: 'Cierre ejercicio de la caja (texto)', origen: 'HISTORICO', lineas }]));
    expect(await estadoCierreAnio(H, 2026)).toBe('ABIERTO');
    const n = await prisma.journalEntry.count({ where: { companyId: H, ...FILTRO_ASIENTOS_CIERRE } });
    expect(n).toBe(0);
    const [cierre] = await prisma.$transaction((tx) =>
      grabarAsientos(tx, H, [{ fecha: '2026-12-31', concepto: 'Asiento de cierre', origen: 'HISTORICO_CIERRE', lineas: lineas.map((l) => ({ ...l, debe: l.haber, haber: l.debe })) }]),
    );
    expect(cierre.numero).toBe('HIST-00002');
    expect(await estadoCierreAnio(H, 2026)).toBe('CERRADO');
    // La apertura histórica de 2026 no es la apertura que buscan el cierre y la puesta en marcha.
    await prisma.$transaction((tx) => grabarAsientos(tx, H, [{ fecha: '2026-01-01', concepto: 'Apertura ejercicio 2026', origen: 'HISTORICO_APERTURA', lineas }]));
    expect(await prisma.journalEntry.count({ where: { companyId: H, ...FILTRO_ASIENTOS_APERTURA } })).toBe(0);
  });
});
