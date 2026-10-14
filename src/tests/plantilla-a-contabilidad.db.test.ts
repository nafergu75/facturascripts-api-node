/**
 * Plantilla A en la contabilidad y los impuestos, sobre BD real. El IEEPNR va
 * DENTRO de la base de la linea: entra solo en el asiento, el libro de
 * expedidas, el 303, el 390, el 347, el 349, el resumen fiscal y el panel.
 *
 *  - Asiento de NZ004_26 (cliente ficticio): 430 al Debe por 8.654,68; al
 *    Haber, la 70x de cada linea por 7.152,63 (una linea a la 701) y la 477 por
 *    1.502,05.
 *  - Con la cuenta del IEEPNR 4758 en los ajustes: 70x 6.974,88 y 4758 177,75.
 *  - Libro de expedidas, 303 del 1T, 390, 347, 349 (entrega intracomunitaria
 *    con IEEPNR), resumen fiscal y panel.
 *  - La cuenta del IEEPNR se congela en la factura al emitirla: cambiar los
 *    ajustes despues no cambia su asiento ni el de su anulacion.
 *  - El panel no cuenta como ingreso el IEEPNR que va a una cuenta 47.
 *
 * Pasa tambien con connection_limit=1 (como en produccion).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { calcularModelo303, calcularModelo347, calcularModelo349, calcularModelo390 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { resumenFiscalPeriodo } from '../services/resumenFiscal.service';
import { ingresosPorClientePanel, periodoPanel, porMesPanel, resumenPanel } from '../services/panel.service';
import { aCentimos } from '../utils/money';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';

const SUFIJO = Date.now();
const ES = `plantilla-a-conta-${SUFIJO}`;
const EC = `plantilla-a-conta-4758-${SUFIJO}`;
const EI = `plantilla-a-conta-intra-${SUFIJO}`;
/** Para cambiar la cuenta del IEEPNR entre emitir y anular. */
const EF = `plantilla-a-conta-cambio-${SUFIJO}`;
const motor = new AccountingEngineController();
const clientes: Record<string, string> = {};

/** Las lineas de NZ004_26; la primera, a la 701. */
const lineasNz = (): CrearLineaIngresoDTO[] =>
  LINEAS_NZ004.map((l, i) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: l.packs,
    cantidad: l.cantidad,
    kgPlastico: l.kgPlastico,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    ...(i === 0 ? { cuenta: '701' } : {}),
  }));

async function empresa(id: string, nifCliente: string, paisCliente = 'ES') {
  await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'BEBIDAS PRUEBA SL', nif: 'B12345674' } });
  await asegurarPlanContableEmpresa(id);
  clientes[id] = (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'CLIENTE FICTICIO BEBIDAS SL', nifCif: nifCliente, pais: paisCliente, provincia: 'VALENCIA', cp: '46000' } })).id;
  await guardarAjustesFacturacion(id, 'u-test', { ieepnrRepercute: true });
}

const emitir = (companyId: string, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: clientes[companyId] }, fechaEmision: '2026-03-04', lineas: lineasNz(), ...extra } as never);

/** Debe y haber (en centimos) por cuenta; la del cliente, como «430N». */
async function asiento(companyId: string, invoiceId: string) {
  const r = await motor.contabilizarFacturaIngreso(companyId, invoiceId);
  const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: r.journalEntryId } });
  const por: Record<string, [number, number]> = {};
  for (const l of lineas) {
    const c = l.accountCode.startsWith('43') ? '430N' : l.accountCode;
    const [d, h] = por[c] ?? [0, 0];
    por[c] = [d + aCentimos(Number(l.debe)), h + aCentimos(Number(l.haber))];
  }
  return por;
}

let ventaId = '';

beforeAll(async () => {
  await empresa(ES, '00000000T');
  await empresa(EC, '00000000T');
  await empresa(EI, 'FR12345678901', 'FR');
  // La cuenta del IEEPNR de EC (contribuyente): 4758, en su plan.
  await prisma.chartOfAccounts.create({ data: { companyId: EC, codigo: '4758', nombre: 'HP acreedora por IEEPNR', grupo: 4, nivel: 4, naturaleza: 'PASIVO', tipoUso: 'BALANCE' } });
  await guardarAjustesFacturacion(EC, 'u-test', { ieepnrCuenta: '4758' });
  await empresa(EF, '00000000T');
  await prisma.chartOfAccounts.create({ data: { companyId: EF, codigo: '4758', nombre: 'HP acreedora por IEEPNR', grupo: 4, nivel: 4, naturaleza: 'PASIVO', tipoUso: 'BALANCE' } });
  ventaId = (await emitir(ES)).id;
});

