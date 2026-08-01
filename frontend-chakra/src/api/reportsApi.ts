/**
 * API Service - Reportes Financieros
 * Encapsula llamadas a endpoints de /reports/* y /tax/*
 */

import {
  BalanceSheetResponse,
  ProfitAndLossResponse,
  LedgerResponse,
  ReportDateRange,
  CustomerAnalysisResponse,
  MonthlyEvolutionResponse,
  IncomeReportData,
  ExpensesReportData,
  ResultReportData,
  VatReportData,
  RetentionReportData,
  TreasuryReportData,
  FinancialFilterState,
} from './types';
import { httpGet } from '../utils/http';

const REPORTS_BASE = '/companies/:companyId/reports';

// ============ BALANCE GENERAL ============

/**
 * Obtener Balance General
 */
export function getBalanceSheet(
  companyId: string,
  dateRange: ReportDateRange
): Promise<BalanceSheetResponse> {
  const endpoint = REPORTS_BASE.replace(':companyId', companyId) + '/balance';

  return httpGet<BalanceSheetResponse>(endpoint, {
    from: dateRange.from,
    to: dateRange.to
  });
}

// ============ PÉRDIDAS Y GANANCIAS ============

/**
 * Obtener Pérdidas y Ganancias
 */
export function getProfitAndLoss(
  companyId: string,
  dateRange: ReportDateRange
): Promise<ProfitAndLossResponse> {
  const endpoint = REPORTS_BASE.replace(':companyId', companyId) + '/profit-and-loss';

  return httpGet<ProfitAndLossResponse>(endpoint, {
    from: dateRange.from,
    to: dateRange.to
  });
}

// ============ ANÁLISIS ============

/**
 * Obtener evolución mensual
 */
export function getMonthlyEvolution(
  companyId: string,
  year: number
): Promise<MonthlyEvolutionResponse> {
  const endpoint = REPORTS_BASE.replace(':companyId', companyId) + '/analytics/monthly';

  return httpGet<MonthlyEvolutionResponse>(endpoint, {
    year
  });
}

// ============ MAYOR POR CUENTA ============

/**
 * Obtener Mayor de una cuenta (ledger)
 */
export function getLedger(
  companyId: string,
  accountCode: string,
  from: string,
  to: string
): Promise<LedgerResponse> {
  const endpoint = REPORTS_BASE.replace(':companyId', companyId) + '/ledger';

  return httpGet<LedgerResponse>(endpoint, {
    accountCode,
    from,
    to
  });
}

// ============ ANÁLISIS POR CLIENTE ============

/**
 * Obtener análisis de ingresos por cliente
 */
export function getCustomerAnalysis(
  companyId: string,
  from: string,
  to: string
): Promise<CustomerAnalysisResponse> {
  const endpoint = REPORTS_BASE.replace(':companyId', companyId) + '/analytics/by-customer';

  return httpGet<CustomerAnalysisResponse>(endpoint, {
    from,
    to
  });
}

// ============ INFORMES FINANCIEROS (módulo front) ============

/** Convierte el estado de filtros en query params para el backend */
export function filtersToParams(f: FinancialFilterState): Record<string, string | number> {
  if (f.mode === 'RANGE') return { fromDate: f.fromDate, toDate: f.toDate };
  if (f.mode === 'MONTH') return { year: f.year, month: f.month };
  return { year: f.year };
}

function reportsEndpoint(companyId: string, path: string): string {
  return REPORTS_BASE.replace(':companyId', companyId) + path;
}

export function getIncomeReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<IncomeReportData> {
  return httpGet<IncomeReportData>(reportsEndpoint(companyId, '/income'), params);
}

export function getExpensesReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<ExpensesReportData> {
  return httpGet<ExpensesReportData>(reportsEndpoint(companyId, '/expenses'), params);
}

export function getResultReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<ResultReportData> {
  return httpGet<ResultReportData>(reportsEndpoint(companyId, '/result'), params);
}

export function getVatReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<VatReportData> {
  return httpGet<VatReportData>(reportsEndpoint(companyId, '/vat'), params);
}

export function getRetentionReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<RetentionReportData> {
  return httpGet<RetentionReportData>(reportsEndpoint(companyId, '/retentions'), params);
}

export function getTreasuryReport(
  companyId: string,
  params: Record<string, string | number>
): Promise<TreasuryReportData> {
  return httpGet<TreasuryReportData>(reportsEndpoint(companyId, '/treasury'), params);
}
