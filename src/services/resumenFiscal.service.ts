/**
 * Resumen fiscal de un periodo a partir de las FACTURAS (no de los movimientos):
 * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
 * Incluye las mismas facturas que el 303 (ventas FINAL; ni ventas ni gastos en
 * borrador), y una rectificativa por sustitucion cuenta solo su diferencia con
 * la original (sustituidasEnRango). Pero cada factura va por su FECHA DE
 * FACTURA (fechaEmision), como pidio el usuario para el panel. El 303 no
 * siempre: un gasto va por su fecha de registro (fechaContableGasto) y una
 * venta por la de la operacion si la tiene (fechaDevengoVenta). Un gasto
 * registrado tarde, o una venta con otra fecha de operacion, puede caer aqui en
 * otro mes o trimestre que en el 303: estas cifras son orientativas.
 *
 * Es la fuente única del resumen: lo usan GET /stats/fiscal
 * (movements.controller), Carmen (INT-09) y el panel (panel.service, con los
 * mismos filtros: whereVentasResumen, whereGastosResumen y
 * sustituidasEnRango). Solo lee.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { GASTO_VIGENTE } from '../domain/factura-gasto.model';
import { aCentimos } from '../utils/money';

export interface TotalesFacturas {
  facturas: number;
  base: number;
  iva: number;
  retencion: number;
  total: number;
}

export interface ResumenFiscalPeriodo {
  desde: string;
  hasta: string;
  ventas: TotalesFacturas;
  gastos: TotalesFacturas;
  /** Orientativo: el 303 real puede ajustar IVA no deducible, prorrata o compensaciones. */
  ivaResultado: number;
  /** Retenciones que la empresa practica en sus gastos (modelo 111/115). */
  retencionesAIngresar: number;
}

const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

/** Solo las facturas de un cliente (ventas) o de un proveedor (gastos). */
export interface FiltroTercero {
  customerId?: string;
  supplierId?: string;
}

/** Fechas AAAA-MM-DD incluidas. Sin ellas, de cualquier fecha. */
export interface RangoFechas {
  desde: string;
  hasta: string;
}

/**
 * Ventas que cuentan en el resumen: emitidas (FINAL: ni borradores ni
 * proformas) y no en DRAFT, de la app o registradas con el lector, por su
 * fecha de factura. Las rectificativas van con su signo.
 */
export function whereVentasResumen(companyId: string, rango?: RangoFechas, customerId?: string): Prisma.IncomeInvoiceWhereInput {
  return {
    companyId,
    estadoDocumento: 'FINAL',
    estado: { not: 'DRAFT' },
    ...(rango ? { fechaEmision: { gte: rango.desde, lte: rango.hasta } } : {}),
    ...(customerId ? { customerId } : {}),
  };
}

/**
 * Gastos que cuentan en el resumen: facturas de gasto vigentes (sin borradores
 * del lector ni anuladas), por su fecha de factura. Los abonos van en negativo.
 */
export function whereGastosResumen(companyId: string, rango?: RangoFechas, supplierId?: string): Prisma.ExpenseInvoiceWhereInput {
  return {
    companyId,
    ...GASTO_VIGENTE,
    ...(rango ? { fechaEmision: { gte: rango.desde, lte: rango.hasta } } : {}),
    ...(supplierId ? { supplierId } : {}),
  };
}

/** Factura original sustituida por una rectificativa por sustitucion (S) del rango. */
export interface Sustituida {
  /** Id de la original. */
  id: string;
  /** Fecha de la rectificativa S (AAAA-MM-DD): la original se resta en ese periodo. */
  fecha: string;
  /** Cliente de la original. */
  customerId: string;
  /** Importes de la original, en la moneda de cuenta. */
  base: number;
  iva: number;
  retencion: number;
  total: number;
}

/**
 * Originales de las rectificativas por sustitucion (S) que cuentan en el rango.
 *
 * Una S lleva la factura corregida ENTERA y la original sigue contando en su
 * fecha: sumadas las dos, la venta contaria dos veces. Por eso, en el periodo
 * de la S se resta la original y queda solo la diferencia (la S de 1.200 que
 * sustituye a una de 1.000 suma 200). Es el criterio que aplican al 303 y al
 * asiento las rectificativas de venta (diferenciaSustitucion, rama
 * rectificativas-venta); hasta que se publique, el 303 aun suma la S entera.
 * Solo las originales de la app que el resumen cuenta (emitidas, no en
 * borrador); con `customerId`, las de ese cliente. Pocas filas: las S son raras.
 */
