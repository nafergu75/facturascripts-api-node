/**
 * Informes contables sobre BD real (asientos de ejemplo): sumas y saldos que
 * cuadran, mayor con saldo acumulado, saldo por cliente y proveedor, balance y
 * PyG de un ejercicio cerrado (sin regularizacion ni cierre) y descargas.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import * as XLSX from 'xlsx';
import { prisma } from '../config/database';
import {
  ejerciciosDisponibles,
  informeBalance,
  informeDetalleTercero,
  informeDiario,
  informeMayor,
  informeMayorTerceros,
  informePerdidasGanancias,
  informeSumasYSaldos,
} from '../services/informesContables.service';
import { tablaAPdf, tablaAXlsx } from '../services/informesContables.documentos';
import { reportsService } from '../services/reports.service';

const COMPANY_ID = `informes-test-${Date.now()}`;
let cliA: string;
let cliB: string;
let prov: string;
let factA: string;
let factB: string;
let factP: string;

let numero = 0;
async function asiento(
  fecha: string,
  descripcion: string,
  lineas: Array<[string, number, number, string?]>,
  extra: { origen?: string; invoiceId?: string; invoiceType?: string } = {},
) {
  numero += 1;
  return prisma.journalEntry.create({
    data: {
      companyId: COMPANY_ID,
      fecha: new Date(fecha),
      numeroAsiento: `T-${String(numero).padStart(4, '0')}`,
      descripcion,
      origen: extra.origen ?? 'AJUSTE_MANUAL',
      estado: 'POSTED',
      invoiceId: extra.invoiceId,
      invoiceType: extra.invoiceType,
      lineas: {
        create: lineas.map(([accountCode, debe, haber, referencia]) => ({
          accountCode,
          accountName: `Cuenta ${accountCode}`,
          debe,
          haber,
          referencia,
          companyId: COMPANY_ID,
        })),
      },
    },
  });
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Informes Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Informes Test SL', nif: 'B99999999' } });
  cliA = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Alfa Clientes SL', nifCif: 'B11111111' } })).id;
  cliB = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Beta Clientes SA', nifCif: 'A22222222' } })).id;
  prov = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor Uno SL', nifCif: 'B33333333' } })).id;
  const venta = (customerId: string, n: number, total: number, fecha: string, estado: string) =>
    prisma.incomeInvoice.create({
      data: {
        companyId: COMPANY_ID,
        customerId,
        serie: 'A',
        numero: n,
        numeroCompleto: `A-${n}`,
        fechaEmision: fecha,
        fechaVencimiento: fecha,
        estado,
        totalFactura: total,
      },
    });
  factA = (await venta(cliA, 1, 1210, '2025-02-10', 'PAID')).id;
  factB = (await venta(cliB, 2, 605, '2025-06-15', 'PENDING')).id;
  factP = (
    await prisma.expenseInvoice.create({
      data: { companyId: COMPANY_ID, supplierId: prov, serie: 'P', numero: 1, numeroCompleto: 'P-1', fechaEmision: '2025-03-01', fechaVencimiento: '2025-03-31', estado: 'ACCOUNTED', totalFactura: 363 },
    })
  ).id;

  // Ejercicio 2025
  await asiento('2025-01-01', 'Aportación de capital', [['572', 3000, 0], ['100', 0, 3000]]);
  await asiento('2025-02-10', 'Factura A-1', [['430', 1210, 0, 'A-1'], ['700', 0, 1000, 'A-1'], ['477', 0, 210, 'A-1']], { origen: 'FACTURA_INGRESO', invoiceId: factA, invoiceType: 'INGRESO' });
  await asiento('2025-03-01', 'Factura P-1', [['629', 300, 0, 'P-1'], ['472', 63, 0, 'P-1'], ['400', 0, 363, 'P-1']], { origen: 'FACTURA_GASTO', invoiceId: factP, invoiceType: 'GASTO' });
  await asiento('2025-03-20', `Cobro factura ${factA}`, [['572', 1210, 0], ['430', 0, 1210]], { origen: 'TESORERIA' });
  await asiento('2025-06-15', 'Factura A-2', [['430', 605, 0, 'A-2'], ['700', 0, 500, 'A-2'], ['477', 0, 105, 'A-2']], { origen: 'FACTURA_INGRESO', invoiceId: factB, invoiceType: 'INGRESO' });
  // Grabado tarde con fecha anterior: el mayor tiene que ordenarlo por fecha.
  await asiento('2025-02-01', 'Gasto bancario', [['626', 10, 0], ['572', 0, 10]]);
  // Regularizacion y cierre (ventas 1500, gastos 310 => resultado 1190)
  await asiento('2025-12-31', 'Regularizacion ejercicio 2025', [['700', 1500, 0], ['629', 0, 300], ['626', 0, 10], ['129', 0, 1190]], { origen: 'REGULARIZACION' });
  await asiento(
    '2025-12-31',
    'Cierre ejercicio 2025',
    [['100', 3000, 0], ['129', 1190, 0], ['477', 315, 0], ['400', 363, 0], ['572', 0, 4200], ['430', 0, 605], ['472', 0, 63]],
    { origen: 'CIERRE' },
  );
  // Ejercicio 2026
  await asiento(
    '2026-01-01',
    'Apertura ejercicio 2026',
    [['572', 4200, 0], ['430', 605, 0], ['472', 63, 0], ['100', 0, 3000], ['129', 0, 1190], ['477', 0, 315], ['400', 0, 363]],
    { origen: 'APERTURA' },
  );
  await asiento('2026-02-01', 'Pago factura P-1', [['400', 363, 0, 'P-1'], ['572', 0, 363]], { origen: 'TESORERIA' });
});

describe('informes contables con BD', () => {
  it('lista los ejercicios con asientos', async () => {
    expect(await ejerciciosDisponibles(COMPANY_ID)).toEqual(expect.arrayContaining([2026, 2025]));
  });

  it('sumas y saldos de un ejercicio cerrado: cuadra y no sale a cero', async () => {
    const r = await informeSumasYSaldos(COMPANY_ID, { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 }, 'subcuenta');
    expect(r.cuadra).toBe(true);
    expect(r.totales.debe).toBe(r.totales.haber);
    expect(r.filas.find((f) => f.cuenta === '700')).toMatchObject({ haber: 1500, saldoAcreedor: 1500 });
    expect(r.filas.find((f) => f.cuenta === '572')).toMatchObject({ debe: 4210, haber: 10, saldoDeudor: 4200 });
    expect(r.filas.find((f) => f.cuenta === '129')).toBeUndefined();
    const xlsx = XLSX.read(tablaAXlsx(r.tabla), { type: 'buffer' });
    const ws = xlsx.Sheets[xlsx.SheetNames[0]];
    expect(ws['D6'].t).toBe('n');
  });

  it('mayor de la 572 por fecha de asiento con saldo acumulado', async () => {
    const r = await informeMayor(COMPANY_ID, { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 }, { cuenta: '572' });
    const [c] = r.cuentas;
    expect(c.movimientos.map((m) => [m.fecha, m.saldo])).toEqual([
      ['2025-01-01', 3000],
      ['2025-02-01', 2990],
      ['2025-03-20', 4200],
    ]);
    expect(c.saldoFinal).toBe(4200);

    const r2026 = await informeMayor(COMPANY_ID, { desde: '2026-02-01', hasta: '2026-12-31', ejercicio: 2026 }, { cuenta: '572' });
    expect(r2026.cuentas[0]).toMatchObject({ saldoInicial: 4200, saldoFinal: 3837 });
    const pdf = await tablaAPdf(r2026.tabla);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('el mayor antiguo (/reports/ledger) ordena por fecha del asiento y excluye el cierre', async () => {
    const r = await reportsService.obtenerMayor(COMPANY_ID, '572', '2025-01-01', '2025-12-31');
    expect(r.movimientos.map((m) => new Date(m.fecha).toISOString().slice(0, 10))).toEqual(['2025-01-01', '2025-02-01', '2025-03-20']);
    expect(r.saldoFinal).toBe(4200);
    const pyg = await reportsService.obtenerPyG(COMPANY_ID, '2025-01-01', '2025-12-31');
    expect(pyg.ingresos).toBe(1500);
  });

  it('balance y PyG del ejercicio cerrado, con columna del anterior', async () => {
    const pyg = await informePerdidasGanancias(COMPANY_ID, { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 });
    expect(pyg.actual.resultadoEjercicio).toBe(1190);
    expect(pyg.anterior.resultadoEjercicio).toBe(0);
    const bal = await informeBalance(COMPANY_ID, { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 });
    expect(bal.cuadra).toBe(true);
    expect(bal.balance.totalActivo).toBe(4200 + 605 + 63);
    const bal26 = await informeBalance(COMPANY_ID, { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    expect(bal26.cuadra).toBe(true);
    expect(bal26.anterior.totalActivo).toBe(bal.balance.totalActivo);
  });

  it('diario: sin cierre por defecto, completo si se pide', async () => {
    const periodo = { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 };
    const sin = await informeDiario(COMPANY_ID, periodo, false);
    const con = await informeDiario(COMPANY_ID, periodo, true);
    expect(sin.asientos).toHaveLength(6);
    expect(con.asientos).toHaveLength(8);
    expect(con.totalDebe).toBe(con.totalHaber);
  });

  it('mayor de clientes: saldo por cliente desde la contabilidad, cruzado con las facturas pendientes', async () => {
    const r = await informeMayorTerceros(COMPANY_ID, 'clientes', { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 });
    const porId = new Map(r.terceros.map((t) => [t.id, t]));
    expect(porId.get(cliA)).toMatchObject({ debe: 1210, haber: 1210, saldoFinal: 0, pendienteFacturas: 0 });
    expect(porId.get(cliB)).toMatchObject({ debe: 605, haber: 0, saldoFinal: 605, pendienteFacturas: 605 });
    expect(porId.has('sin-identificar')).toBe(false);
    expect(r.totales.saldoFinal).toBe(605);

    const conSaldo = await informeMayorTerceros(COMPANY_ID, 'clientes', { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 }, { soloConSaldo: true });
    expect(conSaldo.terceros.map((t) => t.id)).toEqual([cliB]);
    const busqueda = await informeMayorTerceros(COMPANY_ID, 'clientes', { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 }, { q: 'alfa' });
    expect(busqueda.terceros.map((t) => t.id)).toEqual([cliA]);

    // 2026: el saldo de Beta viene de 2025 aunque la apertura lleve la 430 en una linea.
    const r26 = await informeMayorTerceros(COMPANY_ID, 'clientes', { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    expect(r26.terceros.map((t) => [t.id, t.saldoInicial, t.saldoFinal])).toEqual([[cliB, 605, 605]]);
  });

  it('detalle de un cliente con movimientos, factura y saldo acumulado', async () => {
    const d = await informeDetalleTercero(COMPANY_ID, 'clientes', { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 }, cliA);
    expect(d.tercero.movimientos.map((m) => [m.fecha, m.factura, m.debe, m.haber, m.saldo])).toEqual([
      ['2025-02-10', 'A-1', 1210, 0, 1210],
      ['2025-03-20', 'A-1', 0, 1210, 0],
    ]);
    expect(d.facturasPendientes).toHaveLength(0);
    const xlsx = XLSX.read(tablaAXlsx(d.tabla), { type: 'buffer' });
    expect(xlsx.SheetNames).toHaveLength(1);
  });

  it('mayor de proveedores: saldo acreedor y pago en el ejercicio siguiente', async () => {
    const r25 = await informeMayorTerceros(COMPANY_ID, 'proveedores', { desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 });
    expect(r25.terceros.map((t) => [t.id, t.saldoFinal])).toEqual([[prov, 363]]);
    const r26 = await informeMayorTerceros(COMPANY_ID, 'proveedores', { desde: '2026-01-01', hasta: '2026-12-31', ejercicio: 2026 });
    expect(r26.terceros.map((t) => [t.id, t.saldoInicial, t.debe, t.saldoFinal])).toEqual([[prov, 363, 363, 0]]);
  });
});
