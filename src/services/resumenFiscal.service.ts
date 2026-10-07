/**
 * Resumen fiscal de un periodo a partir de las FACTURAS (no de los movimientos):
 * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
 * Mismo criterio que el 303: ventas FINAL y ni ventas ni gastos en borrador.
 *
 * Es la fuente única del resumen: lo usan GET /stats/fiscal
 * (movements.controller) y Carmen (INT-09). Solo lee.
 */
import { prisma } from '../config/database';

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
    sinVentas
      ? Promise.resolve(vacio)
      : prisma.incomeInvoice.aggregate({
          where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, fechaEmision: fechas, ...(filtro?.customerId ? { customerId: filtro.customerId } : {}) },
          _sum: suma,
          _count: true,
        }),
    sinGastos
      ? Promise.resolve(vacio)
      : prisma.expenseInvoice.aggregate({
          where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: fechas, ...(filtro?.supplierId ? { supplierId: filtro.supplierId } : {}) },
          _sum: suma,
          _count: true,
        }),
  ]);
  const totales = (a: typeof ventas): TotalesFacturas => ({
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
