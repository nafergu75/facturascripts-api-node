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
import { diferenciaSustitucion } from '../domain/rectificativa-venta.model';
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
 * Ventas del periodo como las cuenta el 303: emitidas, por la fecha de su
 * devengo (fechaDevengoVenta), y una rectificativa por sustitucion con la
 * original en la app, por su diferencia (diferenciaSustitucion), en el periodo
 * de la S. Con `customerId`, las de ese cliente (la S va siempre a nombre del
 * cliente de su original). La misma lista para el resumen, los meses y los
 * clientes del panel: asi cuadran.
 *
 * Las lineas solo se leen de las S con la original en la app (son pocas).
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
  const originales = await originalesDeSustituciones(companyId, delPeriodo);
  const lineasDe = new Map<string, Array<{ tipoIva: number; accountCode: string | null; baseLine: number; ivaImporte: number; retencionImporte: number }>>();
  if (originales.size) {
    const lineas = await prisma.incomeInvoiceLine.findMany({
      where: { invoiceId: { in: [...originales.keys()] } },
      select: { invoiceId: true, tipoIva: true, accountCode: true, baseLine: true, ivaImporte: true, retencionImporte: true },
    });
    for (const l of lineas) {
      const de = lineasDe.get(l.invoiceId) ?? [];
      de.push({ tipoIva: l.tipoIva, accountCode: l.accountCode, baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte), retencionImporte: Number(l.retencionImporte) });
      lineasDe.set(l.invoiceId, de);
    }
  }
  return delPeriodo.map((f) => {
    const o = originales.get(f.id);
    const d = o ? diferenciaSustitucion(lineasImportesDe({ lineas: lineasDe.get(f.id) ?? [] }), lineasImportesDe(o)) : null;
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
