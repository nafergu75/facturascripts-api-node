/**
 * Correcciones del panel del resumen tras la revision:
 *  - una rectificativa por sustitucion (S) lleva la factura corregida entera:
 *    en el panel, en «IVA y retenciones» y en Carmen cuenta solo su
 *    diferencia con la original (antes la venta contaba dos veces);
 *  - las ventas van por su devengo, como en el 303: una con fecha de la
 *    operacion cuenta en ese mes en el resumen, los meses y los clientes;
 *  - estados de «Ultimas facturas»: venta cobrada en parte, abonos y
 *    sustituciones como en «Cobros de clientes», y rectificativas
 *    que no bajan;
 *  - el trimestre y el mes solo admiten cifras;
 *  - con solo Ventas se leen las ventas por cliente (y nada mas del panel).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import movementsRoutes from '../routes/movements.routes';
import { resumenFiscalPeriodo } from '../services/resumenFiscal.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { facturasPorCobrar } from '../services/cobrosClientes.service';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E1 = `panelc-${SUF}`;

function app(permisos: string[]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = {
      userId: 'u-panelc',
      email: 'u@test.local',
      roles: ['x'],
      companies: [E1],
      rolesPorEmpresa: { [E1]: ['x'] },
      permisosPorEmpresa: { [E1]: permisos },
    } as never;
    req.companyId = E1;
    next();
  });
  a.use('/movements', movementsRoutes);
  a.use(errorMiddleware);
  return a;
}
const get = (ruta: string, permisos = ['contabilidad:read']) => request(app(permisos)).get(`/movements${ruta}`);
const datos = (r: request.Response) => r.body.data;

const ids: Record<string, string> = {};
const clientes: Record<string, string> = {};
let numero = 0;

async function venta(
  clave: string,
  d: { cliente: string; fecha: string; base: number; estado?: string; vence?: string; operacion?: string; rectifica?: { original: string; tipo: 'S' | 'I' } },
) {
  const iva = Math.round(d.base * 21) / 100;
  const n = ++numero;
  const serie = d.rectifica ? 'R' : 'A';
  const f = await prisma.incomeInvoice.create({
    data: {
      companyId: E1,
      customerId: clientes[d.cliente],
      serie,
      numero: n,
      numeroCompleto: `${serie}-${n}`,
      estadoDocumento: 'FINAL',
      estado: d.estado ?? 'PENDING',
      fechaEmision: d.fecha,
      ...(d.operacion ? { fechaOperacion: d.operacion } : {}),
      fechaVencimiento: d.vence ?? '2099-12-31',
      baseTotal: d.base,
      ivaTotal: iva,
      totalFactura: d.base + iva,
      ...(d.rectifica
        ? { esRectificativa: true, facturaOriginalId: ids[d.rectifica.original], tipoRectificativa: d.rectifica.tipo, tipoFactura: 'R1', motivoRectificacion: 'Precio' }
        : {}),
      lineas: { create: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: d.base, baseLine: d.base, tipoIva: 21, ivaImporte: iva, accountCode: '705' }] },
    },
  });
  ids[clave] = f.id;
}

async function cobro(clave: string, importe: number) {
  await prisma.invoicePayment.create({
    data: { companyId: E1, invoiceType: 'INGRESO', invoiceId: ids[clave], fecha: '2026-05-02', importe, cuentaTesoreria: '5720001' },
  });
}

async function gasto(clave: string, d: { supplierId: string; fecha: string; base: number; rectificativa?: boolean }) {
  const iva = Math.round(d.base * 21) / 100;
  const n = ++numero;
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: E1,
      supplierId: d.supplierId,
      serie: 'G',
      numero: n,
      numeroCompleto: `G-${n}`,
      fechaEmision: d.fecha,
      fechaVencimiento: '2099-12-31',
      estado: 'ACCOUNTED',
      tipoGasto: 'SUMINISTROS',
      baseTotal: d.base,
      ivaTotal: iva,
      totalFactura: d.base + iva,
      ...(d.rectificativa ? { esRectificativa: true, tipoRectificativa: 'I', causaRectificacion: 'CAMBIO_PRECIO' } : {}),
      lineas: { create: [{ descripcion: 'Concepto', cantidad: 1, precioUnitario: d.base, baseLine: d.base, tipoIva: 21, ivaImporte: iva, accountCode: '628' }] },
    },
  });
  ids[clave] = f.id;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E1, name: 'Panel C SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E1, denominacion: 'Panel C SL', nif: 'B70000002' } });
  for (const [clave, nombre, nif] of [
    ['alfa', 'Alfa SL', 'B11111111'],
    ['beta', 'Beta SL', 'B22222222'],
    ['gamma', 'Gamma SL', 'B33333333'],
  ]) {
    clientes[clave] = (await prisma.customer.create({ data: { companyId: E1, nombreFiscal: nombre, nifCif: nif } })).id;
  }
  const luz = await prisma.supplier.create({ data: { companyId: E1, nombreFiscal: 'Luz SA', nifCif: 'A44444444' } });

  // Alfa: factura de 1.000 en enero sustituida en marzo por otra de 1.200 (S).
  await venta('o1', { cliente: 'alfa', fecha: '2026-01-10', base: 1000 });
  await venta('s1', { cliente: 'alfa', fecha: '2026-03-15', base: 1200, rectifica: { original: 'o1', tipo: 'S' } });
  // Beta: 2.000 en febrero sustituida en abril (otro trimestre) por una de 1.500 (la S va siempre
  // a nombre del cliente de su original: ORIGINAL_DE_OTRO_CLIENTE).
  await venta('o2', { cliente: 'beta', fecha: '2026-02-05', base: 2000 });
  await venta('s2', { cliente: 'beta', fecha: '2026-04-20', base: 1500, rectifica: { original: 'o2', tipo: 'S' } });
  // Estados: cobrada en parte, cobrada entera con sus cobros, vencida en parte y rectificativa al alza (I).
  await venta('parte', { cliente: 'gamma', fecha: '2026-05-01', base: 100 });
  await cobro('parte', 50);
  await venta('entera', { cliente: 'gamma', fecha: '2026-05-02', base: 100 });
  await cobro('entera', 121);
  await venta('vencida', { cliente: 'gamma', fecha: '2026-05-03', base: 100, vence: '2026-05-10' });
  await cobro('vencida', 20);
  await venta('alza', { cliente: 'gamma', fecha: '2026-05-04', base: 10, rectifica: { original: 'parte', tipo: 'I' } });
  // Gastos: rectificativa al alza (no es un abono) y abono.
  await gasto('gAlza', { supplierId: luz.id, fecha: '2026-05-05', base: 40, rectificativa: true });
  await gasto('gAbono', { supplierId: luz.id, fecha: '2026-05-06', base: -15, rectificativa: true });
}, 120_000);

afterAll(async () => {
  await prisma.invoicePayment.deleteMany({ where: { companyId: E1 } });
  await prisma.incomeInvoice.deleteMany({ where: { companyId: E1, esRectificativa: true } });
  await prisma.incomeInvoice.deleteMany({ where: { companyId: E1 } });
  await prisma.expenseInvoice.deleteMany({ where: { companyId: E1 } });
  await prisma.customer.deleteMany({ where: { companyId: E1 } });
  await prisma.supplier.deleteMany({ where: { companyId: E1 } });
  await prisma.legalConfig.deleteMany({ where: { companyId: E1 } });
  await prisma.company.deleteMany({ where: { id: E1 } });
});

// Ventas del año sin sustituciones: 1000 + 1200 + 2000 + 1500 + 100 + 100 + 100 + 10 = 6010.
// Con la regla: se restan las dos originales sustituidas (1000 y 2000): 3010.
describe('rectificativa por sustitución (S): cuenta solo su diferencia', () => {
  it('el año: la S de 1.200 sobre una de 1.000 suma 200, y la de 1.500 sobre 2.000 resta 500', async () => {
    const r = datos(await get('/stats/summary?anio=2026'));
    expect(r).toMatchObject({ totalIncome: 3010, facturasVenta: 8 });
  });

  it('cada S resta su original en su propio periodo, aunque la original sea de otro trimestre', async () => {
    expect(datos(await get('/stats/summary?anio=2026&trimestre=1')).totalIncome).toBe(3200); // 1000 + 2000 + (1200 - 1000)
    expect(datos(await get('/stats/summary?anio=2026&trimestre=2')).totalIncome).toBe(-190); // (1500 - 2000) + 310
    const meses = datos(await get('/stats/by-month?anio=2026')) as Array<{ month: string; income: number }>;
    expect(meses.slice(0, 5).map((m) => m.income)).toEqual([1000, 2000, 200, -500, 310]);
  });

  it('«IVA y retenciones» y Carmen (resumenFiscalPeriodo) restan también la base, el IVA y el total de la original', async () => {
    const f = datos(await get('/stats/fiscal?anio=2026&trimestre=1'));
    expect(f.ventas).toMatchObject({ facturas: 3, base: 3200, iva: 672, total: 3872 });
    expect(f.ivaResultado).toBe(672);
    // Con un cliente: su original y la S, que cuenta por la diferencia.
    const alfa = await resumenFiscalPeriodo(E1, '2026-01-01', '2026-12-31', { customerId: clientes.alfa });
    expect(alfa.ventas).toMatchObject({ facturas: 2, base: 1200, iva: 252 });
    const beta = await resumenFiscalPeriodo(E1, '2026-01-01', '2026-12-31', { customerId: clientes.beta });
    expect(beta.ventas).toMatchObject({ facturas: 2, base: 1500, iva: 315 });
  });

  it('por cliente: la S cuenta su diferencia con la original, en el periodo de la S', async () => {
    const filas = datos(await get('/stats/ingresos-por-cliente?anio=2026')) as Array<{ name: string; total: number; facturas: number }>;
    expect(filas.map((f) => [f.name, f.total, f.facturas])).toEqual([
      ['Beta SL', 1500, 2], // 2000 + (1500 - 2000)
      ['Alfa SL', 1200, 2], // 1000 + (1200 - 1000)
      ['Gamma SL', 310, 4], // 100 + 100 + 100 + 10
    ]);
    // En el trimestre de la S, sin la original en el periodo: Beta sale en negativo.
    const t2 = datos(await get('/stats/ingresos-por-cliente?anio=2026&trimestre=2')) as Array<{ name: string; total: number; facturas: number }>;
    expect(t2.map((f) => [f.name, f.total, f.facturas])).toEqual([
      ['Gamma SL', 310, 4],
      ['Beta SL', -500, 1],
    ]);
  });

  it('el resumen de ingresos por periodo (GET /invoices/income/resumen/periodo) también cuenta la S por su diferencia', async () => {
    const r = await incomeInvoicesService.resumenPorPeriodo(E1, '2026-01-01', '2026-12-31');
    // 1000 + (1200 - 1000) + 2000 + (1500 - 2000) + 100 + 100 + 100 + 10; IVA al 21 %.
    expect(r).toMatchObject({ totalFacturas: 8, basePendiente: 3010, ivaTotal: 632.1 });
  });
});

describe('venta con fecha de la operación: cuenta en su devengo, como en el 303', () => {
  it('el resumen, los meses, los clientes y «IVA y retenciones» la ponen en el mes de la operación', async () => {
    // Emitida el 2 de julio por una operación del 20 de junio (otro año, para no tocar las cifras de 2026).
    await venta('operacion', { cliente: 'alfa', fecha: '2025-07-02', base: 500, operacion: '2025-06-20' });
    expect(datos(await get('/stats/summary?anio=2025&trimestre=2'))).toMatchObject({ totalIncome: 500, facturasVenta: 1 });
    expect(datos(await get('/stats/summary?anio=2025&trimestre=3'))).toMatchObject({ totalIncome: 0, facturasVenta: 0 });
    const meses = datos(await get('/stats/by-month?anio=2025')) as Array<{ month: string; income: number; facturasVenta: number }>;
    expect(meses.find((m) => m.month === '2025-06')).toMatchObject({ income: 500, facturasVenta: 1 });
    expect(meses.find((m) => m.month === '2025-07')).toMatchObject({ income: 0, facturasVenta: 0 });
    const t2 = datos(await get('/stats/ingresos-por-cliente?anio=2025&trimestre=2')) as Array<{ name: string; total: number; facturas: number }>;
    expect(t2.map((f) => [f.name, f.total, f.facturas])).toEqual([['Alfa SL', 500, 1]]);
    expect(datos(await get('/stats/fiscal?anio=2025&trimestre=2')).ventas).toMatchObject({ facturas: 1, base: 500, iva: 105 });
  });
});

describe('estados de «Últimas facturas»', () => {
  it('venta cobrada en parte, cobrada con sus cobros, vencida, sustituida y rectificativas que no bajan', async () => {
    // Una pendiente sin cobros (cliente que ya tiene ventas: no cambia el número de clientes).
    await venta('pendiente', { cliente: 'gamma', fecha: '2026-06-01', base: 30 });
    const filas = datos(await get('/stats/ultimas-facturas?limit=50&anio=2026')) as Array<{ facturaId: string; estado: string }>;
    const estado = (clave: string) => filas.find((f) => f.facturaId === ids[clave])?.estado;
    expect(estado('parte')).toBe('Cobrada en parte');
    expect(estado('entera')).toBe('Cobrada');
    expect(estado('vencida')).toBe('Vencida');
    expect(estado('pendiente')).toBe('Pendiente de cobro');
    // Las originales de una S: la sustituta ocupa su lugar.
    expect(estado('o1')).toBe('Sustituida');
    expect(estado('o2')).toBe('Sustituida');
    // Rectificativas de venta con total positivo (por sustitución y al alza): se cobran, como en «Cobros de clientes».
    expect(estado('s1')).toBe('Pendiente de cobro');
    expect(estado('alza')).toBe('Pendiente de cobro');
    // En gastos, «Abono» solo si baja; la que sube es «Rectificativa».
    expect(estado('gAlza')).toBe('Rectificativa');
    expect(estado('gAbono')).toBe('Abono');
  });

  it('con abonos y sustituciones dice lo mismo que «Cobros de clientes» y la ficha', async () => {
    // Anulada entera por un abono, sin cobros: nada pendiente.
    await venta('anulada', { cliente: 'gamma', fecha: '2026-06-02', base: 200, vence: '2026-06-10' });
    await venta('abonoAnula', { cliente: 'gamma', fecha: '2026-06-03', base: -200, rectifica: { original: 'anulada', tipo: 'I' } });
    // Cobrada entera, anulada después y devuelto el dinero al cliente.
    await venta('devuelta', { cliente: 'gamma', fecha: '2026-06-04', base: 80 });
    await cobro('devuelta', 96.8);
    await venta('abonoDevuelto', { cliente: 'gamma', fecha: '2026-06-05', base: -80, rectifica: { original: 'devuelta', tipo: 'I' } });
    await cobro('abonoDevuelto', -96.8);
    // Rebajada a la mitad por un abono y cobrada por el resto.
    await venta('rebajada', { cliente: 'gamma', fecha: '2026-06-06', base: 100, vence: '2026-06-10' });
    await venta('abonoRebaja', { cliente: 'gamma', fecha: '2026-06-07', base: -50, rectifica: { original: 'rebajada', tipo: 'I' } });
    await cobro('rebajada', 60.5);
    // Cobrada en parte (50 de 121) y sustituida por una de 181,50: lo cobrado pasa a la S.
    await venta('o3', { cliente: 'gamma', fecha: '2026-06-08', base: 100 });
    await cobro('o3', 50);
    await venta('s3', { cliente: 'gamma', fecha: '2026-06-09', base: 150, rectifica: { original: 'o3', tipo: 'S' } });

    const filas = datos(await get('/stats/ultimas-facturas?limit=50&anio=2026')) as Array<{ facturaId: string; estado: string }>;
    const estado = (clave: string) => filas.find((f) => f.facturaId === ids[clave])?.estado;
    expect(estado('anulada')).toBe('Anulada');
    expect(estado('devuelta')).toBe('Anulada');
    expect(estado('rebajada')).toBe('Cobrada');
    expect(estado('o3')).toBe('Sustituida');
    expect(estado('s3')).toBe('Cobrada en parte');
    // Los abonos no se cobran: restan de lo que rectifican.
    for (const abono of ['abonoAnula', 'abonoDevuelto', 'abonoRebaja']) expect(`${abono}: ${estado(abono)}`).toBe(`${abono}: Rectificativa`);

    // La cartera: de estas, solo la S tiene algo pendiente (181,50 - 50).
    const cartera = await facturasPorCobrar(E1);
    const nuevas = ['anulada', 'devuelta', 'rebajada', 'o3', 's3'].map((c) => ids[c]);
    expect(cartera.facturas.filter((f) => nuevas.includes(f.id)).map((f) => [f.id, f.pendiente])).toEqual([[ids.s3, 131.5]]);
    // La ficha de la anulada sin cobros dice lo mismo.
    expect((await incomeInvoicesService.obtenerPorId(E1, ids.anulada)).anuladaPorCompleto).toBe(true);
  });
});

describe('periodo: el trimestre y el mes solo con cifras', () => {
  it('rechaza «1e1», «2.0», « 3» y «10.5»; admite «02»', async () => {
    for (const q of ['mes=1e1', 'mes=2.0', 'mes=%203', 'mes=10.5', 'trimestre=1.0', 'trimestre=1e0', 'trimestre=%202']) {
      const r = await get(`/stats/summary?anio=2026&${q}`);
      expect(`${q}: ${r.status}`).toBe(`${q}: 400`);
    }
    expect(datos(await get('/stats/summary?anio=2026&mes=02')).periodo).toMatchObject({ mes: 2, desde: '2026-02-01', hasta: '2026-02-28' });
    expect((await get('/stats/fiscal?anio=2026&mes=1e1')).status).toBe(400);
  });
});

describe('con solo Ventas', () => {
  it('lee las ventas por cliente, y nada más del panel', async () => {
    const V = ['ventas:read'];
    const r = await get('/stats/ingresos-por-cliente?anio=2026', V);
    expect(r.status).toBe(200);
    expect((datos(r) as unknown[]).length).toBe(3);
    for (const ruta of ['/stats/summary', '/stats/by-month', '/stats/by-category', '/stats/fiscal', '/stats/gastos-por-proveedor', '/stats/ultimas-facturas']) {
      expect(`${ruta}: ${(await get(ruta, V)).status}`).toBe(`${ruta}: 403`);
    }
  });
});