export async function sustituidasEnRango(companyId: string, rango?: RangoFechas, customerId?: string): Promise<Sustituida[]> {
  const sustituciones = await prisma.incomeInvoice.findMany({
    where: { ...whereVentasResumen(companyId, rango), esRectificativa: true, tipoRectificativa: 'S', facturaOriginalId: { not: null } },
    select: { fechaEmision: true, facturaOriginalId: true },
  });
  if (!sustituciones.length) return [];
  const originales = await prisma.incomeInvoice.findMany({
    where: { ...whereVentasResumen(companyId, undefined, customerId), id: { in: [...new Set(sustituciones.map((s) => s.facturaOriginalId as string))] } },
    select: { id: true, customerId: true, baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true },
  });
  const porId = new Map(originales.map((o) => [o.id, o]));
  const out: Sustituida[] = [];
  for (const s of sustituciones) {
    const o = porId.get(s.facturaOriginalId as string);
    if (!o) continue;
    out.push({ id: o.id, fecha: s.fechaEmision, customerId: o.customerId, base: n(o.baseTotal), iva: n(o.ivaTotal), retencion: n(o.retencionTotal), total: n(o.totalFactura) });
  }
  return out;
}

/**
 * Fechas AAAA-MM-DD incluidas (las de factura son texto, se comparan como tal).
 * Con `filtro`, las ventas son solo las del cliente y los gastos solo los del
 * proveedor (si se filtra por uno solo, el otro lado sale a cero). Las ventas
 * descuentan las originales sustituidas por una S del periodo.
 */
export async function resumenFiscalPeriodo(companyId: string, desde: string, hasta: string, filtro?: FiltroTercero): Promise<ResumenFiscalPeriodo> {
  const rango = { desde, hasta };
  const suma = { baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } as const;
  // Con un filtro por cliente no hay gastos que mirar (ni ventas con uno por proveedor).
  const sinVentas = !!filtro && !filtro.customerId;
  const sinGastos = !!filtro && !filtro.supplierId;
  const vacio = { _sum: { baseTotal: 0, ivaTotal: 0, retencionTotal: 0, totalFactura: 0 }, _count: 0 };
  const [ventas, gastos, sustituidas] = await Promise.all([
    sinVentas
      ? Promise.resolve(vacio)
      : prisma.incomeInvoice.aggregate({
          where: whereVentasResumen(companyId, rango, filtro?.customerId),
          _sum: suma,
          _count: true,
        }),
    sinGastos
      ? Promise.resolve(vacio)
      : prisma.expenseInvoice.aggregate({
          where: whereGastosResumen(companyId, rango, filtro?.supplierId),
          _sum: suma,
          _count: true,
        }),
    sinVentas ? Promise.resolve([] as Sustituida[]) : sustituidasEnRango(companyId, rango, filtro?.customerId),
  ]);
  const totales = (a: typeof ventas): TotalesFacturas => ({
    facturas: a._count,
    base: n(a._sum.baseTotal),
    iva: n(a._sum.ivaTotal),
    retencion: n(a._sum.retencionTotal),
    total: n(a._sum.totalFactura),
  });
  // Cada S cuenta solo su diferencia con la original (en centimos, sin arrastrar decimales).
  const menos = (a: number, campo: 'base' | 'iva' | 'retencion' | 'total') =>
    (aCentimos(a) - sustituidas.reduce((t, x) => t + aCentimos(x[campo]), 0)) / 100;
  const vb = totales(ventas);
  const v: TotalesFacturas = { ...vb, base: menos(vb.base, 'base'), iva: menos(vb.iva, 'iva'), retencion: menos(vb.retencion, 'retencion'), total: menos(vb.total, 'total') };
  const g = totales(gastos);
  return { desde, hasta, ventas: v, gastos: g, ivaResultado: n(v.iva - g.iva), retencionesAIngresar: g.retencion };
}