describe('asiento', () => {
  it('430 al Debe 8.654,68; 70x al Haber 7.152,63 (una linea a la 701); 477 al Haber 1.502,05', async () => {
    const por = await asiento(ES, ventaId);
    expect(por).toEqual({
      '430N': [865468, 0],
      '701': [0, 54405],
      '700': [0, 660858],
      '477': [0, 150205],
    });
    expect(por['701'][1] + por['700'][1]).toBe(aCentimos(TOTALES_NZ004.base));
  });

  it('con la cuenta del IEEPNR (4758): 70x 6.974,88 y 4758 177,75', async () => {
    const f = await emitir(EC);
    const por = await asiento(EC, f.id);
    expect(por).toEqual({
      '430N': [865468, 0],
      '701': [0, 49766],
      '700': [0, 647722],
      '4758': [0, 17775],
      '477': [0, 150205],
    });
    expect(por['701'][1] + por['700'][1]).toBe(aCentimos(TOTALES_NZ004.articulos));
  });

  it('con la cuenta del IEEPNR y sin cuentas en las lineas: la 700 y la 4758', async () => {
    const f = await emitir(EC, { lineas: lineasNz().map(({ cuenta: _c, ...l }) => l) });
    expect(await asiento(EC, f.id)).toEqual({ '430N': [865468, 0], '700': [0, 697488], '4758': [0, 17775], '477': [0, 150205] });
  });

  it('una rectificativa por sustitucion con la cuenta del IEEPNR: la diferencia tambien se separa', async () => {
    const o = await emitir(EC);
    await asiento(EC, o.id);
    const corregidas = lineasNz();
    corregidas[0] = { ...corregidas[0], kgPlastico: 100 };
    const s = await incomeInvoicesService.crearIngreso({
      companyId: EC,
      customer: {},
      lineas: corregidas,
      rectificativa: { ticket: false, forma: 'S', motivo: 'ERROR', explicacion: 'Kg de plástico mal puestos', originales: [{ id: o.id }] },
    } as never);
    // Solo cambia el IEEPNR de la primera linea: 45,00 en vez de 46,39 (-1,39), y el IVA por tipo -0,29.
    expect(await asiento(EC, s.id)).toEqual({ '430N': [-168, 0], '4758': [0, -139], '477': [0, -29] });
  });
});

