/**
 * Servicio para Registro Mercantil con versionado y caducidad.
 * Gestiona:
 * - LegalizationPackage: Expedientes de legalización
 * - AnnualAccounts: Depósitos de cuentas anuales
 */

import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';

/**
 * Validar si un documento está vigente.
 * Retorna false si expiresAt existe y ya pasó.
 */
export function esVigente(documento: { expiresAt: Date | null }): boolean {
  if (!documento.expiresAt) return true; // Sin fecha de caducidad = vigente indefinidamente
  return documento.expiresAt >= new Date();
}

/**
 * Obtener el timestamp de caducidad recomendado.
 * Por defecto: 4 años desde hoy (período de archivo legal).
 */
export function calcularCaducidad(diasDesdeHoy: number = 1460): Date {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + diasDesdeHoy);
  return fecha;
}

/**
 * Servicio para LegalizationPackage.
 */
export const legalizationPackageService = {
  /**
   * Crear un nuevo expediente de legalización.
   * Si ya existe para este fiscalYear, marca la anterior como obsoleta.
   */
  async crear(
    companyId: string,
    fiscalYearId: string,
    data: {
      zipPath: string;
      hash: string;
      size?: number;
      registryOffice?: string;
      expiresAt?: Date;
    },
  ) {
    // Marcar versiones anteriores como obsoletas
    await prisma.legalizationPackage.updateMany({
      where: { companyId, fiscalYearId, isLatestVersion: true },
      data: { isLatestVersion: false },
    });

    // Obtener versión siguiente
    const ultimaVersion = await prisma.legalizationPackage.findFirst({
      where: { companyId, fiscalYearId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const proximaVersion = (ultimaVersion?.version ?? 0) + 1;

    // Crear nuevo expediente
    return prisma.legalizationPackage.create({
      data: {
        companyId,
        fiscalYearId,
        zipPath: data.zipPath,
        hash: data.hash,
        size: data.size || 0,
        version: proximaVersion,
        isLatestVersion: true,
        expiresAt: data.expiresAt || calcularCaducidad(),
        registryOffice: data.registryOffice,
      },
    });
  },

  /**
   * Obtener la versión más reciente de un expediente.
   * Retorna error si no existe o está caducada.
   */
  async obtenerVigente(companyId: string, fiscalYearId: string) {
    const documento = await prisma.legalizationPackage.findFirst({
      where: { companyId, fiscalYearId, isLatestVersion: true },
    });

    if (!documento) {
      throw notFound('Expediente de legalización no encontrado.');
    }

    if (!esVigente(documento)) {
      throw badRequest('El expediente de legalización ha expirado.');
    }

    return documento;
  },

  /**
   * Obtener detalle con información de vigencia.
   */
  async obtenerDetalle(companyId: string, id: string) {
    const documento = await prisma.legalizationPackage.findFirst({
      where: { id, companyId },
    });

    if (!documento) {
      throw notFound('Expediente no encontrado.');
    }

    return {
      ...documento,
      esVigente: esVigente(documento),
      diasParaCaducidad: documento.expiresAt
        ? Math.floor((documento.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null,
    };
  },
};

/**
 * Servicio para AnnualAccounts.
 */
export const annualAccountsService = {
  /**
   * Crear un nuevo depósito de cuentas anuales.
   * Si ya existe para este fiscalYear, marca la anterior como obsoleta.
   */
  async crear(
    companyId: string,
    fiscalYearId: string,
    data: {
      filePath: string;
      hash: string;
      modelo?: string;
      dataJson?: any;
      expiresAt?: Date;
    },
  ) {
    // Marcar versiones anteriores como obsoletas
    await prisma.annualAccounts.updateMany({
      where: { companyId, fiscalYearId, isLatestVersion: true },
      data: { isLatestVersion: false },
    });

    // Obtener versión siguiente
    const ultimaVersion = await prisma.annualAccounts.findFirst({
      where: { companyId, fiscalYearId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const proximaVersion = (ultimaVersion?.version ?? 0) + 1;

    // Crear nuevo depósito
    return prisma.annualAccounts.create({
      data: {
        companyId,
        fiscalYearId,
        filePath: data.filePath,
        hash: data.hash,
        modelo: data.modelo || 'PYME',
        dataJson: data.dataJson,
        version: proximaVersion,
        isLatestVersion: true,
        expiresAt: data.expiresAt || calcularCaducidad(),
      },
    });
  },

  /**
   * Obtener la versión más reciente de las cuentas anuales.
   * Retorna error si no existe o está caducada.
   */
  async obtenerVigente(companyId: string, fiscalYearId: string) {
    const documento = await prisma.annualAccounts.findFirst({
      where: { companyId, fiscalYearId, isLatestVersion: true },
    });

    if (!documento) {
      throw notFound('Cuentas anuales no encontradas.');
    }

    if (!esVigente(documento)) {
      throw badRequest('Las cuentas anuales han expirado.');
    }

    return documento;
  },

  /**
   * Obtener detalle con información de vigencia.
   */
  async obtenerDetalle(companyId: string, id: string) {
    const documento = await prisma.annualAccounts.findFirst({
      where: { id, companyId },
    });

    if (!documento) {
      throw notFound('Cuenta anual no encontrada.');
    }

    return {
      ...documento,
      esVigente: esVigente(documento),
      diasParaCaducidad: documento.expiresAt
        ? Math.floor((documento.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
        : null,
    };
  },

  /**
   * Listar todas las versiones (historial) de un fiscalYear.
   */
  async obtenerHistorial(companyId: string, fiscalYearId: string) {
    return prisma.annualAccounts.findMany({
      where: { companyId, fiscalYearId },
      orderBy: { version: 'desc' },
    });
  },
};
