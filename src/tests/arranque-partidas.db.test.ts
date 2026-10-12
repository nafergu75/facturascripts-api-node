/**
 * Facturas de 2026 pendientes a 31-12 (partidas): cobrar y pagar en 2027
 * (parcial, total, con comision), anular, conciliar con un movimiento del
 * banco, anticipos con importe negativo y partidas en otra moneda.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import {
  anularLiquidacion,
  apuntesLiquidacion,
  conciliarMovimientoConPartida,
  estadoPartida,
  liquidarPartida,
  listarPartidas,
  resumenPendiente,
} from '../services/arranque/partidas.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import type { HttpError } from '../utils/http-errors';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga, USUARIO_PRUEBA } from './fixtures/arranque/importar';

const E = `arr-part-${Date.now()}`;
const U = USUARIO_PRUEBA;

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

const lineasDe = async (asiento: string | null) =>
  (await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, numeroAsiento: asiento! }, include: { lineas: true } })).lineas
    .map((l) => [l.accountCode, Number(l.debe), Number(l.haber)])
    .sort();
const partida = (doc: string) => prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: doc, estado: { not: 'ANULADA' } } });
const saldo = async (cuenta: string) => {
  const ls = await prisma.journalEntryLine.findMany({ where: { companyId: E, accountCode: cuenta, entry: { estado: 'POSTED', fecha: { gte: new Date('2027-01-01T00:00:00Z') } } } });
  return Math.round(ls.reduce((s, l) => s + Number(l.debe) - Number(l.haber), 0) * 100) / 100;
};

describe('cálculos sin base de datos', () => {
  it('apuntes de un cobro con comisión, de un pago y de un anticipo (negativo)', () => {
    const c = { tesoreria: { cuenta: '5720000001', nombre: 'Banco' }, tercero: { cuenta: '4300000001', nombre: 'Alfa' } };
    expect(apuntesLiquidacion('COBRO', 1000, 5, c)).toEqual([
      { cuenta: '5720000001', nombre: 'Banco', debe: 995, haber: 0 },
      { cuenta: '626', nombre: 'Servicios bancarios y similares', debe: 5, haber: 0 },
      { cuenta: '4300000001', nombre: 'Alfa', debe: 0, haber: 1000 },
    ]);
    expect(apuntesLiquidacion('PAGO', 500, 0, { ...c, tercero: { cuenta: '4000000001', nombre: 'Uno' } })).toEqual([
      { cuenta: '4000000001', nombre: 'Uno', debe: 500, haber: 0 },
      { cuenta: '5720000001', nombre: 'Banco', debe: 0, haber: 500 },
    ]);
    // Devolver un anticipo de un cliente (partida de cobro de -200): sale dinero.
    expect(apuntesLiquidacion('COBRO', -200, 0, c)).toEqual([
      { cuenta: '5720000001', nombre: 'Banco', debe: 0, haber: 200 },
      { cuenta: '4300000001', nombre: 'Alfa', debe: 200, haber: 0 },
    ]);
  });

  it('estado de la partida según lo liquidado', () => {
    expect(estadoPartida(100, 0)).toBe('PENDIENTE');
    expect(estadoPartida(100, 40)).toBe('PARCIAL');
    expect(estadoPartida(100, 100)).toBe('LIQUIDADA');
    expect(estadoPartida(-200, -200)).toBe('LIQUIDADA');
  });
});

describe('cobrar y pagar las facturas pendientes de 2026', () => {
  let banco = '';
  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
    banco = (await prisma.bankAccount.findFirstOrThrow({ where: { companyId: E, subcuentaCodigo: '5720000001' } })).id;
  }, 120_000);

  it('la lista separa cobros y pagos, con los totales', async () => {
    const cobros = await listarPartidas(E, { tipos: ['COBRO'] });
    expect(cobros.partidas.map((p) => [p.numeroDocumento, p.tercero, p.pendiente, p.estado])).toEqual([
      ['A-2026-001', 'Cliente Alfa SL', 6050, 'PENDIENTE'],
      ['A-2026-002', 'Cliente Beta SA', 6050, 'PENDIENTE'],
    ]);
    expect(cobros.totales.cobros).toEqual({ abiertas: 2, pendiente: 12100 });
    const todas = await listarPartidas(E, { tipos: ['COBRO', 'PAGO'] });
    expect(todas.totales.pagos).toEqual({ abiertas: 3, pendiente: 5445 });
    expect((await listarPartidas(E, { tipos: ['PAGO'], tercero: '4100000001' })).partidas).toHaveLength(1);
  });

  it('cobro parcial con comisión, el resto después; ya cobrada, 409', async () => {
    const beta = await partida('A-2026-002');
    const r = await liquidarPartida(E, beta.id, { fecha: '2027-01-20', importe: 1000, comision: 5, cuentaBancariaId: banco }, U);
    expect(r.partida).toMatchObject({ estado: 'PARCIAL', liquidado: 1000, pendiente: 5050 });
    expect(await lineasDe(r.liquidacion.asiento)).toEqual([
      ['4300000002', 0, 1000],
      ['5720000001', 995, 0],
      ['626', 5, 0],
    ]);
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E, numeroAsiento: r.liquidacion.asiento! } });
    expect(asiento).toMatchObject({ origen: 'TESORERIA', invoiceType: 'PARTIDA', invoiceId: beta.id, estado: 'POSTED' });

    const resto = await liquidarPartida(E, beta.id, { fecha: '2027-02-01' }, U);
    expect(resto.partida).toMatchObject({ estado: 'LIQUIDADA', pendiente: 0 });
    expect((await error(liquidarPartida(E, beta.id, { fecha: '2027-02-02', importe: 1 }, U))).statusCode).toBe(409);
    // La subcuenta del cliente queda a cero en 2027 (apertura menos cobros).
    expect(await saldo('4300000002')).toBe(0);
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'PARTIDA_LIQUIDADA' } })).toBe(2);
  });

  it('no se cobra con fecha de 2026, ni más de lo pendiente, ni con el signo cambiado', async () => {
    const alfa = await partida('A-2026-001');
    expect((await error(liquidarPartida(E, alfa.id, { fecha: '2026-12-30', importe: 10 }, U))).statusCode).toBe(400);
    const e = await error(liquidarPartida(E, alfa.id, { fecha: '2027-01-10', importe: 7000 }, U));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe('El importe (7.000,00 €) supera lo pendiente de la factura (6.050,00 €).');
    expect((await error(liquidarPartida(E, alfa.id, { fecha: '2027-01-10', importe: -10 }, U))).statusCode).toBe(400);
    // Solo el tipo permitido: quien solo ve pagos no encuentra un cobro.
    expect((await error(liquidarPartida(E, alfa.id, { fecha: '2027-01-10' }, U, { tipos: ['PAGO'] }))).statusCode).toBe(404);
  });

  it('anular un cobro devuelve lo pendiente; con el mes bloqueado, contraasiento', async () => {
    const beta = await partida('A-2026-002');
    const pagos = await prisma.invoicePayment.findMany({ where: { companyId: E, invoiceType: 'PARTIDA', invoiceId: beta.id }, orderBy: { fecha: 'asc' } });
    const r = await anularLiquidacion(E, pagos[0].id, {}, U);
    expect(r.contraasiento).toBe(false);
    expect(r.partida).toMatchObject({ estado: 'PARCIAL', pendiente: 1000 });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: pagos[0].journalEntryId! } })).estado).toBe('REVERSED');
    expect((await error(anularLiquidacion(E, pagos[0].id, {}, U))).statusCode).toBe(409);

    await prisma.periodo.upsert({
      where: { companyId_ejercicio_mes: { companyId: E, ejercicio: 2027, mes: 2 } },
      create: { companyId: E, ejercicio: 2027, mes: 2, estado: 'bloqueado' },
      update: { estado: 'bloqueado' },
    });
    const c = await anularLiquidacion(E, pagos[1].id, { fecha: '2027-03-01' }, U);
    expect(c.contraasiento).toBe(true);
    expect(c.partida).toMatchObject({ estado: 'PENDIENTE', pendiente: 6050 });
    expect(await saldo('4300000002')).toBe(6050);
    await prisma.periodo.update({ where: { companyId_ejercicio_mes: { companyId: E, ejercicio: 2027, mes: 2 } }, data: { estado: 'abierto' } });
  });

  it('pago a un proveedor', async () => {
    const uno = await partida('FP-77');
    const r = await liquidarPartida(E, uno.id, { fecha: '2027-01-15', cuentaBancariaId: banco }, U);
    expect(r.partida.estado).toBe('LIQUIDADA');
    expect(await lineasDe(r.liquidacion.asiento)).toEqual([
      ['4000000001', 2420, 0],
      ['5720000001', 0, 2420],
    ]);
    expect(r.liquidacion.asiento).toMatch(/^PAGO-/);
  });

  it('conciliar: un cargo del banco paga la factura de la luz; un abono no puede pagarla; anular la deja sin conciliar', async () => {
    const luz = await partida('L-0330');
    const abono = await prisma.bankMovement.create({ data: { companyId: E, cuentaBancariaId: banco, fecha: '2027-01-05', importe: 605, concepto: 'Ingreso', origen: 'CSV' } });
    expect((await error(conciliarMovimientoConPartida(E, abono.id, luz.id, U))).message).toMatch(/Es un abono/);
    const cargo = await prisma.bankMovement.create({ data: { companyId: E, cuentaBancariaId: banco, fecha: '2027-01-05', importe: -605, concepto: 'Recibo Eléctrica Luz', origen: 'CSV' } });
    const r = await conciliarMovimientoConPartida(E, cargo.id, luz.id, U);
    expect(r.partida).toMatchObject({ estado: 'LIQUIDADA', pendiente: 0 });
    expect(await prisma.bankMovement.findUniqueOrThrow({ where: { id: cargo.id } })).toMatchObject({ conciliado: true, referencia: `partida:${r.liquidacion.id}` });
    expect((await error(conciliarMovimientoConPartida(E, cargo.id, luz.id, U))).statusCode).toBe(409);
    await anularLiquidacion(E, r.liquidacion.id, {}, U);
    expect(await prisma.bankMovement.findUniqueOrThrow({ where: { id: cargo.id } })).toMatchObject({ conciliado: false, referencia: null });
  });

  it('anticipo de un cliente (partida negativa): se devuelve con importe negativo', async () => {
    const carga = await prisma.cargaArranque.findFirstOrThrow({ where: { companyId: E, estado: 'CONFIRMADA' } });
    const ant = await prisma.partidaPendiente.create({
      data: { companyId: E, cargaId: carga.id, tipo: 'COBRO', subcuenta: '4300000003', numeroDocumento: 'ANT-1', importePendiente: -200 },
    });
    expect((await error(liquidarPartida(E, ant.id, { fecha: '2027-01-12', importe: 200 }, U))).message).toMatch(/Lo pendiente es negativo/);
    const r = await liquidarPartida(E, ant.id, { fecha: '2027-01-12', cuentaBancariaId: banco }, U);
    expect(r.partida).toMatchObject({ estado: 'LIQUIDADA', liquidado: -200 });
    expect(await lineasDe(r.liquidacion.asiento)).toEqual([
      ['4300000003', 200, 0],
      ['5720000001', 0, 200],
    ]);
  });

  it('una partida en dólares no se liquida desde aquí', async () => {
    const carga = await prisma.cargaArranque.findFirstOrThrow({ where: { companyId: E, estado: 'CONFIRMADA' } });
    const usd = await prisma.partidaPendiente.create({ data: { companyId: E, cargaId: carga.id, tipo: 'COBRO', subcuenta: '4300000001', numeroDocumento: 'US-1', importePendiente: 100, moneda: 'USD' } });
    const e = await error(liquidarPartida(E, usd.id, { fecha: '2027-01-12' }, U));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'PARTIDA_EN_DIVISA' });
    await prisma.partidaPendiente.update({ where: { id: usd.id }, data: { estado: 'ANULADA' } });
  });

  it('una factura de 2026 de la app que trae la cartera se cobra desde su partida, no dos veces', async () => {
    const alfa = await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '4300000001' } });
    const fra = await prisma.incomeInvoice.create({
      data: {
        companyId: E,
        customerId: alfa.id,
        serie: 'A',
        numero: 1,
        numeroCompleto: 'A-2026-001',
        fechaEmision: '2026-02-15',
        fechaVencimiento: '2026-03-15',
        estado: 'PENDING',
        baseTotal: 10000,
        ivaTotal: 2100,
        retencionTotal: 0,
        totalFactura: 12100,
      },
    });
    const p = await partida('A-2026-001');
    await prisma.partidaPendiente.update({ where: { id: p.id }, data: { incomeInvoiceId: fra.id } });
    const e = await error(registrarCobroFactura(E, 'INGRESO', fra.id, { fecha: '2027-01-10', importe: 100 }));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'FACTURA_CON_PARTIDA_2026', partidaId: p.id });
    expect(e.message).toMatch(/pendientes de 2026 que trajo la gestoría \(A-2026-001\)/);
  });

  it('resumen de lo pendiente de 2026', async () => {
    expect(await resumenPendiente(E)).toEqual({ cobros: { abiertas: 2, pendiente: 12100 }, pagos: { abiertas: 2, pendiente: 3025 } });
  });
});
