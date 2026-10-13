/**
 * Resumen fiscal de un periodo a partir de las FACTURAS (no de los movimientos):
 * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
 * Mismo criterio que el 303: ventas FINAL y ni ventas ni gastos en borrador;
 * las ventas por su devengo y, una rectificativa por sustitucion, por su
 * diferencia con la original (la factura corregida entera contaba dos veces).
 *
 * Es la fuente única del resumen: lo usan GET /stats/fiscal
 * (movements.controller) y Carmen (INT-09). Solo lee.
 */
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

/**
 * Ventas del periodo como las cuenta el 303: emitidas, por la fecha de su
 * devengo (fechaDevengoVenta), y una rectificativa por sustitucion con la
 * original en la app, por su diferencia (diferenciaSustitucion). Misma forma
 * que el aggregate de los gastos.
 */
async function ventasDelPeriodo(companyId: string, desde: string, hasta: string, customerId?: string) {
  const filas = await prisma.incomeInvoice.findMany({
    where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, ...ventasQuePuedenDevengarseEntre(desde, hasta), ...(customerId ? { customerId } : {}) },
    select: {
      id: true,
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
      lineas: { select: { tipoIva: true, accountCode: true, baseLine: true, ivaImporte: true, retencionImporte: true } },
    },
  });
  const delPeriodo = filas.filter((f) => {
    const d = fechaDevengoVenta(f);
    return d >= desde && d <= hasta;
  });
  const originales = await originalesDeSustituciones(companyId, delPeriodo);
  const c = { base: 0, iva: 0, retencion: 0, total: 0 };
  for (const f of delPeriodo) {
    const o = originales.get(f.id);
    const d = o ? diferenciaSustitucion(lineasImportesDe(f), lineasImportesDe(o)) : null;
    c.base += aCentimos(d ? d.base : Number(f.baseTotal));
    c.iva += aCentimos(d ? d.cuota : Number(f.ivaTotal));
    c.retencion += aCentimos(d ? d.retencion : Number(f.retencionTotal));
    c.total += aCentimos(d ? d.total : Number(f.totalFactura));
  }
  return { _sum: { baseTotal: c.base / 100, ivaTotal: c.iva / 100, retencionTotal: c.retencion / 100, totalFactura: c.total / 100 }, _count: delPeriodo.length };
}

/**
 * Fechas AAAA-MM-DD incluidas (las de factura son texto, se comparan como tal).
 * Con `filtro`, las ventas son solo las del cliente y los gastos solo los del
 * proveedor (si se filtra por uno solo, el otro lado sale a cero).
 */
export async function resumenFiscalPeriodo(companyId: string, desde: string, hasta: string, filtro?: FiltroTercero): Promise<ResumenFiscalPeriodo> {
  const fechas = { gte: desde, lte: hasta };
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
          where: { companyId, ...GASTO_VIGENTE, fechaEmision: fechas, ...(filtro?.supplierId ? { supplierId: filtro.supplierId } : {}) },
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
