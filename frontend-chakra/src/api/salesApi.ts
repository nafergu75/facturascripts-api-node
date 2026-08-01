/**
 * API Service - Clientes y Proveedores (operativa de ventas/compras).
 * Clientes y proveedores son espejos en el backend (mismas rutas, distinto
 * recurso), así que este cliente trabaja con un `tipo` y normaliza ambos a una
 * forma común `Contacto`.
 *
 * Endpoints: /companies/:companyId/{clientes|proveedores}
 *   GET  /            listado (FS): { items: [...] }
 *   GET  /buscar?q=   búsqueda en vivo: ClienteResumen[]
 *   POST /            alta
 *   PUT  /:codigo     edición
 */

import { httpGet, httpPost, httpPut } from '../utils/http';

export type TipoContacto = 'clientes' | 'proveedores';

/** Forma normalizada que consume la UI (vale para cliente y proveedor). */
export interface Contacto {
  codigo: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

/** Datos de alta (NIF obligatorio). El backend mapea `telefono` -> FS telefono1. */
export interface AltaContacto {
  nombre: string;
  cifnif: string;
  email?: string;
  telefono?: string;
}

/** Datos editables (NIF y código son fijos). */
export interface EdicionContacto {
  nombre: string;
  email: string;
  telefono: string;
}

const basePath = (companyId: string, tipo: TipoContacto): string => `/companies/${companyId}/${tipo}`;

/** Normaliza un registro FS (cliente o proveedor) a `Contacto`. */
function aContacto(r: Record<string, any>): Contacto {
  return {
    codigo: String(r.codcliente ?? r.codproveedor ?? r.codigo ?? r.id ?? ''),
    nombre: String(r.nombre ?? r.razonsocial ?? r.nombreFiscal ?? ''),
    nif: String(r.cifnif ?? r.nif ?? r.nifCif ?? ''),
    email: String(r.email ?? ''),
    telefono: String(r.telefono1 ?? r.telefono ?? ''),
  };
}

export async function listarContactos(companyId: string, tipo: TipoContacto): Promise<Contacto[]> {
  const resp = await httpGet<{ items?: Record<string, any>[] }>(basePath(companyId, tipo));
  return (resp.items ?? []).map(aContacto);
}

export async function buscarContactos(
  companyId: string,
  tipo: TipoContacto,
  q: string,
  limit = 50,
): Promise<Contacto[]> {
  // El buscador devuelve ClienteResumen[] {id,nombre,nif,email,telefono}.
  const resp = await httpGet<Record<string, any>[]>(basePath(companyId, tipo) + '/buscar', { q, limit });
  return (resp ?? []).map(aContacto);
}

export function crearContacto(companyId: string, tipo: TipoContacto, datos: AltaContacto): Promise<unknown> {
  return httpPost(basePath(companyId, tipo), datos);
}

export function actualizarContacto(
  companyId: string,
  tipo: TipoContacto,
  codigo: string,
  datos: EdicionContacto,
): Promise<unknown> {
  return httpPut(`${basePath(companyId, tipo)}/${codigo}`, datos);
}
