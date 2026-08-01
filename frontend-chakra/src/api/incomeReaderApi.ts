/**
 * API Service - Lector de Facturas (income-reader)
 * Encapsula llamadas a endpoints de /companies/:companyId/income-reader/*
 */

import { httpGet, httpPost } from '../utils/http';

const BASE_PATH = '/companies/:companyId/income-reader';
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export interface ParsedInvoiceLine {
  descripcion: string;
  cantidad?: number;
  precioUnitario?: number;
  totalLinea?: number;
  baseImponible?: number;
  tipoIva?: number;
  tipoRetencion?: number;
}

export interface ParsedInvoiceData {
  nifEmisor?: string;
  nombreEmisor?: string;
  nifReceptor?: string;
  nombreReceptor?: string;
  numero?: string;
  fecha?: string;
  fechaVencimiento?: string;
  baseImponible?: number;
  totalIva?: number;
  totalRetencion?: number;
  total?: number;
  lineas?: ParsedInvoiceLine[];
  tipoDetectado?: 'venta' | 'compra';
  confianza?: number;
  /**
   * Por qué quedó (o no) con datos, para distinguir "no hay OCR configurado" de
   * "el documento no se pudo leer" sin adivinarlo desde `confianza`.
   * SIN_CLAVE = falta clave de OCR en el servidor; FORMATO_NO_SOPORTADO = no es
   * PDF/imagen/XML; NO_LEGIBLE = se intentó y no se extrajo nada; OK = hay datos.
   */
  ocrEstado?: 'OK' | 'SIN_CLAVE' | 'FORMATO_NO_SOPORTADO' | 'NO_LEGIBLE';
}

export interface IncomeReaderDocument {
  id: string;
  companyId: string;
  sourceType: string;
  originalFileName: string;
  status: string;
  uploadedAt: string;
  processingStartedAt?: string;
  processingCompletedAt?: string;
  verifiedAt?: string;
  parsedData?: ParsedInvoiceData;
  linkedInvoiceId?: string;
  rejectionReason?: string;
}

/**
 * Ping ligero a la API del lector: usa un endpoint real y de solo lectura
 * (no requiere crear datos) para saber si el backend responde.
 * Usa fetch directo (no httpGet) para que un fallo NO dispare el redirect-a-login
 * global de http.ts en 401 — un health-check fallido debe degradar a demo, no
 * forzar logout.
 */
export async function checkLectorHealth(companyId: string): Promise<boolean> {
  if (!companyId) return false;
  try {
    const token = localStorage.getItem('jwt_token');
    const res = await fetch(
      `${API_BASE_URL}${BASE_PATH.replace(':companyId', companyId)}/pending`,
      {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(4000),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export function listPendingDocuments(companyId: string): Promise<{ documents: IncomeReaderDocument[]; cantidad: number }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + '/pending';
  return httpGet(endpoint);
}

export function getDocumentDetail(companyId: string, id: string): Promise<{ document: IncomeReaderDocument }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + `/${id}`;
  return httpGet(endpoint);
}

export function verifyDocument(companyId: string, id: string): Promise<{ documentoId: string; status: string; linkedInvoiceId: string }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + `/${id}/verify`;
  return httpPost(endpoint);
}

export function rejectDocument(companyId: string, id: string, motivo?: string): Promise<{ document: IncomeReaderDocument }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + `/${id}/reject`;
  return httpPost(endpoint, { motivo });
}

/**
 * Subida de archivo (drag&drop). Usa fetch directo porque httpPost siempre
 * serializa el body a JSON — un FormData necesita su propio Content-Type
 * (boundary) que el navegador genera solo si no lo fijamos manualmente.
 */
export async function uploadDocument(companyId: string, file: File): Promise<{ document: IncomeReaderDocument }> {
  const token = localStorage.getItem('jwt_token');
  const formData = new FormData();
  formData.append('archivo', file);

  const res = await fetch(
    `${API_BASE_URL}${BASE_PATH.replace(':companyId', companyId)}/web-upload`,
    {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw { statusCode: res.status, message: data?.message || 'Error al subir el archivo' };
  }
  return data?.data || data;
}
