/**
 * Panel sin las compras de inmovilizado (decisión del usuario, 13-10-2026):
 * las líneas de la cuenta 2xx no cuentan como gasto en el resumen, los meses,
 * las categorías ni los proveedores; el bloque «IVA y retenciones» (GET
 * /stats/fiscal) las sigue llevando, con su IVA soportado, y dice cuánto es
 * inmovilizado. Carmen (INT-09) da la misma cifra que el panel.
 *
 * Las facturas se crean con prisma: Compras aún no deja poner una cuenta 2xx
 * en una línea.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import movementsRoutes from '../routes/movements.routes';
import { construirContexto } from '../services/carmen/contexto';
import { intencionPorId } from '../services/carmen/intenciones/catalogo';
import { resolverCodigoPeriodo } from '../services/carmen/huecos/periodo';
import type { AuthUser } from '../types/express';
import type { RespuestaDatos } from '../services/carmen/tipos';

const SUF = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `panel-inmov-${SUF}`;

function app(permisos: string[]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-panel', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: permisos } } as never;
    req.companyId = E;
    next();
  });
  a.use('/movements', movementsRoutes);
  a.use(errorMiddleware);
  return a;
}
const get = async (ruta: string) => (await request(app(['contabilidad:read'])).get(`/movements${ruta}`)).body.data;

const ids: Record<string, string> = {};
let numero = 0;

/** Factura de gasto con sus líneas (cuenta y base), IVA al 21 %. */
async function gasto(clave: string, d: { supplierId: string; fecha: string; lineas: Array<{ cuenta: string | null; base: number }>; base?: number; abono?: boolean }) {
  const base = d.base ?? d.lineas.reduce((s, l) => s + l.base, 0);
  const iva = Math.round(base * 21) / 100;
  const n = ++numero;
  const f = await prisma.expenseInvoice.create({
    data: {
      companyId: E,
      supplierId: d.supplierId,
      serie: 'G',
      numero: n,
      numeroCompleto: `G-${n}`,
      numeroFacturaProveedor: `P-${n}`,
      fechaEmision: d.fecha,
      fechaVencimiento: d.fecha,
      estado: 'ACCOUNTED',
      tipoGasto: 'SUMINISTROS',
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      ...(d.abono ? { esRectificativa: true, tipoRectificativa: 'I', causaRectificacion: 'DESCUENTO' } : {}),
      lineas: {
        create: d.lineas.map((l) => ({
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

let luz = '';
let maquinas = '';
beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Panel Inmovilizado SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Panel Inmovilizado SL', nif: 'B70000002' } });
  luz = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Luz SA', nifCif: 'A33333334' } })).id;
  maquinas = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Máquinas Levante SL', nifCif: 'B55555556' } })).id;
  // Febrero: 100 de suministros (629) y 1.000 de un ordenador (217) en la misma factura; una máquina de 2.000 (solo 217).
  await gasto('mixta', { supplierId: luz, fecha: '2026-02-10', lineas: [{ cuenta: '629', base: 100 }, { cuenta: '217', base: 1000 }] });
  await gasto('maquina', { supplierId: maquinas, fecha: '2026-02-20', lineas: [{ cuenta: '217', base: 2000 }] });
  // Marzo: un abono de 500 de la máquina (217) y una factura sin líneas (va a la cuenta de su tipo).
  await gasto('abono', { supplierId: maquinas, fecha: '2026-03-15', lineas: [{ cuenta: '217', base: -500 }], abono: true });
  await gasto('sinLineas', { supplierId: luz, fecha: '2026-03-20', lineas: [], base: 300 });
});

describe('panel sin las compras de inmovilizado', () => {
  it('GET /stats/fiscal: base e IVA con todo, y aparte lo que es inmovilizado', async () => {
    const f = await get('/stats/fiscal?anio=2026');
    expect(f.gastos).toMatchObject({ facturas: 4, base: 2900, iva: 609, baseInmovilizado: 2500, facturasSoloInmovilizado: 2, facturasConInmovilizado: 3 });
  });

  it('GET /stats/summary: los gastos sin el inmovilizado, que va aparte; las facturas que son solo inmovilizado no cuentan', async () => {
    expect(await get('/stats/summary?anio=2026')).toMatchObject({
      totalExpense: 400,
      gastoFacturas: 400,
      facturasGasto: 2,
      totalMovements: 2,
      inmovilizado: 2500,
      facturasInmovilizado: 3,
    });
  });

  it('GET /stats/by-month: cada mes sin su inmovilizado', async () => {
    const meses = (await get('/stats/by-month?anio=2026')) as Array<{ month: string; expense: number; facturasGasto: number }>;
    expect(meses.find((m) => m.month === '2026-02')).toMatchObject({ expense: 100, facturasGasto: 1 });
    expect(meses.find((m) => m.month === '2026-03')).toMatchObject({ expense: 300, facturasGasto: 1 });
  });

  it('GET /stats/by-category: sin la 217; la factura sin líneas va a la cuenta de su tipo y el total cuadra con el resumen', async () => {
    const cat = (await get('/stats/by-category?anio=2026')) as Array<{ cuenta: string | null; expense: number }>;
    expect(cat.some((c) => c.cuenta?.startsWith('2'))).toBe(false);
    expect(cat.map((c) => [c.cuenta, c.expense])).toEqual([
      ['628', 300],
      ['629', 100],
    ]);
    expect(cat.reduce((s, c) => s + c.expense, 0)).toBe(400);
  });

  it('GET /stats/gastos-por-proveedor: sin el inmovilizado; fuera el proveedor que solo vende inmovilizado', async () => {
    const prov = (await get('/stats/gastos-por-proveedor?anio=2026')) as Array<{ id: string; total: number; facturas: number }>;
    expect(prov).toEqual([expect.objectContaining({ id: luz, total: 400, facturas: 2 })]);
    expect(prov.some((p) => p.id === maquinas)).toBe(false);
  });

  it('GET /stats/ultimas-facturas: las sigue listando todas', async () => {
    const ultimas = (await get('/stats/ultimas-facturas?anio=2026')) as Array<{ facturaId: string }>;
    expect(ultimas.map((u) => u.facturaId).sort()).toEqual([ids.mixta, ids.maquina, ids.abono, ids.sinLineas].sort());
  });

  it('Carmen (INT-09) da lo gastado sin las compras de inmovilizado, como el panel', async () => {
    const usuario: AuthUser = { userId: `u-${SUF}`, roles: ['admin'], rolesPorEmpresa: { [E]: ['admin'] }, companies: [E] };
    const ctx = await construirContexto(usuario, E, '2026-10-07');
    const cifras = (x: RespuestaDatos) => {
      if (x.sinPermiso || x.sinCifras) throw new Error(`sin cifras: ${JSON.stringify(x)}`);
      return x;
    };
    const r = cifras(await intencionPorId('INT-09')!.ejecutar(ctx, { foco: 'gastos', periodo: resolverCodigoPeriodo('2026-1T', '2026-10-07')! }));
    expect(r.texto).toMatch(/^En el 1T de 2026 has gastado, sin las compras de inmovilizado, 400,00 € en 2 facturas;/);
    expect(r.tabla?.filas.map((f) => f.celdas)).toEqual([
      ['Gastos (base imponible, sin las compras de inmovilizado)', 400, 0],
      ['Compras de inmovilizado (base)', 2500, 0],
      ['IVA soportado', 609, 0],
    ]);
  });
});
