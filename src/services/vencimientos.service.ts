import { randomUUID } from 'crypto';
import { prisma } from '../config/database';
import { FacturaContable } from '../domain/factura.model';
import { Vencimiento, TipoVencimiento } from '../domain/vencimientos.model';
import { notFound } from '../utils/http-errors';

/**
 * Vencimientos PERSISTIDOS en Prisma (tabla Vencimiento). Fallback en memoria si
 * la BD no esta disponible (tests con prisma mockeado).
 */
const memoria: Vencimiento[] = [];
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const dbOk = (): boolean => typeof (prisma as { vencimiento?: { findMany?: unknown } }).vencimiento?.findMany === 'function';

type VencimientoDb = { id: string; companyId: string; facturaId: string; tipo: string; numero: number; fecha: string; importe: number; formaPago: string; estado: string; fechaLiquidacion: string | null };
const aDom = (v: VencimientoDb): Vencimiento => ({
  id: v.id,
  companyId: v.companyId,
  facturaId: v.facturaId,
  tipo: v.tipo as TipoVencimiento,
  numero: v.numero,
  fecha: v.fecha,
  importe: v.importe,
  formaPago: v.formaPago,
  estado: v.estado as Vencimiento['estado'],
  fechaLiquidacion: v.fechaLiquidacion ?? undefined,
});

/**
 * Genera los vencimientos de una factura segun la forma de pago. Si se aporta
 * `plazoDias` (FS FormaPago.plazovencimiento en dias), la fecha de vencimiento
 * es fecha factura + plazo. TODO: multi-plazo real (varias fechas por factura,
 * como Quipu) cuando el DTO de factura acepte un array de vencimientos.
 */
export function generarVencimientosDesdeFactura(
  factura: FacturaContable,
  plazoDias = 0,
): Array<{ fecha: string; importe: number; formaPago: string }> {
  let fecha = factura.fecha;
  if (plazoDias > 0 && /^\d{4}-\d{2}-\d{2}/.test(factura.fecha)) {
    const d = new Date(factura.fecha);
    d.setDate(d.getDate() + plazoDias);
    fecha = d.toISOString().slice(0, 10);
  }
  return [{ fecha, importe: round2(Math.abs(factura.totalFactura)), formaPago: factura.formaPago || 'CONTADO' }];
}

export async function crearVencimientos(
  companyId: string,
  facturaId: string,
  tipo: TipoVencimiento,
  items: Array<{ fecha: string; importe: number; formaPago: string }>,
): Promise<Vencimiento[]> {
  const creados: Vencimiento[] = [];
  let numero = 1;
  for (const it of items) {
    const base = {
      companyId,
      facturaId,
      tipo,
      numero: numero++,
      fecha: it.fecha,
      importe: round2(it.importe),
      formaPago: it.formaPago,
      estado: 'pendiente' as const,
    };
    if (dbOk()) {
      creados.push(aDom(await prisma.vencimiento.create({ data: base })));
    } else {
      const v: Vencimiento = { ...base, id: randomUUID() };
      memoria.push(v);
      creados.push(v);
    }
  }
  return creados;
}

export async function listarVencimientos(
  companyId: string,
  filtro: { facturaId?: string; estado?: Vencimiento['estado'] } = {},
): Promise<Vencimiento[]> {
  if (dbOk()) {
    const rows = await prisma.vencimiento.findMany({
      where: { companyId, ...(filtro.facturaId ? { facturaId: filtro.facturaId } : {}), ...(filtro.estado ? { estado: filtro.estado } : {}) },
      orderBy: [{ fecha: 'asc' }, { numero: 'asc' }],
    });
    return rows.map(aDom);
  }
  return memoria.filter(
    (v) =>
      v.companyId === companyId &&
      (!filtro.facturaId || v.facturaId === filtro.facturaId) &&
      (!filtro.estado || v.estado === filtro.estado),
  );
}

export async function obtenerVencimiento(companyId: string, vencimientoId: string): Promise<Vencimiento> {
  if (dbOk()) {
    const v = await prisma.vencimiento.findUnique({ where: { id: vencimientoId } });
    if (!v || v.companyId !== companyId) throw notFound('Vencimiento no encontrado.');
    return aDom(v);
  }
  const v = memoria.find((x) => x.id === vencimientoId && x.companyId === companyId);
  if (!v) throw notFound('Vencimiento no encontrado.');
  return v;
}

export async function marcarComoLiquidado(companyId: string, vencimientoId: string, fecha: string): Promise<Vencimiento> {
  if (dbOk()) {
    await obtenerVencimiento(companyId, vencimientoId); // valida pertenencia
    const v = await prisma.vencimiento.update({ where: { id: vencimientoId }, data: { estado: 'liquidado', fechaLiquidacion: fecha } });
    return aDom(v);
  }
  const v = await obtenerVencimiento(companyId, vencimientoId);
  v.estado = 'liquidado';
  v.fechaLiquidacion = fecha;
  return v;
}
