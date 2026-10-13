/**
 * Panel del resumen sacado de las FACTURAS y las NOMINAS (panel.service), por
 * la API de /movements/stats: antes leia solo la tabla Movement («Nuevo
 * movimiento») y una factura de venta registrada no salia en las graficas.
 *
 * Cubre: ventas emitidas y leidas, rectificativas que restan, borradores,
 * proformas y DRAFT fuera; gastos con abonos, sin borradores ni anuladas;
 * nominas contabilizadas como gasto de personal (coste para la empresa);
 * venta en otra moneda (cuenta su importe en la moneda de cuenta); que cuadra
 * con «IVA y retenciones del año»; permisos; y dos empresas aisladas.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { app as appReal } from '../app';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import movementsRoutes from '../routes/movements.routes';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { anioEspana } from '../utils/fechas';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E1 = `panel-a-${SUF}`;
const E2 = `panel-b-${SUF}`;
const EMAIL = `panel-${SUF}@test.local`;

/** App con un usuario de prueba que tiene `permisos` en `empresa`. */
function app(permisos: string[], empresa = E1) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = {
      userId: 'u-panel',
      email: 'u@test.local',
      roles: ['x'],
      companies: [empresa],
      rolesPorEmpresa: { [empresa]: ['x'] },
      permisosPorEmpresa: { [empresa]: permisos },
    } as never;
    req.companyId = empresa;
    next();
  });
  a.use('/movements', movementsRoutes);
  a.use(errorMiddleware);
  return a;
}
const CONTABLE = ['contabilidad:read'];
const get = (ruta: string, permisos = CONTABLE, empresa = E1) => request(app(permisos, empresa)).get(`/movements${ruta}`);
const datos = (r: request.Response) => r.body.data;

const ids: Record<string, string> = {};
let numero = 0;

async function venta(
  clave: string,
  d: {
    empresa?: string;
    customerId: string;
    fecha: string;
    base: number;
    estado?: string;
    estadoDocumento?: string;
    serie?: string;
    origen?: string;
    moneda?: { codigo: string; tipoCambio: number; baseDoc: number };
    rectificaA?: string;
  },
) {
  const iva = Math.round(d.base * 21) / 100;
  const n = ++numero;
  const serie = d.serie ?? 'A';
  const sinNumero = d.estadoDocumento === 'BORRADOR';
  const f = await prisma.incomeInvoice.create({
    data: {
      companyId: d.empresa ?? E1,
      customerId: d.customerId,
      serie,
      numero: sinNumero ? null : n,
      numeroCompleto: sinNumero ? null : `${serie}-${n}`,
      estadoDocumento: d.estadoDocumento ?? 'FINAL',
      estado: d.estado ?? 'PENDING',
      fechaEmision: d.fecha,
      fechaVencimiento: d.fecha,
      origen: d.origen ?? 'pantalla',
      baseTotal: d.base,
      ivaTotal: iva,
      totalFactura: d.base + iva,
      ...(d.moneda
        ? {
            moneda: d.moneda.codigo,
            tipoCambio: d.moneda.tipoCambio,
            baseTotalDoc: d.moneda.baseDoc,
            ivaTotalDoc: Math.round(d.moneda.baseDoc * 21) / 100,
            totalFacturaDoc: d.moneda.baseDoc + Math.round(d.moneda.baseDoc * 21) / 100,
          }
        : {}),
      ...(d.rectificaA ? { esRectificativa: true, facturaOriginalId: ids[d.rectificaA], tipoRectificativa: 'I', tipoFactura: 'R1' } : {}),
      lineas: { create: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: d.base, baseLine: d.base, tipoIva: 21, ivaImporte: iva, accountCode: '705' }] },
    },
  });
  ids[clave] = f.id;
}

