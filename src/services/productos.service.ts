/**
 * Productos — MIGRADO de FacturaScripts a Prisma (modelo `Product`), épico
 * FS→Prisma (ADR-002). Mantiene los endpoints /companies/:companyId/productos y
 * conserva el alias `stockfis` en la respuesta (lo que espera el frontend).
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { Producto } from '../domain/producto.model';
import { parsePagination } from '../utils/pagination';
import { badRequest, notFound } from '../utils/http-errors';

type ProductRow = {
  id: string;
  referencia: string;
  descripcion: string | null;
  precio: number;
  stock: number;
  bloqueado: boolean;
};

/** Product (Prisma) -> forma de respuesta del recurso productos (alias FS stockfis). */
function aProducto(p: ProductRow): Record<string, unknown> {
  return {
    id: p.id,
    idproducto: p.id,
    referencia: p.referencia,
    descripcion: p.descripcion ?? '',
    precio: p.precio,
    stock: p.stock,
    stockfis: p.stock,
    bloqueado: p.bloqueado,
  };
}

const num = (v: unknown, def = 0): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : def);

export const productosService: CompanyScopedService<Producto> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Producto>> {
    const { limit, offset } = parsePagination(params);
    const where: Record<string, unknown> = { companyId: String(companyId) };
    if (params.referencia) where.referencia = { contains: String(params.referencia) };
    const [items, total] = await Promise.all([
      prisma.product.findMany({ where, skip: offset, take: limit, orderBy: { referencia: 'asc' } }),
      prisma.product.count({ where }),
    ]);
    return { items: (items as ProductRow[]).map(aProducto) as unknown as Producto[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Producto> {
    const p = (await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) } })) as ProductRow | null;
    if (!p) throw notFound('Producto no encontrado.');
    return aProducto(p) as unknown as Producto;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Producto> {
    const referencia = String(data.referencia ?? '').trim();
    if (!referencia) throw badRequest('La referencia es obligatoria.');
    const p = (await prisma.product.create({
      data: {
        companyId: String(companyId),
        referencia,
        descripcion: data.descripcion != null ? String(data.descripcion) : null,
        precio: num(data.precio),
        stock: num(data.stockfis ?? data.stock),
        bloqueado: data.bloqueado === true,
      },
    })) as ProductRow;
    return aProducto(p) as unknown as Producto;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Producto> {
    const existe = await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Producto no encontrado.');
    const p = (await prisma.product.update({
      where: { id: String(id) },
      data: {
        ...(data.referencia !== undefined ? { referencia: String(data.referencia) } : {}),
        ...(data.descripcion !== undefined ? { descripcion: data.descripcion != null ? String(data.descripcion) : null } : {}),
        ...(data.precio !== undefined ? { precio: num(data.precio) } : {}),
        ...(data.stockfis !== undefined || data.stock !== undefined ? { stock: num(data.stockfis ?? data.stock) } : {}),
        ...(data.bloqueado !== undefined ? { bloqueado: data.bloqueado === true } : {}),
      },
    })) as ProductRow;
    return aProducto(p) as unknown as Producto;
  },

  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.product.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Producto no encontrado.');
    await prisma.product.delete({ where: { id: String(id) } });
  },
};
