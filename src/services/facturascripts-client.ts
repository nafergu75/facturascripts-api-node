import axios, { AxiosError, AxiosInstance } from 'axios';
import { prisma } from '../config/database';
import { decrypt } from '../utils/crypto';
import { FacturaScriptsError, notFound } from '../utils/http-errors';
import { logger } from '../config/logger';

/**
 * Cliente HTTP hacia la API REST de una instancia de FacturaScripts.
 *
 * Multiempresa "1 FS por empresa": NO es un singleton. Se construye por empresa
 * a partir de su fsBaseUrl + su FS_API_KEY (descifrada desde la BD).
 *
 * Formatos de la API de FacturaScripts:
 *  - Token en header `Token` (y `X-Auth-Token`).
 *  - POST/PUT esperan `application/x-www-form-urlencoded`, NO JSON.
 *  - GET lista  -> array JSON; total en header `X-Total-Count`.
 *  - GET uno    -> objeto JSON.
 *  - POST/PUT/DELETE -> { ok: <mensaje>, data: <registro> }.
 *  - Errores    -> { error: <mensaje> } con status 4xx/5xx.
 */

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

export interface FsList {
  items: unknown[];
  total: number;
}

export interface FsClient {
  listWithMeta(resource: string, params?: Record<string, unknown>): Promise<FsList>;
  getOne(resource: string, code: string | number): Promise<unknown>;
  create(resource: string, data: Record<string, unknown>): Promise<unknown>;
  update(resource: string, code: string | number, data: Record<string, unknown>): Promise<unknown>;
  remove(resource: string, code: string | number): Promise<unknown>;
}

function toForm(data: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }
  return params.toString();
}

function unwrap(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as Record<string, unknown>).data;
  }
  return payload;
}

/** Construye un FsClient para una base URL + API key concretas. */
export function createFsClient(baseUrl: string, apiKey: string): FsClient {
  const http: AxiosInstance = axios.create({
    baseURL: baseUrl,
    timeout: 10_000,
    headers: { Token: apiKey, 'X-Auth-Token': apiKey },
  });

  http.interceptors.response.use(
    (res) => res,
    (error: AxiosError) => {
      const status = error.response?.status ?? 502;
      const data = error.response?.data as { error?: string; message?: string } | undefined;
      const message =
        data?.error ?? data?.message ?? error.message ?? 'Error al contactar con FacturaScripts';
      logger.error(`FacturaScripts API error (${status}): ${message}`);
      return Promise.reject(new FacturaScriptsError(status, message, error.response?.data));
    },
  );

  return {
    async listWithMeta(resource, params = {}) {
      const res = await http.get(`/${resource}`, { params });
      const items = Array.isArray(res.data) ? res.data : [];
      const header = res.headers['x-total-count'];
      const total = header !== undefined ? Number(header) : items.length;
      return { items, total };
    },
    async getOne(resource, code) {
      const res = await http.get(`/${resource}/${code}`);
      return res.data;
    },
    async create(resource, data) {
      const res = await http.post(`/${resource}`, toForm(data), { headers: FORM_HEADERS });
      return unwrap(res.data);
    },
    async update(resource, code, data) {
      const res = await http.put(`/${resource}/${code}`, toForm(data), { headers: FORM_HEADERS });
      return unwrap(res.data);
    },
    async remove(resource, code) {
      const res = await http.delete(`/${resource}/${code}`);
      return unwrap(res.data);
    },
  };
}

/**
 * Devuelve un FsClient configurado para la empresa indicada, cargando su
 * fsBaseUrl y descifrando su FS_API_KEY desde la BD.
 */
export async function getFsClientForCompany(companyId: string): Promise<FsClient> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company || !company.isActive) {
    throw notFound('Empresa no encontrada o inactiva.');
  }
  return createFsClient(company.fsBaseUrl, decrypt(company.fsApiKeyEnc));
}
