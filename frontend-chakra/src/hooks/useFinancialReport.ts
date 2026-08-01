import { useState, useEffect, useCallback, useMemo } from 'react';
import { FinancialFilterState } from '../api/types';
import { filtersToParams } from '../api/reportsApi';
import { useCompanyId } from './useCompanyId';

function defaultFilters(): FinancialFilterState {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const today = now.toISOString().split('T')[0];
  return {
    mode: 'YEAR',
    year: y,
    month: m,
    fromDate: `${y}-01-01`,
    toDate: today,
  };
}

export interface UseFinancialReportResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Filtros pendientes (lo que el usuario ha seleccionado pero aún no ha aplicado) */
  filters: FinancialFilterState;
  /** Filtros actualmente aplicados y reflejados en los datos mostrados */
  appliedFilters: FinancialFilterState;
  /** true cuando hay cambios de filtro pendientes de aplicar */
  isDirty: boolean;
  setFilters: (f: FinancialFilterState) => void;
  /** Aplica los filtros pendientes y recarga los datos */
  apply: () => void;
  /** Recarga los datos con los filtros actualmente aplicados (útil para reintentar tras error) */
  retry: () => void;
}

export function useFinancialReport<T>(
  fetcher: (companyId: string, params: Record<string, string | number>) => Promise<T>,
): UseFinancialReportResult<T> {
  const companyId = useCompanyId();
  const [filters, setFilters] = useState<FinancialFilterState>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<FinancialFilterState>(defaultFilters);
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!companyId) return;
    const params = filtersToParams(appliedFilters);
    setLoading(true);
    setError(null);
    fetcher(companyId, params)
      .then(setData)
      .catch((e: any) => setError(e?.message || 'Error al cargar el informe'))
      .finally(() => setLoading(false));
  }, [companyId, appliedFilters, fetcher]);

  useEffect(() => { load(); }, [load]);

  const apply = useCallback(() => {
    setAppliedFilters({ ...filters });
  }, [filters]);

  // Crea una nueva referencia con los mismos valores → fuerza el useEffect
  const retry = useCallback(() => {
    setAppliedFilters(prev => ({ ...prev }));
  }, []);

  const isDirty = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(appliedFilters),
    [filters, appliedFilters],
  );

  return { data, loading, error, filters, appliedFilters, isDirty, setFilters, apply, retry };
}
