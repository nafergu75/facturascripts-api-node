/**
 * Tipos de respuesta de API - Motor Contable y Reportes
 */

// ============ Asientos Contables ============

export interface JournalEntryLine {
  id: string;
  accountCode: string;
  accountName: string;
  debe?: number;
  haber?: number;
  descripcion?: string;
}

export interface JournalEntry {
  id: string;
  numeroAsiento: string;
  estado: 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';
  /** Campo real en el modelo Prisma: `fecha` (no fechaAsiento). */
  fecha: string;
  /** @deprecated Alias para compatibilidad — usar `fecha` */
  fechaAsiento?: string;
  /** El backend escribe FACTURA_INGRESO / FACTURA_GASTO para asientos del motor contable. */
  origen?: 'FACTURA_INGRESO' | 'FACTURA_GASTO' | 'INCOME_INVOICE' | 'EXPENSE_INVOICE' | 'MANUAL' | 'REVERSAL' | string;
  invoiceId?: string;
  invoiceType?: 'INGRESO' | 'GASTO';
  facturaId?: string;
  lineas: JournalEntryLine[];
  totalDebe: number;
  totalHaber: number;
  createdAt: string;
  createdBy?: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface JournalEntryDetail extends JournalEntry {
  validaciones: {
    cuadrado: boolean;
    errores: string[];
  };
  permitidoAprobar: boolean;
  permitidoAjustar: boolean;
}

// ============ Balance General ============

export interface BalanceSheetResponse {
  fecha: string;
  activo: {
    noCirculante: number;
    circulante: number;
  };
  pasivo: {
    noCirculante: number;
    circulante: number;
  };
  patrimonioNeto: number;
}

// ============ Pérdidas y Ganancias ============

export interface ProfitAndLossResponse {
  desde: string;
  hasta: string;
  ingresos: number;
  gastos: number;
  resultadoExplotacion: number;
}

// ============ Respuestas Genéricas ============

export interface APIResponse<T> {
  data?: T;
  message?: string;
  error?: string;
  statusCode?: number;
}

export interface APIErrorResponse {
  statusCode: number;
  message: string;
  details?: Record<string, any>;
}

// ============ Request Bodies ============

export interface ApproveJournalEntryRequest {
  observaciones?: string;
}

export interface AdjustJournalEntryLineRequest {
  accountCode?: string;
  debe?: number;
  haber?: number;
}

// ============ Filter Types ============

export interface JournalEntryFilters {
  estado?: 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';
  origen?: string;
  from?: string; // ISO date
  to?: string;   // ISO date
  skip?: number;
  take?: number;
}

export interface ReportDateRange {
  from: string; // ISO date
  to: string;   // ISO date
}

// ============ Libros de IVA ============

export interface VatBookEntry {
  fecha: string;
  numero: string;
  nif: string;
  nombre: string;
  base: number;
  tipoIva: number;
  cuota: number;
}

export interface VatBooksResponse {
  periodo: string;
  facturas: VatBookEntry[];
  totalBases: number;
  totalCuotas: number;
}

// ============ Resumen Hacienda (IVA, Retenciones) ============

export interface VatSummaryResponse {
  periodo: string; // Q1-2026
  emitidas: {
    totalBases: number;
    totalCuotas: number;
  };
  recibidas: {
    totalBases: number;
    totalCuotas: number;
  };
  cuotaAIngresar: number; // Positivo = ingresar; Negativo = devolver
  deuda: boolean;
}

export interface RetentionEntry {
  nif: string;
  nombre: string;
  tipo: string; // PROFESIONAL, ARRENDAMIENTO, CAPITAL, etc.
  porcentaje: number;
  base: number;
  cuota: number;
}

export interface RetentionSummaryResponse {
  ano: number;
  retenciones: RetentionEntry[];
  totalBases: number;
  totalRetenciones: number;
}

// ============ Mayor por Cuenta (Ledger) ============

export interface LedgerMovimiento {
  fecha: string;
  referencia: string;
  debe: number;
  haber: number;
}

export interface LedgerResponse {
  cuenta: string;
  movimientos: LedgerMovimiento[];
  saldoFinal: number;
}

// ============ Análisis por Cliente ============

export interface CustomerAnalysisItem {
  id: string;
  nombre: string;
  totalFacturado: number;
  saldoPendiente: number;
}

export interface CustomerAnalysisResponse {
  clientes: CustomerAnalysisItem[];
}

// ============ Evolución Mensual ============

export interface MonthlyEvolutionItem {
  mes: string; // '2026-01'
  ingresos: number;
  gastos: number;
  beneficio: number;
}

export interface MonthlyEvolutionMesData {
  ingresos: number;
  gastos: number;
  beneficio: number;
}

export interface MonthlyEvolutionResponse {
  year: number;
  meses: Record<string, MonthlyEvolutionMesData>; // keys '01'..'12'
}

// ============ Módulo de Informes Financieros ============

export type FilterMode = 'YEAR' | 'MONTH' | 'RANGE';

export interface FinancialFilterState {
  mode: FilterMode;
  year: number;
  month: number;
  fromDate: string;
  toDate: string;
}

export interface ReportPeriod {
  from: string;
  to: string;
}

// Ingresos
export interface IncomeReportData {
  companyId: string;
  period: ReportPeriod;
  summary: { totalIncome: number; currency: string };
  byDay: Array<{ date: string; amount: number }>;
  byMonth: Array<{ year: number; month: number; amount: number }>;
}

// Gastos
export interface ExpensesReportData {
  companyId: string;
  period: ReportPeriod;
  summary: { totalExpenses: number; currency: string };
  byDay: Array<{ date: string; amount: number }>;
  byMonth: Array<{ year: number; month: number; amount: number }>;
}

// Resultado
export interface ResultReportData {
  companyId: string;
  period: ReportPeriod;
  summary: { totalIncome: number; totalExpenses: number; result: number; currency: string };
  byMonth: Array<{ year: number; month: number; income: number; expenses: number; result: number }>;
}

// IVA
export interface VatReportData {
  companyId: string;
  period: ReportPeriod;
  summary: { vatOutput: number; vatInput: number; vatPayable: number; currency: string };
  byMonth: Array<{ year: number; month: number; vatOutput: number; vatInput: number; vatPayable: number }>;
}

// Retenciones
export interface RetentionReportData {
  companyId: string;
  period: ReportPeriod;
  summary: { totalRetentions: number; currency: string };
  byMonth: Array<{ year: number; month: number; amount: number }>;
  byProvider: Array<{ nif: string; nombre: string; tipo: string; base: number; retencion: number }>;
}

// Tesorería
export interface TreasuryReportData {
  companyId: string;
  period: ReportPeriod;
  summary: {
    openingBalance: number;
    closingBalance: number;
    totalIn: number;
    totalOut: number;
    currency: string;
  };
  movements: Array<{ date: string; description: string; reference: string; amount: number; balance: number }>;
}
