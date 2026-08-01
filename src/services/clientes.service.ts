/**
 * Clientes — MIGRADO de FacturaScripts a Prisma (modelo `Customer`), ADR-002
 * épico FS→Prisma. Comparte la MISMA tabla `customer` que las facturas de
 * ingreso (income-invoices), consolidando el doble-almacén anterior. Mantiene
 * los endpoints /companies/:companyId/clientes (el frontend Chakra no cambia).
 */
import { prisma } from '../config/database';
import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { Cliente } from '../domain/cliente.model';
import { parsePagination } from '../utils/pagination';
import { notFound } from '../utils/http-errors';

/** Cliente en formato ligero para el selector/buscador al facturar. */
export interface ClienteResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

type CustomerRow = {
  id: string;
  nombreFiscal: string;
  nifCif: string;
  email: string | null;
  telefono: string | null;
  activo: boolean;
  direccion?: string | null;
  pais?: string | null;
};

/** Customer (Prisma) -> forma de respuesta del recurso clientes. */
function aCliente(c: CustomerRow): Record<string, unknown> {
  return {
    id: c.id,
    nombreFiscal: c.nombreFiscal,
    nifCif: c.nifCif,
    email: c.email ?? '',
    telefono: c.telefono ?? '',
    activo: c.activo,
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

/**
 * Busca clientes por texto libre (nombre fiscal, NIF, email) sobre Prisma.
 */
export async function buscarClientes(companyId: ID, query: string, limit = 20): Promise<ClienteResumen[]> {
  const q = (query ?? '').trim();
  const where: Record<string, unknown> = { companyId: String(companyId) };
  if (q) {
    where.OR = [
      { nombreFiscal: { contains: q } },
      { nifCif: { contains: q } },
      { email: { contains: q } },
    ];
  }
  const items = (await prisma.customer.findMany({ where, take: limit, orderBy: { nombreFiscal: 'asc' } })) as CustomerRow[];
  return items.map((c) => ({ id: c.id, nombre: c.nombreFiscal, nif: c.nifCif, email: c.email ?? '', telefono: c.telefono ?? '' }));
}

export const clientesService: CompanyScopedService<Cliente> = {
  async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<Cliente>> {
    const { limit, offset } = parsePagination(params);
    const where = { companyId: String(companyId) };
    const [items, total] = await Promise.all([
      prisma.customer.findMany({ where, skip: offset, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.customer.count({ where }),
    ]);
    return { items: (items as CustomerRow[]).map(aCliente) as unknown as Cliente[], total, limit, offset };
  },

  async getById(companyId: ID, id: ID): Promise<Cliente> {
    const c = (await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } })) as CustomerRow | null;
    if (!c) throw notFound('Cliente no encontrado.');
    return aCliente(c) as unknown as Cliente;
  },

  async create(companyId: ID, data: Record<string, unknown>): Promise<Cliente> {
    const d = leerDatos(data);
    if (!d.nombreFiscal || !d.nifCif) throw notFound('Se requiere nombre y NIF.');
    const c = (await prisma.customer.create({
      data: {
        companyId: String(companyId),
        nombreFiscal: d.nombreFiscal,
        nifCif: d.nifCif,
        email: d.email,
        telefono: d.telefono,
        direccion: d.direccion,
        pais: data.pais != null ? String(data.pais) : 'ES',
      },
    })) as CustomerRow;
    return aCliente(c) as unknown as Cliente;
  },

  async update(companyId: ID, id: ID, data: Record<string, unknown>): Promise<Cliente> {
    const existe = await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Cliente no encontrado.');
    const d = leerDatos(data);
    const c = (await prisma.customer.update({
      where: { id: String(id) },
      data: {
        ...(d.nombreFiscal !== undefined ? { nombreFiscal: d.nombreFiscal } : {}),
        ...(d.nifCif !== undefined ? { nifCif: d.nifCif } : {}),
        ...(data.email !== undefined ? { email: d.email } : {}),
        ...(data.telefono !== undefined || data.telefono1 !== undefined ? { telefono: d.telefono } : {}),
      },
    })) as CustomerRow;
    return aCliente(c) as unknown as Cliente;
  },

  async remove(companyId: ID, id: ID): Promise<void> {
    const existe = await prisma.customer.findFirst({ where: { id: String(id), companyId: String(companyId) } });
    if (!existe) throw notFound('Cliente no encontrado.');
    await prisma.customer.delete({ where: { id: String(id) } });
  },
};