async function gasto(
  clave: string,
  d: {
    empresa?: string;
    supplierId: string;
    fecha: string;
    base: number;
    tipoGasto?: string;
    estado?: string;
    lineas?: Array<{ cuenta: string | null; base: number }>;
    abono?: boolean;
  },
) {
  const iva = Math.round(d.base * 21) / 100;
  const n = ++numero;
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: d.empresa ?? E1,
      supplierId: d.supplierId,
      serie: 'G',
      numero: n,
      numeroCompleto: `G-${n}`,
      numeroFacturaProveedor: `P-${n}`,
      fechaEmision: d.fecha,
      fechaVencimiento: d.fecha,
      estado: d.estado ?? 'ACCOUNTED',
      tipoGasto: d.tipoGasto ?? 'SUMINISTROS',
      baseTotal: d.base,
      ivaTotal: iva,
      totalFactura: d.base + iva,
      ...(d.abono ? { esRectificativa: true, tipoRectificativa: 'I', causaRectificacion: 'DESCUENTO' } : {}),
      lineas: {
        create: (d.lineas ?? []).map((l) => ({
          descripcion: 'Concepto',
          cantidad: 1,
          precioUnitario: l.base,
          baseLine: l.base,
          tipoIva: 21,
          ivaImporte: Math.round(l.base * 21) / 100,
          accountCode: l.cuenta,
        })),
      },
    },
  });
  ids[clave] = f.id;
}

