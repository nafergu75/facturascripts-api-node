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

/** Fechas AAAA-MM-DD incluidas (las de factura son texto, se comparan como tal). */
export async function resumenFiscalPeriodo(companyId: string, desde: string, hasta: string): Promise<ResumenFiscalPeriodo> {
  const fechas = { gte: desde, lte: hasta };
  const suma = { baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } as const;
  const [ventas, gastos] = await Promise.all([
    prisma.incomeInvoice.aggregate({
      where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' }, fechaEmision: fechas },
      _sum: suma,
      _count: true,
    }),
    prisma.expenseInvoice.aggregate({
      where: { companyId, estado: { not: 'DRAFT' }, fechaEmision: fechas },
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
