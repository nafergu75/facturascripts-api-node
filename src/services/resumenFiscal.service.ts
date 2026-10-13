/**
 * Resumen fiscal de un periodo a partir de las FACTURAS (no de los movimientos):
 * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
 * Incluye las mismas facturas que el 303 (ventas FINAL; ni ventas ni gastos en
 * borrador). Las ventas van como en el 303: por su devengo (fechaDevengoVenta:
 * la fecha de la operacion si la tiene; si no, la de la factura) y una
 * rectificativa por sustitucion con la original en la app, solo por su
 * diferencia con ella (diferenciaSustitucion; la factura corregida entera
 * contaba dos veces). Los gastos van por su FECHA DE FACTURA (fechaEmision),
 * como pidio el usuario para el panel; el 303 los lleva por su fecha de
 * registro (fechaContableGasto). Un gasto registrado tarde puede caer aqui en
 * otro mes o trimestre que en el 303: estas cifras son orientativas.
 *
 * Es la fuente única del resumen: lo usan GET /stats/fiscal
 * (movements.controller), Carmen (INT-09) y el panel (panel.service, con las
 * mismas ventas, ventasDelResumen, y los mismos gastos, whereGastosResumen).
 * Solo lee.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { GASTO_VIGENTE } from '../domain/factura-gasto.model';
import { fechaDevengoVenta } from '../domain/tipo-operacion.model';
import { diferenciaSustitucion, type DiferenciaSustitucion } from '../domain/rectificativa-venta.model';
import { aCentimos } from '../utils/money';
import { originalesDeSustituciones, ventasQuePuedenDevengarseEntre } from './impuestosCalculo.service';
import { lineasImportesDe } from './rectificativasVenta.service';

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
 * proformas) y no en DRAFT, de la app o registradas con el lector. Con `rango`,
 * por su fecha de factura: para listarlas («Ultimas facturas»); las sumas van
 * por su devengo (ventasDelResumen). Las rectificativas van con su signo.
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

/** Una venta tal como cuenta en el resumen y en el panel. Importes de cuenta. */
export interface VentaResumen {
  id: string;
  customerId: string;
  /** Devengo (AAAA-MM-DD): el dia, mes o trimestre en que cuenta. */
  fecha: string;
  base: number;
  iva: number;
  retencion: number;
  total: number;
}

/**
 * La diferencia con su original de cada rectificativa por sustitucion (S) de la
 * lista que tiene la original en la app, por sus lineas, como el 303
 * (diferenciaSustitucion). Las demas facturas no salen. Solo se leen las
 * lineas de esas S y de sus originales (son pocas).
 */
export async function diferenciasDeSustituciones(
  companyId: string,
  ventas: Array<{ id: string; esRectificativa: boolean; tipoRectificativa: string | null; facturaOriginalId: string | null }>,
): Promise<Map<string, DiferenciaSustitucion>> {
  const originales = await originalesDeSustituciones(companyId, ventas);
  const out = new Map<string, DiferenciaSustitucion>();
  if (!originales.size) return out;
  const lineas = await prisma.incomeInvoiceLine.findMany({
    where: { invoiceId: { in: [...originales.keys()] } },
    select: { invoiceId: true, tipoIva: true, accountCode: true, baseLine: true, ivaImporte: true, retencionImporte: true },
  });
  for (const [sId, o] of originales) {
    const deLaS = lineas.filter((l) => l.invoiceId === sId);
    out.set(sId, diferenciaSustitucion(lineasImportesDe({ lineas: deLaS }), lineasImportesDe(o)));
  }
  return out;
}

/**
 * Ventas del periodo como las cuenta el 303: emitidas, por la fecha de su
 * devengo (fechaDevengoVenta), y una rectificativa por sustitucion con la
 * original en la app, por su diferencia (diferenciaSustitucion), en el periodo
 * de la S. Con `customerId`, las de ese cliente (la S va siempre a nombre del
 * cliente de su original). La misma lista para el resumen, los meses y los
 * clientes del panel: asi cuadran.
 */