async function nomina(
  empresa: string,
  empleadoId: string,
  d: { mes: number; estado: string; tipo?: string; bruto: number; ssEmpresa: number; indemnizacionSujeta?: number; ingresoACuenta?: number; repercutido?: boolean },
) {
  const fecha = `2026-${String(d.mes).padStart(2, '0')}-28`;
  await prisma.nomina.create({
    data: {
      companyId: empresa,
      empleadoId,
      ejercicio: 2026,
      mes: d.mes,
      tipo: d.tipo ?? 'ORDINARIA',
      fechaDevengo: fecha,
      fechaPago: fecha,
      brutoDinerario: d.bruto,
      ssEmpresa: d.ssEmpresa,
      indemnizacionSujeta: d.indemnizacionSujeta ?? 0,
      ingresoACuenta: d.ingresoACuenta ?? 0,
      ingresoACuentaRepercutido: d.repercutido ?? false,
      ssTrabajador: Math.round(d.bruto * 6.35) / 100,
      estado: d.estado,
    },
  });
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E1, name: 'Panel A SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.company.create({ data: { id: E2, name: 'Panel B Inc', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E1, denominacion: 'Panel A SL', nif: 'B70000001' } });
  // La segunda es una empresa de EE. UU.: su moneda de cuenta es el dólar.
  await prisma.legalConfig.create({ data: { companyId: E2, denominacion: 'Panel B Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });

  const alfa = await prisma.customer.create({ data: { companyId: E1, nombreFiscal: 'Alfa SL', nifCif: 'B11111111' } });
  const beta = await prisma.customer.create({ data: { companyId: E1, nombreFiscal: 'Beta SL', nifCif: 'B22222222' } });
  const luz = await prisma.supplier.create({ data: { companyId: E1, nombreFiscal: 'Luz SA', nifCif: 'A33333333' } });
  const gestoria = await prisma.supplier.create({ data: { companyId: E1, nombreFiscal: 'Gestoría López', nifCif: 'B44444444' } });

  // Ventas de 2026 que cuentan: 1000 + 500 + 2000 - 200 = 3300 (4 facturas).
  await venta('v1', { customerId: alfa.id, fecha: '2026-01-15', base: 1000 });
  await venta('v2', { customerId: beta.id, fecha: '2026-02-10', base: 500, estado: 'PAID', origen: 'lector' });
  // En dólares: cuenta su importe en euros (la moneda de cuenta), no los 2298 USD.
  await venta('v3', { customerId: beta.id, fecha: '2026-02-20', base: 2000, moneda: { codigo: 'USD', tipoCambio: 1.149, baseDoc: 2298 } });
  await venta('r1', { customerId: alfa.id, fecha: '2026-03-05', base: -200, serie: 'R', rectificaA: 'v1' });
  // No cuentan: borrador, proforma, DRAFT y una del año anterior.
  await venta('borrador', { customerId: alfa.id, fecha: '2026-01-20', base: 999, estadoDocumento: 'BORRADOR', estado: 'DRAFT' });
  await venta('proforma', { customerId: alfa.id, fecha: '2026-01-21', base: 888, estadoDocumento: 'PROFORMA', estado: 'PENDIENTE', serie: 'P' });
  await venta('draft', { customerId: alfa.id, fecha: '2026-01-22', base: 777, estado: 'DRAFT' });
  await venta('v2025', { customerId: alfa.id, fecha: '2025-12-31', base: 300 });

  // Gastos de 2026 que cuentan: 100 + 400 + 50 + 80 - 30 = 600 (5 facturas).
  await gasto('g1', { supplierId: luz.id, fecha: '2026-01-10', base: 100, lineas: [{ cuenta: '628', base: 100 }], estado: 'CONFIRMED' });
  // Una línea sin cuenta va a la del tipo de gasto (623 en profesionales).
  await gasto('g2', { supplierId: gestoria.id, fecha: '2026-02-15', base: 400, tipoGasto: 'SERVICIO_PROFESIONAL', lineas: [{ cuenta: '623', base: 300 }, { cuenta: null, base: 100 }] });
  // Factura antigua sin líneas: toda a la cuenta de su tipo (628).
  await gasto('g3', { supplierId: luz.id, fecha: '2026-03-01', base: 50 });
  // Subcuenta propia: va con su cuenta de 3 cifras (629).
  await gasto('g4', { supplierId: luz.id, fecha: '2026-03-10', base: 80, lineas: [{ cuenta: '6290001', base: 80 }] });
  await gasto('a1', { supplierId: luz.id, fecha: '2026-03-20', base: -30, lineas: [{ cuenta: '628', base: -30 }], abono: true });
  // No cuentan: sin revisar del lector, anulada y del año anterior.
  await gasto('gDraft', { supplierId: gestoria.id, fecha: '2026-01-05', base: 999, estado: 'DRAFT', lineas: [{ cuenta: '628', base: 999 }] });
  await gasto('gAnulada', { supplierId: gestoria.id, fecha: '2026-01-06', base: 555, estado: 'ANULADA', lineas: [{ cuenta: '628', base: 555 }] });
  await gasto('g2025', { supplierId: luz.id, fecha: '2025-06-01', base: 70, lineas: [{ cuenta: '628', base: 70 }] });

  // Nóminas: cuentan las contabilizadas y las pagadas, por su coste para la empresa.
  const ana = await prisma.empleado.create({ data: { companyId: E1, nif: '00000000T', nombre: 'Ana' } });
  const luis = await prisma.empleado.create({ data: { companyId: E1, nif: '00000001R', nombre: 'Luis' } });
  await nomina(E1, ana.id, { mes: 1, estado: 'CONTABILIZADA', bruto: 2000, ssEmpresa: 600 }); // 2600
  // Con indemnización y el ingreso a cuenta que asume la empresa: 2000 + 600 + 100 + 50 = 2750.
  await nomina(E1, ana.id, { mes: 2, estado: 'PAGADA', bruto: 2000, ssEmpresa: 600, indemnizacionSujeta: 100, ingresoACuenta: 50 });
  // Ingreso a cuenta que se descuenta al trabajador: no es coste. 1000 + 300 = 1300.
  await nomina(E1, luis.id, { mes: 2, estado: 'CONTABILIZADA', bruto: 1000, ssEmpresa: 300, ingresoACuenta: 40, repercutido: true });
  // No cuentan: en borrador y anulada.
  await nomina(E1, ana.id, { mes: 3, estado: 'BORRADOR', bruto: 9999, ssEmpresa: 3000 });
  await nomina(E1, ana.id, { mes: 3, tipo: 'EXTRA', estado: 'ANULADA', bruto: 8888, ssEmpresa: 2000 });

  // Movimientos manuales antiguos: ya no cuentan, pero el resumen dice cuántos hay.
  for (const [type, amount] of [['income', 50000], ['expense', 40000]] as const) {
    await prisma.movement.create({ data: { companyId: E1, type, amount, category: 'otros', description: 'Manual', date: new Date('2026-02-01T00:00:00Z'), fiscalYear: 2026 } });
  }

  // La otra empresa, con lo suyo.
  const gamma = await prisma.customer.create({ data: { companyId: E2, nombreFiscal: 'Gamma LLC', nifCif: 'US-1' } });
  const delta = await prisma.supplier.create({ data: { companyId: E2, nombreFiscal: 'Delta LLC', nifCif: 'US-2' } });
  await venta('e2v', { empresa: E2, customerId: gamma.id, fecha: '2026-02-11', base: 1234 });
  await gasto('e2g', { empresa: E2, supplierId: delta.id, fecha: '2026-02-12', base: 321, lineas: [{ cuenta: '628', base: 321 }] });
  const zoe = await prisma.empleado.create({ data: { companyId: E2, nif: '00000002W', nombre: 'Zoe' } });
  await nomina(E2, zoe.id, { mes: 2, estado: 'CONTABILIZADA', bruto: 5000, ssEmpresa: 1500 });
}, 120_000);

afterAll(async () => {
  const empresas = { companyId: { in: [E1, E2] } };
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.nomina.deleteMany({ where: empresas });
  await prisma.empleado.deleteMany({ where: empresas });
  await prisma.incomeInvoice.deleteMany({ where: { ...empresas, esRectificativa: true } });
  await prisma.incomeInvoice.deleteMany({ where: empresas });
  await prisma.expenseInvoice.deleteMany({ where: empresas });
  await prisma.customer.deleteMany({ where: empresas });
  await prisma.supplier.deleteMany({ where: empresas });
  await prisma.legalConfig.deleteMany({ where: empresas });
  await prisma.company.deleteMany({ where: { id: { in: [E1, E2] } } });
});

describe('resumen (GET /stats/summary)', () => {
  it('ingresos y gastos del año salen de las facturas y las nóminas, no de los movimientos manuales', async () => {
    const r = await get('/stats/summary?anio=2026');
    expect(r.status).toBe(200);
    expect(datos(r)).toMatchObject({
      totalIncome: 3300,
      totalExpense: 7250, // 600 de facturas + 6650 de nóminas
      balance: -3950,
      totalMovements: 9,
      facturasVenta: 4,
      facturasGasto: 5,
      gastoFacturas: 600,
      gastoPersonal: 6650,
      nominas: 3,
      nominasIncluidas: true,
      movimientosManuales: 2,
      monedaCuenta: 'EUR',
      periodo: { anio: 2026, trimestre: null, mes: null, desde: '2026-01-01', hasta: '2026-12-31' },
    });
  });

  it('cuadra con «IVA y retenciones del año» (misma suma de ventas y de facturas de gasto)', async () => {
    const [panel, fiscal] = await Promise.all([get('/stats/summary?anio=2026'), get('/stats/fiscal?anio=2026')]);
    expect(datos(panel).totalIncome).toBe(datos(fiscal).ventas.base);
    expect(datos(panel).facturasVenta).toBe(datos(fiscal).ventas.facturas);
    expect(datos(panel).gastoFacturas).toBe(datos(fiscal).gastos.base);
    expect(datos(panel).facturasGasto).toBe(datos(fiscal).gastos.facturas);
  });

  it('«IVA y retenciones» admite el mismo trimestre o mes que el panel y cuadra con él', async () => {
    const [panel, fiscal] = await Promise.all([get('/stats/summary?anio=2026&mes=2'), get('/stats/fiscal?anio=2026&mes=2')]);
    expect(fiscal.status).toBe(200);
    expect(datos(fiscal).periodo).toEqual({ anio: 2026, trimestre: null, mes: 2, desde: '2026-02-01', hasta: '2026-02-28' });
    expect(datos(fiscal).ventas).toMatchObject({ base: datos(panel).totalIncome, facturas: 2 });
    expect(datos(fiscal).gastos).toMatchObject({ base: datos(panel).gastoFacturas, facturas: 1 });
    expect(datos(await get('/stats/fiscal?anio=2026&trimestre=2')).periodo).toMatchObject({ trimestre: 2, desde: '2026-04-01', hasta: '2026-06-30' });
    expect((await get('/stats/fiscal?anio=2026&trimestre=5')).status).toBe(400);
  });

  it('filtra por año, trimestre y mes', async () => {
    expect(datos(await get('/stats/summary?anio=2025'))).toMatchObject({ totalIncome: 300, gastoFacturas: 70, gastoPersonal: 0, facturasVenta: 1, facturasGasto: 1 });
    expect(datos(await get('/stats/summary?anio=2026&trimestre=1'))).toMatchObject({ totalIncome: 3300, totalExpense: 7250 });
    expect(datos(await get('/stats/summary?anio=2026&trimestre=2'))).toMatchObject({ totalIncome: 0, totalExpense: 0, totalMovements: 0 });
    expect(datos(await get('/stats/summary?anio=2026&mes=2'))).toMatchObject({
      totalIncome: 2500,
      totalExpense: 4450,
      gastoFacturas: 400,
      gastoPersonal: 4050,
      nominas: 2,
      periodo: { mes: 2, desde: '2026-02-01', hasta: '2026-02-28' },
    });
  });

  it('sin año, el año en curso en España', async () => {
    expect(datos(await get('/stats/summary')).periodo.anio).toBe(anioEspana());
  });

  it('un periodo que no vale da 400 con un texto para la persona', async () => {
    const r1 = await get('/stats/summary?anio=2026&trimestre=5');
    expect(r1.status).toBe(400);
    expect(r1.body.error?.message ?? r1.body.message).toMatch(/trimestre/);
    expect((await get('/stats/by-month?anio=2026&mes=13')).status).toBe(400);
    expect((await get('/stats/by-category?anio=2026&trimestre=1&mes=2')).status).toBe(400);
    expect((await get('/stats/summary?anio=20270')).status).toBe(400);
    expect((await get('/stats/ultimas-facturas?limit=0')).status).toBe(400);
  });
});

describe('por meses (GET /stats/by-month)', () => {
  it('los doce meses del año, con ventas, facturas de gasto y nóminas de cada uno', async () => {
    const filas = datos(await get('/stats/by-month?anio=2026')) as Array<Record<string, unknown>>;
    expect(filas.map((f) => f.month)).toEqual(Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`));
    expect(filas[0]).toMatchObject({ income: 1000, expense: 2700, balance: -1700, facturasVenta: 1, facturasGasto: 1, gastoFacturas: 100, gastoPersonal: 2600, nominas: 1 });
    expect(filas[1]).toMatchObject({ income: 2500, expense: 4450, facturasVenta: 2, facturasGasto: 1, gastoPersonal: 4050, nominas: 2 });
    // Marzo: la rectificativa resta y el abono también.
    expect(filas[2]).toMatchObject({ income: -200, expense: 100, facturasVenta: 1, facturasGasto: 3, gastoPersonal: 0 });
    expect(filas.slice(3).every((f) => f.income === 0 && f.expense === 0)).toBe(true);
    // La suma de los meses es la del resumen.
    const suma = (k: string) => Math.round(filas.reduce((a, f) => a + (f[k] as number), 0) * 100) / 100;
    expect(suma('income')).toBe(3300);
    expect(suma('expense')).toBe(7250);
  });

  it('con un trimestre, solo sus tres meses', async () => {
    const filas = datos(await get('/stats/by-month?anio=2026&trimestre=1')) as Array<{ month: string }>;
    expect(filas.map((f) => f.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('gastos por categoría (GET /stats/by-category)', () => {
  it('por cuenta de gasto de 3 cifras con su nombre, y las nóminas en «Personal»', async () => {
    const filas = datos(await get('/stats/by-category?anio=2026')) as Array<{ category: string; expense: number; percentage: number; cuenta: string | null; clave: string }>;
    expect(filas.map((f) => [f.clave, f.expense])).toEqual([
      ['personal', 6650],
      ['cuenta:623', 400], // 300 con cuenta + 100 de la línea sin cuenta
      ['cuenta:628', 120], // 100 + 50 (sin líneas) - 30 (abono)
      ['cuenta:629', 80], // la subcuenta 6290001
    ]);
    expect(filas[0]).toMatchObject({ category: 'Personal', cuenta: null });
    expect(filas.find((f) => f.cuenta === '628')?.category).toBe('Suministros');
    expect(filas.find((f) => f.cuenta === '623')?.category).toBe('Servicios de profesionales independientes');
    // El total es el de los gastos del resumen y los porcentajes suman 100.
    expect(Math.round(filas.reduce((a, f) => a + f.expense, 0) * 100) / 100).toBe(7250);
    expect(Math.round(filas.reduce((a, f) => a + f.percentage, 0))).toBe(100);
  });

  it('con un mes, solo lo de ese mes', async () => {
    const filas = datos(await get('/stats/by-category?anio=2026&mes=1')) as Array<{ clave: string; expense: number }>;
    expect(filas.map((f) => [f.clave, f.expense])).toEqual([
      ['personal', 2600],
      ['cuenta:628', 100],
    ]);
  });
});

describe('análisis de ingresos y de gastos', () => {
  it('ventas por cliente, con las rectificativas restadas', async () => {
    const filas = datos(await get('/stats/ingresos-por-cliente?anio=2026')) as Array<Record<string, unknown>>;
    expect(filas.map((f) => [f.name, f.total, f.facturas])).toEqual([
      ['Beta SL', 2500, 2],
      ['Alfa SL', 800, 2],
    ]);
    expect(filas[0]).toMatchObject({ nif: 'B22222222', letter: 'B' });
    const enero = datos(await get('/stats/ingresos-por-cliente?anio=2026&mes=1')) as Array<Record<string, unknown>>;
    expect(enero.map((f) => [f.name, f.total])).toEqual([['Alfa SL', 1000]]);
  });

  it('gastos por proveedor, con las nóminas aparte', async () => {
    const filas = datos(await get('/stats/gastos-por-proveedor?anio=2026')) as Array<Record<string, unknown>>;
    expect(filas.map((f) => [f.id === null ? null : 'proveedor', f.name, f.total, f.facturas])).toEqual([
      [null, 'Personal (nóminas)', 6650, 3],
      ['proveedor', 'Gestoría López', 400, 1],
      ['proveedor', 'Luz SA', 200, 4],
    ]);
  });
});

describe('últimas facturas (GET /stats/ultimas-facturas)', () => {
  it('ventas y gastos juntos, de la más reciente a la más antigua, sin borradores ni anuladas', async () => {
    const filas = datos(await get('/stats/ultimas-facturas?limit=15')) as Array<Record<string, unknown>>;
    expect(filas.map((f) => f.facturaId)).toEqual([
      ids.a1,
      ids.g4,
      ids.r1,
      ids.g3,
      ids.v3,
      ids.g2,
      ids.v2,
      ids.v1,
      ids.g1,
      ids.v2025,
      ids.g2025,
    ]);
    const v1 = filas.find((f) => f.facturaId === ids.v1)!;
    expect(v1).toMatchObject({
      id: ids.v1,
      tipo: 'venta',
      type: 'income',
      date: '2026-01-15',
      numero: expect.stringMatching(/^A-\d+$/),
      tercero: 'Alfa SL',
      description: 'Alfa SL',
      category: 'Ventas',
      base: 1000,
      total: 1210,
      amount: '1000.00',
      status: 'approved',
      enlace: `/dashboard/facturas/${ids.v1}`,
    });
    expect(filas.find((f) => f.facturaId === ids.v2)).toMatchObject({ estado: 'Cobrada' });
    expect(filas.find((f) => f.facturaId === ids.r1)).toMatchObject({ base: -200, amount: '-200.00', rectificativa: true, estado: 'Rectificativa' });
    expect(filas.find((f) => f.facturaId === ids.g2)).toMatchObject({
      tipo: 'gasto',
      type: 'expense',
      numero: expect.stringMatching(/^P-\d+$/),
      tercero: 'Gestoría López',
      category: 'Profesionales independientes',
      base: 400,
      enlace: `/dashboard/compras/${ids.g2}`,
    });
    expect(filas.find((f) => f.facturaId === ids.a1)).toMatchObject({ base: -30, estado: 'Abono' });
  });

  it('respeta el límite (15 por defecto) y el año', async () => {
    expect((datos(await get('/stats/ultimas-facturas?limit=3')) as unknown[]).length).toBe(3);
    expect((datos(await get('/stats/ultimas-facturas')) as unknown[]).length).toBe(11);
    const de2025 = datos(await get('/stats/ultimas-facturas?anio=2025')) as Array<{ facturaId: string }>;
    expect(de2025.map((f) => f.facturaId)).toEqual([ids.v2025, ids.g2025]);
  });

  it('GET /movements sigue listando los movimientos manuales', async () => {
    const filas = datos(await get('/?limit=15')) as Array<{ description: string }>;
    expect(filas).toHaveLength(2);
    expect(filas.every((f) => f.description === 'Manual')).toBe(true);
  });
});

describe('permisos', () => {
  it('con solo Tesorería, el panel sale sin el coste de las nóminas y lo dice', async () => {
    const T = ['tesoreria:read'];
    expect(datos(await get('/stats/summary?anio=2026', T))).toMatchObject({ totalIncome: 3300, totalExpense: 600, gastoPersonal: 0, nominas: 0, nominasIncluidas: false });
    const meses = datos(await get('/stats/by-month?anio=2026', T)) as Array<{ expense: number; gastoPersonal: number }>;
    expect(meses[0]).toMatchObject({ expense: 100, gastoPersonal: 0 });
    const categorias = datos(await get('/stats/by-category?anio=2026', T)) as Array<{ clave: string }>;
    expect(categorias.some((c) => c.clave === 'personal')).toBe(false);
    const proveedores = datos(await get('/stats/gastos-por-proveedor?anio=2026', T)) as Array<{ id: string | null }>;
    expect(proveedores.some((p) => p.id === null)).toBe(false);
  });

  it('con Nóminas además de Tesorería, sí lo ve', async () => {
    expect(datos(await get('/stats/summary?anio=2026', ['tesoreria:read', 'nominas:read']))).toMatchObject({ gastoPersonal: 6650, nominasIncluidas: true });
  });

  it('sin Contabilidad ni Tesorería, 403 (como hasta ahora)', async () => {
    for (const ruta of ['/stats/summary', '/stats/by-month', '/stats/by-category', '/stats/ingresos-por-cliente', '/stats/gastos-por-proveedor', '/stats/ultimas-facturas']) {
      expect((await get(ruta, ['ventas:read'])).status).toBe(403);
      expect((await get(ruta, ['nominas:read'])).status).toBe(403);
    }
  });
});

describe('dos empresas', () => {
  it('cada una ve solo lo suyo, en su moneda de cuenta', async () => {
    expect(datos(await get('/stats/summary?anio=2026', CONTABLE, E2))).toMatchObject({
      totalIncome: 1234,
      totalExpense: 6821, // 321 + 5000 + 1500
      facturasVenta: 1,
      facturasGasto: 1,
      gastoPersonal: 6500,
      movimientosManuales: 0,
      monedaCuenta: 'USD',
    });
    const clientes = datos(await get('/stats/ingresos-por-cliente?anio=2026', CONTABLE, E2)) as Array<{ name: string }>;
    expect(clientes.map((c) => c.name)).toEqual(['Gamma LLC']);
    const ultimas = datos(await get('/stats/ultimas-facturas', CONTABLE, E2)) as Array<{ facturaId: string }>;
    expect(ultimas.map((f) => f.facturaId).sort()).toEqual([ids.e2v, ids.e2g].sort());
    // Y la primera no ve nada de la segunda.
    expect(datos(await get('/stats/summary?anio=2026')).totalIncome).toBe(3300);
  });

  it('un usuario de una empresa no lee el panel de la otra', async () => {
    const u = await prisma.user.create({ data: { email: EMAIL, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
    await prisma.membership.create({ data: { userId: u.id, companyId: E1, role: 'contable' } });
    const token = authService.generateToken({ userId: u.id, email: EMAIL, roles: [], companies: [] });
    const propia = await request(appReal).get(`/companies/${E1}/movements/stats/summary?anio=2026`).set('Authorization', `Bearer ${token}`);
    expect(propia.status).toBe(200);
    expect(propia.body.data.totalIncome).toBe(3300);
    const ajena = await request(appReal).get(`/companies/${E2}/movements/stats/summary?anio=2026`).set('Authorization', `Bearer ${token}`);
    expect([403, 404]).toContain(ajena.status);
  });
});