describe('libro de expedidas e impuestos', () => {
  it('libro de expedidas: base 7.152,63 y cuota 1.502,05', async () => {
    const libro = await prisma.vATBook.findMany({ where: { companyId: ES } });
    expect(libro.map((l) => [l.tipoIva, Number(l.baseImponible), Number(l.cuotaIva)])).toEqual([[21, 7152.63, 1502.05]]);
  });

  it('303 del 1T de 2026: base y cuota al 21 %', async () => {
    const m = await calcularModelo303(ES, periodoFiscal(2026, '1T'));
    expect(m.ivaDevengado.find((d) => d.tipo === 21)).toEqual({ tipo: 21, base: 7152.63, cuota: 1502.05 });
    expect([m.totalBaseDevengada, m.totalCuotaDevengada]).toEqual([7152.63, 1502.05]);
  });

  it('390 de 2026', async () => {
    const m = await calcularModelo390(ES, 2026);
    expect(m.resumenDevengado.find((d) => d.tipo === 21)).toEqual({ tipo: 21, base: 7152.63, cuota: 1502.05 });
    expect(m.volumenOperaciones).toBe(7152.63);
  });

  it('347 de 2026: 8.654,68 del cliente', async () => {
    const m = await calcularModelo347(ES, 2026);
    expect(m.operaciones.map((o) => [o.cifnif, o.tipo, o.baseAnual])).toEqual([['00000000T', 'cliente', 8654.68]]);
  });

  it('349: una entrega intracomunitaria con la plantilla A lleva el IEEPNR en su base', async () => {
    const f = await emitir(EI, { tipoOperacion: 'INTRACOMUNITARIA', lineas: lineasNz().map((l) => ({ ...l, tipoIva: 0 })) });
    expect([f.baseTotal, f.ivaTotal, f.resumenEnvases?.ieepnr]).toEqual([7152.63, 0, 177.75]);
    await asiento(EI, f.id);
    const m = await calcularModelo349(EI, periodoFiscal(2026, '1T'));
    expect(m.operaciones).toEqual([{ cifnif: 'FR12345678901', nombre: 'CLIENTE FICTICIO BEBIDAS SL', clave: 'E', base: 7152.63 }]);
  });

  it('resumen fiscal y panel: la base lleva el IEEPNR', async () => {
    const r = await resumenFiscalPeriodo(ES, '2026-01-01', '2026-03-31');
    expect([r.ventas.base, r.ventas.iva, r.ventas.total, r.ventas.ieepnrHacienda]).toEqual([7152.63, 1502.05, 8654.68, 0]);
    const p = await resumenPanel(ES, periodoPanel({ anio: 2026 }), { incluirNominas: false });
    expect(p.totalIncome).toBe(7152.63);
  });

  it('panel con la cuenta del IEEPNR de Hacienda (4758): el IEEPNR no cuenta como ingreso; el resumen fiscal sigue con la base', async () => {
    // EC: tres NZ004_26 y una S que baja el IEEPNR 1,39, todas con la 4758.
    const r = await resumenFiscalPeriodo(EC, '2026-01-01', '2026-12-31');
    expect([r.ventas.base, r.ventas.ieepnrHacienda]).toEqual([21456.5, 531.86]);
    const periodo = periodoPanel({ anio: 2026 });
    const p = await resumenPanel(EC, periodo, { incluirNominas: false });
    // Lo mismo que suman las 70x de sus asientos: 3 × 6.974,88.
    expect(p.totalIncome).toBe(20924.64);
    const meses = await porMesPanel(EC, periodo, { incluirNominas: false });
    expect(Math.round(meses.reduce((a, m) => a + m.income * 100, 0)) / 100).toBe(20924.64);
    expect((await ingresosPorClientePanel(EC, periodo)).map((c) => c.total)).toEqual([20924.64]);
  });
});

describe('la cuenta del IEEPNR se congela al emitir', () => {
  it('emitida sin cuenta y anulada con la 4758 ya puesta: la anulacion va a las 70x, como la original', async () => {
    const o = await emitir(EF);
    await asiento(EF, o.id);
    await guardarAjustesFacturacion(EF, 'u-test', { ieepnrCuenta: '4758' });
    const r = await incomeInvoicesService.crearRectificativa(EF, o.id, { motivo: 'Anulación' });
    expect(await asiento(EF, r.id)).toEqual({ '430N': [-865468, 0], '701': [0, -54405], '700': [0, -660858], '477': [0, -150205] });
    const fila = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: o.id } });
    expect(fila.ieepnrCuenta).toBeNull();
  });

  it('emitida con la 4758 y anulada sin ella: la anulacion devuelve el IEEPNR a la 4758', async () => {
    const o = await emitir(EF);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: o.id } })).ieepnrCuenta).toBe('4758');
    await guardarAjustesFacturacion(EF, 'u-test', { ieepnrCuenta: null });
    // La original, contabilizada despues del cambio, sigue con la 4758.
    expect(await asiento(EF, o.id)).toMatchObject({ '4758': [0, 17775] });
    const r = await incomeInvoicesService.crearRectificativa(EF, o.id, { motivo: 'Anulación' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.id } })).ieepnrCuenta).toBe('4758');
    expect(await asiento(EF, r.id)).toEqual({ '430N': [-865468, 0], '701': [0, -49766], '700': [0, -647722], '4758': [0, -17775], '477': [0, -150205] });
  });

  it('un borrador toma la cuenta de los ajustes al emitirse, no la de cuando se guardo', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: EF, customer: { id: clientes[EF] }, fechaEmision: '2026-03-04', borrador: true, lineas: lineasNz() } as never);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).ieepnrCuenta).toBeNull();
    await guardarAjustesFacturacion(EF, 'u-test', { ieepnrCuenta: '4758' });
    const f = await incomeInvoicesService.finalizar(EF, b.id, { fechaEmision: '2026-03-04' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } })).ieepnrCuenta).toBe('4758');
    expect(await asiento(EF, f.id)).toMatchObject({ '4758': [0, 17775] });
    await guardarAjustesFacturacion(EF, 'u-test', { ieepnrCuenta: null });
  });
});
