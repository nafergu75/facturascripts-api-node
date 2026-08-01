/**
 * Servicio de auditoría de proveedores (SupplierAudit).
 * Log append-only para registrar cambios en proveedores.
 * No se borran ni editan entradas: solo se crean nuevas.
 */

import { prisma } from '../../config/database';
import { notFound } from '../../utils/http-errors';

export interface SupplierAuditEntry {
  id: string;
  supplierId: string;
  usuarioEmail?: string;
  tipoAccion: 'create' | 'update' | 'delete';
  campo?: string;
  valorAnterior?: string;
  valorNuevo?: string;
  descripcion?: string;
  createdAt: Date;
}

/**
 * Registrar la creación de un proveedor.
 */
export async function logCreate(supplierId: string, usuarioEmail?: string, descripcion?: string): Promise<SupplierAuditEntry> {
  const entry = await prisma.supplierAudit.create({
    data: {
      supplierId: String(supplierId),
      usuarioEmail: usuarioEmail || null,
      tipoAccion: 'create',
      campo: null,
      valorAnterior: null,
      valorNuevo: null,
      descripcion: descripcion || 'Proveedor creado',
    },
  });

  return formatAuditEntry(entry);
}

/**
 * Registrar la actualización de un proveedor o entidad relacionada.
 * Graba el campo modificado y valores anterior/nuevo.
 */
export async function logUpdate(
  supplierId: string,
  campo: string,
  valorAnterior: any,
  valorNuevo: any,
  usuarioEmail?: string,
  descripcion?: string,
): Promise<SupplierAuditEntry> {
  const entry = await prisma.supplierAudit.create({
    data: {
      supplierId: String(supplierId),
      usuarioEmail: usuarioEmail || null,
      tipoAccion: 'update',
      campo,
      valorAnterior: valorAnterior != null ? JSON.stringify(valorAnterior) : null,
      valorNuevo: valorNuevo != null ? JSON.stringify(valorNuevo) : null,
      descripcion: descripcion || `Campo '${campo}' actualizado`,
    },
  });

  return formatAuditEntry(entry);
}

/**
 * Registrar la eliminación de un proveedor.
 */
export async function logDelete(supplierId: string, usuarioEmail?: string, descripcion?: string): Promise<SupplierAuditEntry> {
  const entry = await prisma.supplierAudit.create({
    data: {
      supplierId: String(supplierId),
      usuarioEmail: usuarioEmail || null,
      tipoAccion: 'delete',
      campo: null,
      valorAnterior: null,
      valorNuevo: null,
      descripcion: descripcion || 'Proveedor eliminado',
    },
  });

  return formatAuditEntry(entry);
}

/**
 * Registrar un cambio en contacto (crear/actualizar/eliminar).
 */
export async function logContactChange(
  supplierId: string,
  tipoAccion: 'create' | 'update' | 'delete',
  contactoNombre: string,
  usuarioEmail?: string,
): Promise<SupplierAuditEntry> {
  const descripcion = `Contacto '${contactoNombre}' ${tipoAccion === 'create' ? 'creado' : tipoAccion === 'update' ? 'actualizado' : 'eliminado'}`;

  const entry = await prisma.supplierAudit.create({
    data: {
      supplierId: String(supplierId),
      usuarioEmail: usuarioEmail || null,
      tipoAccion: 'update', // Se registra como update general
      campo: 'contacto',
      valorAnterior: null,
      valorNuevo: contactoNombre,
      descripcion,
    },
  });

  return formatAuditEntry(entry);
}

/**
 * Registrar un cambio en cuenta bancaria.
 */
export async function logBankAccountChange(
  supplierId: string,
  tipoAccion: 'create' | 'update' | 'delete',
  iban: string,
  usuarioEmail?: string,
): Promise<SupplierAuditEntry> {
  const descripcion = `Cuenta bancaria ${iban} ${tipoAccion === 'create' ? 'creada' : tipoAccion === 'update' ? 'actualizada' : 'eliminada'}`;

  const entry = await prisma.supplierAudit.create({
    data: {
      supplierId: String(supplierId),
      usuarioEmail: usuarioEmail || null,
      tipoAccion: 'update',
      campo: 'cuenta_bancaria',
      valorAnterior: null,
      valorNuevo: iban,
      descripcion,
    },
  });

  return formatAuditEntry(entry);
}

/**
 * Listar historial completo de un proveedor (más reciente primero).
 */
export async function listBySupplier(supplierId: string): Promise<SupplierAuditEntry[]> {
  // Verificar que el proveedor existe
  const supplier = await prisma.supplier.findUnique({ where: { id: String(supplierId) } });
  if (!supplier) throw notFound('Proveedor no encontrado.');

  const entries = await prisma.supplierAudit.findMany({
    where: { supplierId: String(supplierId) },
    orderBy: { createdAt: 'desc' },
  });

  return entries.map(formatAuditEntry);
}

/**
 * Listar historial filtrado por tipo de acción.
 */
export async function listByAction(supplierId: string, tipoAccion: 'create' | 'update' | 'delete'): Promise<SupplierAuditEntry[]> {
  const entries = await prisma.supplierAudit.findMany({
    where: { supplierId: String(supplierId), tipoAccion },
    orderBy: { createdAt: 'desc' },
  });

  return entries.map(formatAuditEntry);
}

/**
 * Contar cambios en un periodo (para estadísticas).
 */
export async function countChanges(supplierId: string, fromDate?: Date, toDate?: Date): Promise<number> {
  const where: any = { supplierId: String(supplierId) };
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = fromDate;
    if (toDate) where.createdAt.lte = toDate;
  }

  return await prisma.supplierAudit.count({ where });
}

function formatAuditEntry(a: any): SupplierAuditEntry {
  return {
    id: a.id,
    supplierId: a.supplierId,
    usuarioEmail: a.usuarioEmail || undefined,
    tipoAccion: a.tipoAccion,
    campo: a.campo || undefined,
    valorAnterior: a.valorAnterior || undefined,
    valorNuevo: a.valorNuevo || undefined,
    descripcion: a.descripcion || undefined,
    createdAt: a.createdAt,
  };
}
