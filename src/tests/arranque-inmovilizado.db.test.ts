/**
 * Inmovilizado: alta de fichas, amortizacion mes a mes en asientos en borrador,
 * sin repetir meses, anular un mes y volver a calcularlo, edicion bloqueada con
 * amortizacion apuntada, baja, y meses del año que lleva la gestoria.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { actualizarActivo, anularDotacionMes, calcularDotaciones, crearActivo, darDeBaja, listarActivos, mesesSinDotar } from '../services/arranque/inmovilizado.service';
import type { HttpError } from '../utils/http-errors';

const E = `arr-inm-${Date.now()}`;
const U = 'usuario-inmovilizado';

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

describe('inmovilizado y amortización', () => {
  let torno: string;
  let furgoneta: string;
  beforeAll(async () => {
    await prisma.company.create({ data: { id: E, name: 'Inmovilizado', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
    // 2026 lo lleva la gestoría: sus meses no se amortizan en la app.
    await prisma.fiscalYear.create({ data: { companyId: E, label: '2026', fechaInicio: '2026-01-01', fechaFin: '2026-12-31', estado: 'OPEN', llevanza: 'EXTERNA' } });
  });

  it('valida la ficha y deduce las cuentas de amortización', async () => {
    expect((await error(crearActivo(E, { descripcion: 'X', subcuentaBien: '4300000001', fechaAlta: '2027-01-01', coste: 1, coeficiente: 10 }, U))).details).toMatchObject({ campo: 'subcuentaBien' });
    expect((await error(crearActivo(E, { descripcion: 'X', subcuentaBien: '2130000000', fechaAlta: '2027-01-01', coste: 100, valorResidual: 100, coeficiente: 10 }, U))).details).toMatchObject({ campo: 'valorResidual' });
    expect((await error(crearActivo(E, { descripcion: 'X', subcuentaBien: '2130000000', fechaAlta: '2027-01-01', coste: 100 }, U))).details).toMatchObject({ campo: 'coeficiente' });
    const a = await crearActivo(
      E,
      { descripcion: 'Torno CNC', subcuentaBien: '2130000000', fechaAlta: '2024-01-01', fechaInicioAmortizacion: '2027-01-01', coste: 10000, amortAcumuladaInicial: 3000, fechaAmortAcumulada: '2026-12-31', coeficiente: 10 },
      U,
    );
    expect(a).toMatchObject({ subcuentaAmortAcum: '2813000000', subcuentaDotacion: '6810000000' });
    torno = a.id;
    // Vida útil en años en vez de coeficiente; comprado en junio de 2026 (año de la gestoría).
    const f = await crearActivo(E, { descripcion: 'Furgoneta', subcuentaBien: '2180000000', fechaAlta: '2026-06-01', coste: 24000, vidaUtil: 8 }, U);
    expect(Number(f.coeficiente)).toBe(12.5);
    furgoneta = f.id;
  });

  it('calcula los meses que faltan en asientos en borrador, sin los del año de la gestoría', async () => {
    const pendiente = await mesesSinDotar(E, '2027-02');
    expect(pendiente.map((m) => m.periodo)).toEqual(['2027-01', '2027-02']);
    const r = await calcularDotaciones(E, '2027-02', U);
    expect(r.meses.map((m) => [m.periodo, m.importe, m.bienes])).toEqual([
      ['2027-01', 339.72, 2], // 84,93 del torno y 254,79 de la furgoneta
      ['2027-02', 306.85, 2],
    ]);
    expect(r.texto).toMatch(/^Amortización de 2 meses \(de 01\/2027 a 02\/2027\): 646,57 €\. Los asientos están en borrador/);
    const asientos = await prisma.journalEntry.findMany({ where: { companyId: E, origen: 'AMORTIZACION' }, include: { lineas: true }, orderBy: { fecha: 'asc' } });
    expect(asientos.map((a) => [a.numeroAsiento, a.estado, a.fecha.toISOString().slice(0, 10)])).toEqual([
      ['AMORT-00001', 'DRAFT', '2027-01-31'],
      ['AMORT-00002', 'DRAFT', '2027-02-28'],
    ]);
    const enero = asientos[0].lineas.map((l) => [l.accountCode, Number(l.debe), Number(l.haber)]).sort();
    expect(enero).toEqual([
      ['2813000000', 0, 84.93],
      ['2818000000', 0, 254.79],
      ['6810000000', 254.79, 0],
      ['6810000000', 84.93, 0],
    ]);
    // Otra vez hasta febrero: nada nuevo.
    expect((await calcularDotaciones(E, '2027-02', U)).meses).toEqual([]);
    expect(await prisma.dotacionAmortizacion.count({ where: { companyId: E } })).toBe(4);
  });

  it('la lista enseña lo amortizado y el valor neto; con amortización apuntada no se edita', async () => {
    const l = await listarActivos(E);
    const t = l.activos.find((a) => a.id === torno)!;
    expect(t).toMatchObject({ dotado: 161.64, amortizacionTotal: 3161.64, valorNeto: 6838.36, ultimoMesDotado: '2027-02', editable: false });
    expect((await error(actualizarActivo(E, torno, { coste: 9000 }, U))).statusCode).toBe(409);
  });

  it('anular un mes deja volver a calcularlo, sin repetir los demás', async () => {
    const r = await anularDotacionMes(E, '2027-02', U);
    expect(r.asientos).toEqual(['AMORT-00002']);
    expect((await prisma.journalEntry.findFirst({ where: { companyId: E, numeroAsiento: 'AMORT-00002' } }))?.estado).toBe('REVERSED');
    expect((await listarActivos(E)).activos.find((a) => a.id === torno)?.dotado).toBe(84.93);
    const otra = await calcularDotaciones(E, '2027-02', U);
    expect(otra.meses.map((m) => [m.periodo, m.asiento?.numero])).toEqual([['2027-02', 'AMORT-00003']]);
    expect(await prisma.dotacionAmortizacion.count({ where: { companyId: E } })).toBe(4);
    expect(await prisma.dotacionAmortizacion.count({ where: { companyId: E, anulada: true } })).toBe(0);
  });

  it('un asiento anulado desde el motor contable tampoco cuenta', async () => {
    await prisma.journalEntry.updateMany({ where: { companyId: E, numeroAsiento: 'AMORT-00003' }, data: { estado: 'REVERSED' } });
    expect((await mesesSinDotar(E, '2027-02')).map((m) => m.periodo)).toEqual(['2027-02']);
    await calcularDotaciones(E, '2027-02', U);
  });

  it('la baja amortiza hasta ese día; con amortización apuntada después, 409', async () => {
    expect((await error(darDeBaja(E, furgoneta, '2027-01-15', U))).statusCode).toBe(409);
    await darDeBaja(E, furgoneta, '2027-03-10', U);
    const r = await calcularDotaciones(E, '2027-04', U);
    const marzo = r.meses.find((m) => m.periodo === '2027-03')!;
    expect(marzo.bienes).toBe(2);
    expect(r.meses.find((m) => m.periodo === '2027-04')?.bienes).toBe(1);
    expect((await listarActivos(E)).activos.map((a) => a.id)).toEqual([torno]);
    expect((await listarActivos(E, { todos: true })).activos).toHaveLength(2);
  });

  it('un mes bloqueado no se amortiza', async () => {
    await prisma.periodo.upsert({
      where: { companyId_ejercicio_mes: { companyId: E, ejercicio: 2027, mes: 5 } },
      create: { companyId: E, ejercicio: 2027, mes: 5, estado: 'bloqueado' },
      update: { estado: 'bloqueado' },
    });
    const e = await error(calcularDotaciones(E, '2027-05', U));
    expect(e.statusCode).toBeGreaterThanOrEqual(400);
    expect(await prisma.dotacionAmortizacion.count({ where: { companyId: E, periodo: '2027-05' } })).toBe(0);
  });
});
