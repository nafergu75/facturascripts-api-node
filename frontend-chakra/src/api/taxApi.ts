/**
 * API Service - Documentos Fiscales (IVA, Retenciones)
 * Encapsula llamadas a endpoints de /tax/*
 */

import {
  VatBooksResponse,
  VatSummaryResponse,
  RetentionSummaryResponse
} from './types';
import { httpGet } from '../utils/http';

const TAX_BASE = '/companies/:companyId/tax';

// ============ LIBROS DE IVA ============

/**
 * Obtener Libro IVA - Facturas Emitidas
 */
export function getVatBooksIssued(
  companyId: string,
  period: string // Q1-2026, Q2-2026, etc.
): Promise<VatBooksResponse> {
  const endpoint = TAX_BASE.replace(':companyId', companyId) + '/vat/books/issued';

  return httpGet<VatBooksResponse>(endpoint, {
    period
  });
}

/**
 * Obtener Libro IVA - Facturas Recibidas
 */
export function getVatBooksReceived(
  companyId: string,
  period: string // Q1-2026, Q2-2026, etc.
): Promise<VatBooksResponse> {
  const endpoint = TAX_BASE.replace(':companyId', companyId) + '/vat/books/received';

  return httpGet<VatBooksResponse>(endpoint, {
    period
  });
}

// ============ RESUMEN IVA (MODELO 303) ============

/**
 * Obtener Resumen IVA por periodo
 */
export function getVatSummary(
  companyId: string,
  period: string // Q1-2026, Q2-2026, etc.
): Promise<VatSummaryResponse> {
  const endpoint = TAX_BASE.replace(':companyId', companyId) + '/vat/summary';

  return httpGet<VatSummaryResponse>(endpoint, {
    period
  });
}

// ============ RESUMEN RETENCIONES (MODELO 190) ============

/**
 * Obtener Resumen de Retenciones por año
 */
export function getRetentionSummary(
  companyId: string,
  year: number
): Promise<RetentionSummaryResponse> {
  const endpoint = TAX_BASE.replace(':companyId', companyId) + '/retentions/summary';

  return httpGet<RetentionSummaryResponse>(endpoint, {
    year
  });
}

/**
 * Exportar Modelo 303 en formato específico
 */
export function exportModelo303(
  companyId: string,
  period: string,
  format: 'txt' | 'json' = 'txt'
): Promise<string | any> {
  const endpoint = TAX_BASE.replace(':companyId', companyId) + '/export/modelo-303';

  return httpGet<any>(endpoint, {
    period,
    format
  });
}
