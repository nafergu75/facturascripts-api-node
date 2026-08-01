/**
 * Compras (facturas de gasto) — MIGRADO de FacturaScripts a Prisma (modelo
 * `ExpenseInvoice`), épico FS→Prisma (ADR-002). Solo lectura (list/getById); el
 * alta va por el lector de facturas. Mantiene los endpoints /companies/:id/compras
 * (el frontend Chakra no cambia). La forma de respuesta conserva los alias FS
 * (codigo/nombre/neto/totaliva/total) que espera el front.
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { parsePagination } from '../utils/pagination';
import { notFound, notImplemented } from '../utils/http-errors';

interface ExpenseRow {
  id: string;
  numeroCompleto: string;
  supplierId: string;
  fechaEmision: string;
  estado: string;
  tipoGasto: string;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  supplier?: { nombreFiscal: string } | null;
}

/** ExpenseInvoice (Prisma) -> forma de respuesta del recurso compras (alias FS). */
function aCompra(f: ExpenseRow): Record<string, unknown> {
  return {
    id: f.id,
    idfactura: f.id,
    codigo: f.numeroCompleto,
    numeroCompleto: f.numeroCompleto,
    codproveedor: f.supplierId,
    nombre: f.supplier?.nombreFiscal ?? '',
    fecha: f.fechaEmision,
    estado: f.estado,
    tipoGasto: f.tipoGasto,
    neto: f.baseTotal,
    totaliva: f.ivaTotal,
    retencion: f.retencionTotal,
    total: f.totalFactura,
  };
}

export const comprasService: CompanyScopedService = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<unknown>> {
    const { limit, offset } = parsePagination(params);
    const where = { companyId: String(companyId) };
    const [items, total] = await Promise.all([
      prisma.expenseInvoice.findMany({ where, include: { supplier: true }, orderBy: { fechaEmision: 'desc' }, skip: offset, take: limit }),
      prisma.expenseInvoice.count({ where }),
    ]);
    return { items: (items as ExpenseRow[]).map(aCompra), total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<unknown> {
    const f = (await prisma.expenseInvoice.findFirst({
      where: { id: String(id), companyId: String(companyId) },
      include: { supplier: true, lineas: true },
    })) as (ExpenseRow & { lineas?: unknown[] }) | null;
    if (!f) throw notFound('Factura de gasto no encontrada.');
    return { ...aCompra(f), lineas: f.lineas ?? [] };
  },

  async create(): Promise<unknown> {
    throw notImplemented('El alta de compras se hace por el lector de facturas (income-reader).');
  },
  async update(): Promise<unknown> {
    throw notImplemented('Edición de compras no implementada.');
  },
  async remove(): Promise<void> {
    throw notImplemented('Borrado de compras no implementado.');
  },
};
