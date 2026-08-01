/**
 * API Service - Productos (catálogo FS `productos`).
 * Endpoint: /companies/:companyId/productos
 */

import { httpGet, httpPost } from '../utils/http';

export interface Producto {
  idproducto?: string;
  referencia: string;
  descripcion?: string;
  precio?: number;
  stockfis?: number;
  bloqueado?: boolean;
}

export function listarProductos(companyId: string, referencia?: string): Promise<{ items: Producto[]; total?: number }> {
  return httpGet(`/companies/${companyId}/productos`, referencia ? { referencia } : {});
}

export function crearProducto(
  companyId: string,
  datos: { referencia: string; descripcion?: string; precio?: number },
): Promise<Producto> {
  return httpPost(`/companies/${companyId}/productos`, datos);
}
