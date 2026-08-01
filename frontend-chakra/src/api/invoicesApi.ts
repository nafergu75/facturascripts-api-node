/**
 * API Service - Facturas de ingreso (módulo CANÓNICO Prisma, sin FacturaScripts).
 * Endpoints: /companies/:companyId/invoices
 *   GET  /?estado=&desde=&hasta=&skip=&take=   listado paginado/filtrado
 *   GET  /:id                                  detalle
 *   POST /                                     alta (CrearFacturaIngresoDTO)
 *   PATCH /:id/status   { estado }             cambiar estado (p.ej. PAID)
 *   POST  /:id/credit-note                     factura rectificativa (abono)
 */

import { httpGet, httpPatch, httpPost } from '../utils/http';

export interface FacturaIngreso {
  id: string;
  customerId: string;
  customerNombre?: string;
  serie: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: string;
  fechaVencimiento?: string;
  estado: string;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  esRectificativa: boolean;
}

export interface ListaFacturas {
  items: FacturaIngreso[];
  total: number;
  skip: number;
  take: number;
}

export interface FiltrosFacturas {
  estado?: string;
  desde?: string;
  hasta?: string;
  skip?: number;
  take?: number;
}

export interface LineaFacturaNueva {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuentoPorcentaje?: number;
  tipoIva?: number;
  tipoRetencion?: number;
}

export interface CrearFacturaBody {
  customer: { id?: string; nuevo?: { nombreFiscal: string; nifCif: string; email?: string } };
  serie: string;
  fechaEmision?: string;
  fechaVencimiento?: string;
  lineas: LineaFacturaNueva[];
  observaciones?: string;
}

const base = (companyId: string): string => `/companies/${companyId}/invoices`;

export function listarFacturas(companyId: string, filtros: FiltrosFacturas = {}): Promise<ListaFacturas> {
  return httpGet(base(companyId), filtros as Record<string, string | number | undefined>);
}

export function obtenerFactura(companyId: string, id: string): Promise<FacturaIngreso & { lineas?: unknown[] }> {
  return httpGet(`${base(companyId)}/${id}`);
}

export function cambiarEstadoFactura(companyId: string, id: string, estado: string): Promise<FacturaIngreso> {
  return httpPatch(`${base(companyId)}/${id}/status`, { estado });
}

export function crearAbono(companyId: string, id: string): Promise<FacturaIngreso> {
  return httpPost(`${base(companyId)}/${id}/credit-note`, {});
}

export function crearFactura(companyId: string, body: CrearFacturaBody): Promise<FacturaIngreso> {
  return httpPost(base(companyId), body);
}
