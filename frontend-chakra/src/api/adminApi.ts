/**
 * API Service - Administración de plataforma (superadmin / admin:global).
 * NO acotado a empresa. Endpoints top-level:
 *   GET  /admin/empresas
 *   POST /admin/empresas                                  { nombre, codigo?, fsBaseUrl, fsApiKey }
 *   GET  /users
 *   POST /admin/usuarios                                  { email, password, esAdminGlobal? }
 *   POST /admin/usuarios/:userId/empresas/:companyId      { role }
 *
 * Todo exige ser admin global -> el backend responde 403 si no lo eres.
 */

import { httpGet, httpPost } from '../utils/http';

export interface EmpresaAdmin {
  id: string;
  codigo?: string | null;
  nombre: string;
  fsBaseUrl: string;
  activa: boolean;
  creadoEn?: string;
}

export interface UsuarioAdmin {
  id: string;
  email: string;
  activo: boolean;
  /** IDs de empresas a las que pertenece (la lista /users expone `companies`). */
  empresas: string[];
}

export function listarEmpresas(): Promise<EmpresaAdmin[]> {
  return httpGet('/admin/empresas');
}

export function crearEmpresa(datos: { nombre: string; codigo?: string; fsBaseUrl: string; fsApiKey: string }): Promise<EmpresaAdmin> {
  return httpPost('/admin/empresas', datos);
}

/** Normaliza el usuario (la lista /users puede venir con isActive/isGlobalAdmin de Prisma). */
function aUsuario(u: Record<string, unknown>): UsuarioAdmin {
  return {
    id: String(u.id ?? ''),
    email: String(u.email ?? ''),
    activo: (u.activo ?? u.isActive ?? true) as boolean,
    empresas: (Array.isArray(u.companies) ? u.companies : Array.isArray(u.empresas) ? u.empresas : []) as string[],
  };
}

export async function listarUsuarios(): Promise<UsuarioAdmin[]> {
  const data = await httpGet<Record<string, unknown>[] | { items?: Record<string, unknown>[] }>('/users');
  const arr = Array.isArray(data) ? data : data?.items ?? [];
  return arr.map(aUsuario);
}

export function crearUsuario(datos: { email: string; password: string; esAdminGlobal?: boolean }): Promise<unknown> {
  return httpPost('/admin/usuarios', datos);
}

export function asignarUsuarioEmpresa(userId: string, companyId: string, role: string): Promise<unknown> {
  return httpPost(`/admin/usuarios/${userId}/empresas/${companyId}`, { role });
}
