/**
 * API Service - Compras (facturas de gasto, recurso FS facturaproveedores).
 * Solo lectura: el alta recomendada es vía lector de facturas.
 * Endpoint: GET /companies/:companyId/compras?pageSize=&page=
 */

import { httpGet } from '../utils/http';

export interface FacturaProveedor {
  codigo: string;
  idfactura?: string;
  nombre?: string;
  codproveedor?: string;
  fecha?: string;
  neto?: number;
  totaliva?: number;
  total?: number;
  pagada?: boolean;
}

export interface ListaCompras {
  items: FacturaProveedor[];
  total?: number;
  page?: number;
  pageSize?: number;
}

export function listarCompras(
  companyId: string,
  params: Record<string, string | number> = { pageSize: 50 },
): Promise<ListaCompras> {
  return httpGet(`/companies/${companyId}/compras`, params);
}
