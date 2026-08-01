/**
 * Proveedores — MIGRADO de FacturaScripts a Prisma (modelo `Supplier`), épico
 * FS→Prisma (ADR-002). Comparte la MISMA tabla `supplier` que las facturas de
 * gasto (expense-invoices). Mantiene los endpoints /companies/:companyId/proveedores
 * (el frontend Chakra no cambia). Espejo de clientes.service.
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { parsePagination } from '../utils/pagination';
import { notFound } from '../utils/http-errors';

export interface Proveedor {
  codproveedor?: string;
  nombre?: string;
  razonsocial?: string;
  cifnif?: string;
  email?: string;
  [key: string]: unknown;
}

/** Proveedor en formato ligero para selectores (espejo de ClienteResumen). */
export interface ProveedorResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

type SupplierRow = {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string | null;
  telefono: string | null;
  activo: boolean;
};

/** Supplier (Prisma) -> forma de respuesta del recurso proveedores. */
function aProveedor(s: SupplierRow): Record<string, unknown> {
  return {
    id: s.id,
    nombreFiscal: s.nombreFiscal,
    nifCif: s.nifCif,
    email: s.email ?? '',
    telefono: s.telefono ?? '',
    activo: s.activo,
  };
}

/** Lee nombre/nif/teléfono del payload aceptando alias FS y Prisma. */
function leerDatos(data: Record<string, unknown>): { nombreFiscal?: string; nifCif?: string; email: string | null; telefono: string | null; direccion: string | null } {
  const nombre = (data.nombreFiscal ?? data.nombre ?? data.razonsocial) as string | undefined;
  const nif = (data.nifCif ?? data.cifnif ?? data.nif) as string | undefined;
  const tel = (data.telefono ?? data.telefono1) as string | undefined;
  return {
    nombreFiscal: nombre !== undefined ? String(nombre) : undefined,
    nifCif: nif !== undefined ? String(nif) : undefined,
    email: data.email != null ? String(data.email) : null,
    telefono: tel != null && tel !== '' ? String(tel) : null,
    direccion: data.direccion != null ? String(data.direccion) : null,
  };
}

export const proveedoresService: CompanyScopedService<Proveedor> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Proveedor>> {
    const { limit, offset } = parsePagination(params);
    const where = { companyId: String(companyId) };
    const [items, total] = await Promise.all([
      prisma.supplier.findMany({ where, skip: offset, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.supplier.count({ where }),
    ]);
    return { items: (items as SupplierRow[]).map(aProveedor) as unknown as Proveedor[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Proveedor> {
    const s = (await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } })) as SupplierRow | null;
    if (!s) throw notFound('Proveedor no encontrado.');
    return aProveedor(s) as unknown as Proveedor;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Proveedor> {
    const d = leerDatos(data);
    if (!d.nombreFiscal || !d.nifCif) throw notFound('Se requiere nombre y NIF.');
    const s = (await prisma.supplier.create({
      data: {
        companyId: String(companyId),
        nombreFiscal: d.nombreFiscal,
        nifCif: d.nifCif,
        email: d.email,
        telefono: d.telefono,
        direccion: d.direccion,
        pais: data.pais != null ? String(data.pais) : 'ES',
      },
    })) as SupplierRow;
    return aProveedor(s) as unknown as Proveedor;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Proveedor> {
    const existe = await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Proveedor no encontrado.');
    const d = leerDatos(data);
    const s = (await prisma.supplier.update({
      where: { id: String(id) },
      data: {
        ...(d.nombreFiscal !== undefined ? { nombreFiscal: d.nombreFiscal } : {}),
        ...(d.nifCif !== undefined ? { nifCif: d.nifCif } : {}),
        ...(data.email !== undefined ? { email: d.email } : {}),
        ...(data.telefono !== undefined || data.telefono1 !== undefined ? { telefono: d.telefono } : {}),
      },
    })) as SupplierRow;
    return aProveedor(s) as unknown as Proveedor;
  },

  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.supplier.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Proveedor no encontrado.');
    await prisma.supplier.delete({ where: { id: String(id) } });
  },
};

/** Busqueda por nombre/NIF/email sobre Prisma (espejo de buscarClientes). */
export async function buscarProveedores(companyId: ID, query: string, limit = 20): Promise<ProveedorResumen[]> {
  const q = (query ?? '').trim();
  const where: Record<string, unknown> = { companyId: String(companyId) };
  if (q) {
    where.OR = [
      { nombreFiscal: { contains: q } },
      { nifCif: { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = (await prisma.supplier.findMany({ where, take: limit, orderBy: { nombreFiscal: 'asc' } })) as SupplierRow[];
  return items.map((s) => ({ id: s.id, nombre: s.nombreFiscal, nif: s.nifCif, email: s.email ?? '', telefono: s.telefono ?? '' }));
}
