/**
 * API Service - Motor Contable
 * Encapsula llamadas a endpoints de /accounting/*
 */

import {
  JournalEntry,
  JournalEntryDetail,
  JournalEntryFilters,
  ApproveJournalEntryRequest,
  AdjustJournalEntryLineRequest
} from './types';
import { httpGet, httpPost, httpPatch } from '../utils/http';

const BASE_PATH = '/companies/:companyId/accounting';

/**
 * Listar asientos contables con filtros
 */
export function getJournalEntries(
  companyId: string,
  filters: JournalEntryFilters = {}
): Promise<JournalEntry[]> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + '/journal-entries';

  const params: Record<string, any> = {};
  if (filters.estado) params.estado = filters.estado;
  if (filters.origen) params.origen = filters.origen;
  if (filters.from) params.from = filters.from;
  if (filters.to) params.to = filters.to;
  params.skip = filters.skip ?? 0;
  params.take = filters.take ?? 20;

  return httpGet<JournalEntry[]>(endpoint, params);
}

/**
 * Obtener detalle de un asiento
 */
export function getJournalEntryDetail(
  companyId: string,
  journalEntryId: string
): Promise<JournalEntryDetail> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) +
    `/journal-entries/${journalEntryId}`;

  return httpGet<JournalEntryDetail>(endpoint);
}

/**
 * Aprobar un asiento (cambiar estado a POSTED)
 */
export function approveJournalEntry(
  companyId: string,
  journalEntryId: string,
  observaciones?: string
): Promise<JournalEntryDetail> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) +
    `/journal-entries/${journalEntryId}/approve`;

  return httpPost<JournalEntryDetail>(endpoint, {
    observaciones
  });
}

/**
 * Ajustar una línea de asiento (cambiar cuenta o montos)
 */
export function adjustJournalEntryLine(
  companyId: string,
  journalEntryId: string,
  lineId: string,
  adjustments: AdjustJournalEntryLineRequest
): Promise<JournalEntryDetail> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) +
    `/journal-entries/${journalEntryId}/lines/${lineId}`;

  return httpPatch<JournalEntryDetail>(endpoint, adjustments);
}

/**
 * Contabilizar una factura manualmente.
 * El parámetro tipo es obligatorio: el backend devuelve 400 si no se incluye.
 */
export function contabilizarFactura(
  companyId: string,
  invoiceId: string,
  tipo: 'INGRESO' | 'GASTO',
  mode: 'AUTO' | 'MANUAL' = 'AUTO',
): Promise<{ journalEntryId: string; estado: string }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) +
    `/contabilizar/${invoiceId}?tipo=${tipo}&mode=${mode}`;

  return httpPost(endpoint);
}
