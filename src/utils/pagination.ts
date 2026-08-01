export interface PaginationParams {
  limit: number;
  offset: number;
  page: number;
}

/**
 * Normaliza parametros de paginacion desde la query.
 * Soporta tanto `page` como `offset` directo; `limit` acotado a un maximo.
 */
export function parsePagination(
  query: Record<string, unknown>,
  defaults = { limit: 50, maxLimit: 200 },
): PaginationParams {
  const rawLimit = Number(query.limit ?? defaults.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, rawLimit), defaults.maxLimit)
    : defaults.limit;

  const rawPage = Number(query.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

  const rawOffset = query.offset !== undefined ? Number(query.offset) : (page - 1) * limit;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;

  return { limit, offset, page };
}
