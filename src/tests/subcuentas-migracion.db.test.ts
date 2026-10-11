/**
 * Migracion de lo contabilizado en las genericas 430/400/410 a la subcuenta
 * de cada tercero: la simulacion no escribe, aplicar reescribe, una segunda
 * pasada no cambia nada, se para con ejercicios cerrados e informa de lo que
 * no se puede reasignar.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { EjerciciosCerradosError, informeEnTexto, LongitudSinFijarError, migrarSubcuentasTerceros } from '../services/terceros/migracion';

const SUFIJO = Date.now();
const E = `migsub-${SUFIJO}`;
const E_CERRADA = `migsub-cerr-${SUFIJO}`;
let clienteViejo: string;
let clienteNuevo: string;
let proveedor: string;
let lineaVenta: string;
let lineaGasto: string;
let lineaPago: string;

async function asiento(companyId: string, numero: string, origen: string, lineas: Array<[string, number, number]>, factura?: { id: string; tipo: string }) {
  return prisma.journalEntry.create({
    data: {
      companyId,
      fecha: new Date('2026-03-01T00:00:00Z'),
      numeroAsiento: numero,
      descripcion: numero,
      origen,
      estado: 'POSTED',
      invoiceId: factura?.id,
      invoiceType: factura?.tipo,
      lineas: { create: lineas.map(([accountCode, debe, haber]) => ({ companyId, accountCode, accountName: 'Antiguo', debe, haber })) },
    },
    include: { lineas: true },
  });
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Migracion SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await asegurarPlanContableEmpresa(E);
  // Como estaban antes: fichas sin subcuenta y asientos contra las genericas.
  clienteViejo = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Antiguo SL', nifCif: 'B01010101', createdAt: new Date('2025-01-01') } })).id;
  clienteNuevo = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Reciente SL', nifCif: 'B02020202', createdAt: new Date('2026-01-01') } })).id;
  proveedor = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Gestoría Migrada SL', nifCif: 'B03030303' } })).id;

  const venta = await prisma.incomeInvoice.create({
    data: { companyId: E, customerId: clienteNuevo, serie: 'A', numero: 1, numeroCompleto: 'A-1', fechaEmision: '2026-03-01', fechaVencimiento: '2026-04-01', estado: 'PENDING', baseTotal: 100, ivaTotal: 21, retencionTotal: 0, totalFactura: 121 },
  });
  const gasto = await prisma.expenseInvoice.create({
    data: { companyId: E, supplierId: proveedor, serie: 'G', numero: 1, numeroCompleto: 'G-1', fechaEmision: '2026-03-01', fechaVencimiento: '2026-04-01', estado: 'ACCOUNTED', tipoGasto: 'SERVICIO_PROFESIONAL', baseTotal: 100, ivaTotal: 21, totalFactura: 121 },
  });
  const av = await asiento(E, 'FAC-ING-A-1', 'FACTURA_INGRESO', [['430', 121, 0], ['700', 0, 100], ['477', 0, 21]], { id: venta.id, tipo: 'INGRESO' });
  lineaVenta = av.lineas.find((l) => l.accountCode === '430')!.id;
  const ag = await asiento(E, 'FAC-GAST-G-1', 'FACTURA_GASTO', [['623', 100, 0], ['472', 21, 0], ['410', 0, 121]], { id: gasto.id, tipo: 'GASTO' });
  lineaGasto = ag.lineas.find((l) => l.accountCode === '410')!.id;
  const ap = await asiento(E, 'PAGO-00001', 'TESORERIA', [['4100000000', 121, 0], ['572', 0, 121]], { id: gasto.id, tipo: 'GASTO' });
  lineaPago = ap.lineas.find((l) => l.accountCode === '4100000000')!.id;
  // Lo que no se puede reasignar.
  await asiento(E, 'APERT-1', 'IMPORTACION', [['4300000000', 500, 0], ['129', 0, 500]]);
  await asiento(E, 'FAC-ING-BORRADA', 'FACTURA_INGRESO', [['430', 50, 0], ['700', 0, 50]], { id: 'no-existe', tipo: 'INGRESO' });

  await prisma.company.create({ data: { id: E_CERRADA, name: 'Cerrada SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.fiscalYear.create({ data: { companyId: E_CERRADA, label: '2025', fechaInicio: '2025-01-01', fechaFin: '2025-12-31', estado: 'CLOSED' } });
});

describe('migrar subcuentas de terceros', () => {
  it('sin longitud guardada ni subcuentas en el plan se para y pide --longitud (no elige 8 por su cuenta)', async () => {
    await expect(migrarSubcuentasTerceros(E)).rejects.toBeInstanceOf(LongitudSinFijarError);
    await expect(migrarSubcuentasTerceros(E, { aplicar: true })).rejects.toThrow(/tráelo antes .*--longitud 8/s);
    await expect(migrarSubcuentasTerceros(E, { longitud: 11 })).rejects.toThrow(/de 7 a 10/);
    expect(await prisma.reglasContables.count({ where: { companyId: E } })).toBe(0);
  });

  it('simulacion: informa de todo y no escribe nada', async () => {
    const r = await migrarSubcuentasTerceros(E, { longitud: 8 });
    expect(r).toMatchObject({ simulacion: true, longitud: 8, longitudFijada: true, lineasReescritas: 3 });
    expect(r.fichasConSubcuentaNueva.map((f) => [f.nombre, f.subcuentas])).toEqual([
      ['Cliente Antiguo SL', ['43000001']],
      ['Cliente Reciente SL', ['43000002']],
      ['Gestoría Migrada SL', ['40000001', '41000001']],
    ]);
    expect(r.porTercero).toEqual([
      { tipo: 'proveedor', id: proveedor, nombre: 'Gestoría Migrada SL', cuenta: '41000001', lineas: 2 },
      { tipo: 'cliente', id: clienteNuevo, nombre: 'Cliente Reciente SL', cuenta: '43000002', lineas: 1 },
    ].sort((a, b) => a.cuenta.localeCompare(b.cuenta)));
    expect(r.cuentasDadasDeAltaEnPlan).toEqual(['41000001', '43000002']);
    expect(r.sinReasignar.map((l) => [l.numeroAsiento, l.cuenta])).toEqual([
      ['APERT-1', '4300000000'],
      ['FAC-ING-BORRADA', '430'],
    ]);
    expect(r.sinReasignar[0].motivo).toMatch(/Apertura o importación/);
    expect(r.sinReasignar[1].motivo).toMatch(/ya no existe/);
    expect(informeEnTexto(r)).toContain('SIMULACIÓN (no se ha escrito nada)');

    // Nada ha cambiado.
    expect((await prisma.journalEntryLine.findUniqueOrThrow({ where: { id: lineaVenta } })).accountCode).toBe('430');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: clienteViejo } })).subcuenta430).toBeNull();
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: { in: ['41000001', '43000002'] } } })).toBe(0);
    expect(await prisma.reglasContables.count({ where: { companyId: E } })).toBe(0);
  });

  it('aplicar: reescribe las lineas, da de alta las subcuentas usadas y fija la longitud', async () => {
    const r = await migrarSubcuentasTerceros(E, { aplicar: true, longitud: 8 });
    expect(r).toMatchObject({ simulacion: false, lineasReescritas: 3 });
    expect(await prisma.journalEntryLine.findUniqueOrThrow({ where: { id: lineaVenta } })).toMatchObject({ accountCode: '43000002', accountName: 'Cliente Reciente SL' });
    expect(await prisma.journalEntryLine.findUniqueOrThrow({ where: { id: lineaGasto } })).toMatchObject({ accountCode: '41000001', accountName: 'Gestoría Migrada SL' });
    expect((await prisma.journalEntryLine.findUniqueOrThrow({ where: { id: lineaPago } })).accountCode).toBe('41000001');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: clienteViejo } })).subcuenta430).toBe('43000001');
    expect(await prisma.supplier.findUniqueOrThrow({ where: { id: proveedor } })).toMatchObject({ subcuenta400: '40000001', subcuenta410: '41000001' });
    const plan = await prisma.chartOfAccounts.findMany({ where: { companyId: E, codigo: { in: ['43000001', '43000002', '40000001', '41000001'] } } });
    expect(plan.map((c) => [c.codigo, c.nombre]).sort()).toEqual([
      ['41000001', 'Gestoría Migrada SL'],
      ['43000002', 'Cliente Reciente SL'],
    ]);
    expect(((await prisma.reglasContables.findUniqueOrThrow({ where: { companyId: E } })).data as { longitudSubcuentas: number }).longitudSubcuentas).toBe(8);
    // Lo que no se podia reasignar sigue en la generica.
    expect(await prisma.journalEntryLine.count({ where: { companyId: E, accountCode: '4300000000' } })).toBe(1);
  });

  it('una segunda pasada no cambia nada', async () => {
    const r = await migrarSubcuentasTerceros(E, { aplicar: true });
    expect(r).toMatchObject({ lineasReescritas: 0, longitudFijada: false, fichasConSubcuentaNueva: [], cuentasDadasDeAltaEnPlan: [] });
    expect(r.sinReasignar).toHaveLength(2);
    // Con la longitud ya guardada no hace falta --longitud; otra distinta se rechaza.
    await expect(migrarSubcuentasTerceros(E, { longitud: 10 })).rejects.toThrow(/Ya usa subcuentas de 8 dígitos/);
  });

  it('con un ejercicio cerrado se para; con incluirCerrados sigue', async () => {
    await expect(migrarSubcuentasTerceros(E_CERRADA)).rejects.toBeInstanceOf(EjerciciosCerradosError);
    await expect(migrarSubcuentasTerceros(E_CERRADA)).rejects.toThrow(/ejercicios cerrados \(2025\)/);
    await expect(migrarSubcuentasTerceros(E_CERRADA, { incluirCerrados: true })).resolves.toMatchObject({ simulacion: true, lineasReescritas: 0 });
  });

  it('empresa que no existe: error claro', async () => {
    await expect(migrarSubcuentasTerceros(`no-existe-${SUFIJO}`)).rejects.toThrow(/No existe la empresa/);
  });
});
