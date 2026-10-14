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

/** Largo de valorAnterior y valorNuevo en la BD (String de Prisma: VARCHAR(191)). */
export const LARGO_VALOR_HISTORIAL = 191;

/**
 * Valor de un campo para el historial: en JSON y de 191 caracteres como mucho,
 * lo que cabe en la columna. Un texto mas largo (una web de hasta 255, un
 * nombre fiscal de 200) se recorta con «…» y sigue siendo JSON valido. Sin el
 * recorte, el cambio ya guardado daba un 500 (P2000) y no quedaba en el
 * historial.
 */
export function valorParaHistorial(valor: unknown): string | null {
  if (valor == null) return null;
  const json = JSON.stringify(valor);
  if (json === undefined) return null;
  if (json.length <= LARGO_VALOR_HISTORIAL) return json;
  if (typeof valor !== 'string') return `${json.slice(0, LARGO_VALOR_HISTORIAL - 1)}…`;
  // Por letras (no parte un emoji) y quitando lo que sobre tras escapar comillas o barras.
  const letras = Array.from(valor);
  let n = letras.length;
  let recortado = json;
  while (recortado.length > LARGO_VALOR_HISTORIAL && n > 0) {
    n = Math.max(0, n - Math.max(1, recortado.length - LARGO_VALOR_HISTORIAL + 1));
    recortado = JSON.stringify(`${letras.slice(0, n).join('')}…`);
  }
  return recortado;
}

/**
 * Registrar la actualización de un proveedor o entidad relacionada.
 * Graba el campo modificado y valores anterior/nuevo (recortados si no caben).
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
      valorAnterior: valorParaHistorial(valorAnterior),
      valorNuevo: valorParaHistorial(valorNuevo),
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
      // La accion real (antes siempre 'update'): filtrar el historial por
      // creaciones o borrados no encontraba nada.
      tipoAccion,
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
      tipoAccion,
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
