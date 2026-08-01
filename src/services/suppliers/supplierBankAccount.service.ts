/**
 * Servicio de cuentas bancarias de proveedores (SupplierBankAccount).
 * CRUD para gestionar IBANs, BICs y datos de pago de un proveedor.
 */

import { prisma } from '../../config/database';
import { notFound, badRequest } from '../../utils/http-errors';
import { validateIban } from '../../utils/validateIban';

export interface SupplierBankAccountInput {
  iban: string;
  bic?: string;
  banco?: string;
  alias?: string;
  formaPagoPorDefecto?: string;
  esPrincipal?: boolean;
  observaciones?: string;
}

export interface SupplierBankAccountOutput {
  id: string;
  supplierId: string;
  iban: string;
  bic?: string;
  banco?: string;
  alias: string;
  formaPagoPorDefecto: string;
  esPrincipal: boolean;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validar formato IBAN (robusto: checksum mod-97, longitud por país, estructura).
 */
function validarIBAN(iban: string): { valid: boolean; error?: string } {
  const validation = validateIban(iban);
  return {
    valid: validation.valid,
    error: validation.error,
  };
}

/**
 * Crear una cuenta bancaria para un proveedor.
 * Si esPrincipal=true, desmarca la anterior.
 */
export async function createBankAccount(supplierId: string, data: SupplierBankAccountInput): Promise<SupplierBankAccountOutput> {
  if (!data.iban || !data.iban.trim()) {
    throw badRequest('El IBAN es requerido.');
  }

  const ibanValidation = validarIBAN(data.iban);
  if (!ibanValidation.valid) {
    throw badRequest(`IBAN inválido: ${ibanValidation.error || 'formato incorrecto'}`);
  }

  // Verificar que el proveedor existe
  const supplier = await prisma.supplier.findUnique({ where: { id: String(supplierId) } });
  if (!supplier) throw notFound('Proveedor no encontrado.');

  // Verificar que no existe otro IBAN igual en este proveedor
  const exists = await prisma.supplierBankAccount.findFirst({
    where: { supplierId: String(supplierId), iban: data.iban.replace(/\s/g, '').toUpperCase() },
  });
  if (exists) throw badRequest('Este IBAN ya existe para este proveedor.');

  // Si es principal, desmarca otros
  if (data.esPrincipal) {
    await prisma.supplierBankAccount.updateMany({
      where: { supplierId: String(supplierId), esPrincipal: true },
      data: { esPrincipal: false },
    });
  }

  const account = await prisma.supplierBankAccount.create({
    data: {
      supplierId: String(supplierId),
      iban: data.iban.replace(/\s/g, '').toUpperCase(),
      bic: data.bic ? data.bic.trim().toUpperCase() : null,
      banco: data.banco ? data.banco.trim() : null,
      alias: data.alias ? data.alias.trim() : 'Cuenta principal',
      formaPagoPorDefecto: data.formaPagoPorDefecto || 'transferencia',
      esPrincipal: data.esPrincipal || false,
      observaciones: data.observaciones || null,
    },
  });

  return formatBankAccount(account);
}

/**
 * Actualizar una cuenta bancaria.
 */
export async function updateBankAccount(supplierId: string, accountId: string, data: SupplierBankAccountInput): Promise<SupplierBankAccountOutput> {
  const account = await prisma.supplierBankAccount.findFirst({
    where: { id: String(accountId), supplierId: String(supplierId) },
  });
  if (!account) throw notFound('Cuenta bancaria no encontrada.');

  // Si se actualiza IBAN, validar formato y unicidad
  if (data.iban && data.iban !== account.iban) {
    const ibanValidation = validarIBAN(data.iban);
    if (!ibanValidation.valid) {
      throw badRequest(`IBAN inválido: ${ibanValidation.error || 'formato incorrecto'}`);
    }
    const exists = await prisma.supplierBankAccount.findFirst({
      where: {
        supplierId: String(supplierId),
        iban: data.iban.replace(/\s/g, '').toUpperCase(),
        id: { not: String(accountId) },
      },
    });
    if (exists) throw badRequest('Este IBAN ya existe para este proveedor.');
  }

  // Si ahora es principal, desmarca otros
  if (data.esPrincipal && !account.esPrincipal) {
    await prisma.supplierBankAccount.updateMany({
      where: { supplierId: String(supplierId), esPrincipal: true },
      data: { esPrincipal: false },
    });
  }

  const updated = await prisma.supplierBankAccount.update({
    where: { id: String(accountId) },
    data: {
      ...(data.iban !== undefined ? { iban: data.iban.replace(/\s/g, '').toUpperCase() } : {}),
      ...(data.bic !== undefined ? { bic: data.bic ? data.bic.trim().toUpperCase() : null } : {}),
      ...(data.banco !== undefined ? { banco: data.banco ? data.banco.trim() : null } : {}),
      ...(data.alias !== undefined ? { alias: data.alias ? data.alias.trim() : 'Cuenta principal' } : {}),
      ...(data.formaPagoPorDefecto !== undefined ? { formaPagoPorDefecto: data.formaPagoPorDefecto } : {}),
      ...(data.esPrincipal !== undefined ? { esPrincipal: data.esPrincipal } : {}),
      ...(data.observaciones !== undefined ? { observaciones: data.observaciones || null } : {}),
    },
  });

  return formatBankAccount(updated);
}

/**
 * Eliminar una cuenta bancaria.
 */
export async function deleteBankAccount(supplierId: string, accountId: string): Promise<void> {
  const account = await prisma.supplierBankAccount.findFirst({
    where: { id: String(accountId), supplierId: String(supplierId) },
  });
  if (!account) throw notFound('Cuenta bancaria no encontrada.');

  await prisma.supplierBankAccount.delete({ where: { id: String(accountId) } });
}

/**
 * Listar cuentas bancarias de un proveedor.
 */
export async function listBankAccountsBySupplier(supplierId: string): Promise<SupplierBankAccountOutput[]> {
  const accounts = await prisma.supplierBankAccount.findMany({
    where: { supplierId: String(supplierId) },
    orderBy: [{ esPrincipal: 'desc' }, { createdAt: 'desc' }],
  });

  return accounts.map(formatBankAccount);
}

/**
 * Obtener una cuenta bancaria específica.
 */
export async function getBankAccount(supplierId: string, accountId: string): Promise<SupplierBankAccountOutput> {
  const account = await prisma.supplierBankAccount.findFirst({
    where: { id: String(accountId), supplierId: String(supplierId) },
  });
  if (!account) throw notFound('Cuenta bancaria no encontrada.');

  return formatBankAccount(account);
}

/**
 * Marcar una cuenta como principal (desmarca otras).
 */
export async function setBankAccountPrincipal(supplierId: string, accountId: string): Promise<SupplierBankAccountOutput> {
  const account = await prisma.supplierBankAccount.findFirst({
    where: { id: String(accountId), supplierId: String(supplierId) },
  });
  if (!account) throw notFound('Cuenta bancaria no encontrada.');

  // Desmarca todas las demás
  await prisma.supplierBankAccount.updateMany({
    where: { supplierId: String(supplierId), esPrincipal: true },
    data: { esPrincipal: false },
  });

  // Marca esta como principal
  const updated = await prisma.supplierBankAccount.update({
    where: { id: String(accountId) },
    data: { esPrincipal: true },
  });

  return formatBankAccount(updated);
}

function formatBankAccount(a: any): SupplierBankAccountOutput {
  return {
    id: a.id,
    supplierId: a.supplierId,
    iban: a.iban,
    bic: a.bic || undefined,
    banco: a.banco || undefined,
    alias: a.alias,
    formaPagoPorDefecto: a.formaPagoPorDefecto,
    esPrincipal: a.esPrincipal,
    observaciones: a.observaciones || undefined,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}