export async function ventasDelResumen(companyId: string, rango: RangoFechas, customerId?: string): Promise<VentaResumen[]> {
  const { desde, hasta } = rango;
  const filas = await prisma.incomeInvoice.findMany({
    where: { ...whereVentasResumen(companyId, undefined, customerId), ...ventasQuePuedenDevengarseEntre(desde, hasta) },
    select: {
      id: true,
      customerId: true,
      esRectificativa: true,
      tipoRectificativa: true,
      facturaOriginalId: true,
      tipoOperacion: true,
      fechaOperacion: true,
      fechaEmision: true,
      baseTotal: true,
      ivaTotal: true,
      retencionTotal: true,
      totalFactura: true,
    },
  });
  const delPeriodo = filas.map((f) => ({ ...f, fecha: fechaDevengoVenta(f) })).filter((f) => f.fecha >= desde && f.fecha <= hasta);
  const diferencias = await diferenciasDeSustituciones(companyId, delPeriodo);
  return delPeriodo.map((f) => {
    const d = diferencias.get(f.id);
    return {
      id: f.id,
      customerId: f.customerId,
      fecha: f.fecha,
      base: d ? d.base : n(f.baseTotal),
      iva: d ? d.cuota : n(f.ivaTotal),
      retencion: d ? d.retencion : n(f.retencionTotal),
      total: d ? d.total : n(f.totalFactura),
    };
  });
}

/** Las ventas del periodo sumadas, con la misma forma que el aggregate de los gastos. */
async function ventasDelPeriodo(companyId: string, desde: string, hasta: string, customerId?: string) {
  const ventas = await ventasDelResumen(companyId, { desde, hasta }, customerId);
  const c = { base: 0, iva: 0, retencion: 0, total: 0 };
  for (const v of ventas) {
    c.base += aCentimos(v.base);
    c.iva += aCentimos(v.iva);
    c.retencion += aCentimos(v.retencion);
    c.total += aCentimos(v.total);
  }
  return { _sum: { baseTotal: c.base / 100, ivaTotal: c.iva / 100, retencionTotal: c.retencion / 100, totalFactura: c.total / 100 }, _count: ventas.length };
}

/**
 * Fechas AAAA-MM-DD incluidas (las de factura son texto, se comparan como tal).
 * Con `filtro`, las ventas son solo las del cliente y los gastos solo los del
 * proveedor (si se filtra por uno solo, el otro lado sale a cero).
 */
export async function resumenFiscalPeriodo(companyId: string, desde: string, hasta: string, filtro?: FiltroTercero): Promise<ResumenFiscalPeriodo> {
  const rango = { desde, hasta };
  const suma = { baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } as const;
  // Con un filtro por cliente no hay gastos que mirar (ni ventas con uno por proveedor).
  const sinVentas = !!filtro && !filtro.customerId;
  const sinGastos = !!filtro && !filtro.supplierId;
  const vacio = { _sum: { baseTotal: 0, ivaTotal: 0, retencionTotal: 0, totalFactura: 0 }, _count: 0 };
  const [ventas, gastos] = await Promise.all([
    sinVentas ? Promise.resolve(vacio) : ventasDelPeriodo(companyId, desde, hasta, filtro?.customerId),
    sinGastos
      ? Promise.resolve(vacio)
      : prisma.expenseInvoice.aggregate({
          where: whereGastosResumen(companyId, rango, filtro?.supplierId),
          _sum: suma,
          _count: true,
        }),
  ]);
  type Suma = { _sum: { baseTotal: number | null; ivaTotal: number | null; retencionTotal: number | null; totalFactura: number | null }; _count: number };
  const totales = (a: Suma): TotalesFacturas => ({
    facturas: a._count,
    base: n(a._sum.baseTotal),
    iva: n(a._sum.ivaTotal),
    retencion: n(a._sum.retencionTotal),
    total: n(a._sum.totalFactura),
  });
  const v = totales(ventas);
  const g = totales(gastos);
  return { desde, hasta, ventas: v, gastos: g, ivaResultado: n(v.iva - g.iva), retencionesAIngresar: g.retencion };
}
