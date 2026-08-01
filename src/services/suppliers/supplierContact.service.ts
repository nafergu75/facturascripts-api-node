/**
 * Servicio de contactos múltiples de proveedores (SupplierContact).
 * CRUD para gestionar múltiples personas de contacto por proveedor.
 */

import { prisma } from '../../config/database';
import { notFound, badRequest } from '../../utils/http-errors';

export interface SupplierContactInput {
  nombre: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  rol?: string;
  esPrincipal?: boolean;
  observaciones?: string;
}

export interface SupplierContactOutput {
  id: string;
  supplierId: string;
  nombre: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  rol: string;
  esPrincipal: boolean;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Crear un contacto para un proveedor.
 * Si esPrincipal=true, desmarca el contacto principal anterior.
 */
export async function createContact(supplierId: string, data: SupplierContactInput): Promise<SupplierContactOutput> {
  if (!data.nombre || !data.nombre.trim()) {
    throw badRequest('El nombre del contacto es requerido.');
  }

  // Verificar que el proveedor existe
  const supplier = await prisma.supplier.findUnique({ where: { id: String(supplierId) } });
  if (!supplier) throw notFound('Proveedor no encontrado.');

  // Si es principal, desmarca otros
  if (data.esPrincipal) {
    await prisma.supplierContact.updateMany({
      where: { supplierId: String(supplierId), esPrincipal: true },
      data: { esPrincipal: false },
    });
  }

  const contact = await prisma.supplierContact.create({
    data: {
      supplierId: String(supplierId),
      nombre: data.nombre.trim(),
      apellido: data.apellido ? data.apellido.trim() : null,
      email: data.email ? data.email.trim() : null,
      telefono: data.telefono ? data.telefono.trim() : null,
      rol: data.rol || 'general',
      esPrincipal: data.esPrincipal || false,
      observaciones: data.observaciones || null,
    },
  });

  return formatContact(contact);
}

/**
 * Actualizar un contacto.
 */
export async function updateContact(supplierId: string, contactId: string, data: SupplierContactInput): Promise<SupplierContactOutput> {
  const contact = await prisma.supplierContact.findFirst({
    where: { id: String(contactId), supplierId: String(supplierId) },
  });
  if (!contact) throw notFound('Contacto no encontrado.');

  // Si ahora es principal, desmarca otros
  if (data.esPrincipal && !contact.esPrincipal) {
    await prisma.supplierContact.updateMany({
      where: { supplierId: String(supplierId), esPrincipal: true },
      data: { esPrincipal: false },
    });
  }

  const updated = await prisma.supplierContact.update({
    where: { id: String(contactId) },
    data: {
      ...(data.nombre !== undefined ? { nombre: data.nombre.trim() } : {}),
      ...(data.apellido !== undefined ? { apellido: data.apellido ? data.apellido.trim() : null } : {}),
      ...(data.email !== undefined ? { email: data.email ? data.email.trim() : null } : {}),
      ...(data.telefono !== undefined ? { telefono: data.telefono ? data.telefono.trim() : null } : {}),
      ...(data.rol !== undefined ? { rol: data.rol } : {}),
      ...(data.esPrincipal !== undefined ? { esPrincipal: data.esPrincipal } : {}),
      ...(data.observaciones !== undefined ? { observaciones: data.observaciones || null } : {}),
    },
  });

  return formatContact(updated);
}

/**
 * Eliminar un contacto.
 */
export async function deleteContact(supplierId: string, contactId: string): Promise<void> {
  const contact = await prisma.supplierContact.findFirst({
    where: { id: String(contactId), supplierId: String(supplierId) },
  });
  if (!contact) throw notFound('Contacto no encontrado.');

  await prisma.supplierContact.delete({ where: { id: String(contactId) } });
}

/**
 * Listar contactos de un proveedor.
 */
export async function listContactsBySupplier(supplierId: string): Promise<SupplierContactOutput[]> {
  const contacts = await prisma.supplierContact.findMany({
    where: { supplierId: String(supplierId) },
    orderBy: [{ esPrincipal: 'desc' }, { createdAt: 'desc' }],
  });

  return contacts.map(formatContact);
}

/**
 * Obtener un contacto específico.
 */
export async function getContact(supplierId: string, contactId: string): Promise<SupplierContactOutput> {
  const contact = await prisma.supplierContact.findFirst({
    where: { id: String(contactId), supplierId: String(supplierId) },
  });
  if (!contact) throw notFound('Contacto no encontrado.');

  return formatContact(contact);
}

function formatContact(c: any): SupplierContactOutput {
  return {
    id: c.id,
    supplierId: c.supplierId,
    nombre: c.nombre,
    apellido: c.apellido || undefined,
    email: c.email || undefined,
    telefono: c.telefono || undefined,
    rol: c.rol,
    esPrincipal: c.esPrincipal,
    observaciones: c.observaciones || undefined,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
