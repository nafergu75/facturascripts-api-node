import { CompanyScopedService, ID, Paginated } from '../domain/common.types';
import { getFsClientForCompany } from './facturascripts-client';
import { notImplemented } from '../utils/http-errors';

export interface SalesDocFiltro {
  page?: number | string;
  pageSize?: number | string;
  desde?: string; // fecha >=
  hasta?: string; // fecha <=
  clienteCodigo?: string; // codcliente
}

/**
 * Traduce el DTO amigable a la query real de la API de FacturaScripts:
 *  - page/pageSize -> limit/offset
 *  - desde/hasta   -> filter[fecha_gte] / filter[fecha_lte]
 *  - clienteCodigo -> filter[codcliente]
 *  - orden por fecha descendente (sort[fecha]=DESC)
 */
export function buildSalesDocQuery(filtro: SalesDocFiltro): {
  page: number;
  pageSize: number;
  fsParams: Record<string, unknown>;
} {
  const page = Math.max(1, Number(filtro.page ?? 1) || 1);
  const pageSize = Math.min(Math.max(1, Number(filtro.pageSize ?? 50) || 50), 200);

  const fsParams: Record<string, unknown> = {
    limit: pageSize,
    offset: (page - 1) * pageSize,
    'sort[fecha]': 'DESC',
  };

  if (filtro.desde) fsParams['filter[fecha_gte]'] = filtro.desde;
  if (filtro.hasta) fsParams['filter[fecha_lte]'] = filtro.hasta;
  if (filtro.clienteCodigo) fsParams['filter[codcliente]'] = filtro.clienteCodigo;

  return { page, pageSize, fsParams };
}

/**
 * Crea un CompanyScopedService de listado para un recurso de documento de venta
 * de FacturaScripts (facturaclientes, pedidoclientes, albaranclientes,
 * presupuestoclientes). list + getById implementados; create/update/remove se
 * abordan en el slice del POST enriquecido (crearFacturaCliente y homologos).
 */
export function createSalesDocumentService<T = Record<string, unknown>>(
  resource: string,
): CompanyScopedService<T> {
  return {
    async list(companyId: ID, params: Record<string, unknown> = {}): Promise<Paginated<T>> {
      const { page, pageSize, fsParams } = buildSalesDocQuery(params as SalesDocFiltro);
      const fs = await getFsClientForCompany(companyId);
      const { items, total } = await fs.listWithMeta(resource, fsParams);
      return { items: items as T[], total, limit: pageSize, offset: (page - 1) * pageSize };
    },

    async getById(companyId: ID, id: ID): Promise<T> {
      const fs = await getFsClientForCompany(companyId);
      return (await fs.getOne(resource, id)) as T;
    },

    async create(): Promise<T> {
      throw notImplemented('Creacion de documento: usar el endpoint compuesto (crearFacturaCliente y homologos).');
    },
    async update(): Promise<T> {
      throw notImplemented('Edicion de documento: pendiente.');
    },
    async remove(): Promise<void> {
      throw notImplemented('Baja de documento: pendiente.');
    },
  };
}
