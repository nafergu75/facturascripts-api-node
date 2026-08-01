import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { financialReportsService } from '../services/reports.service';

/**
 * Parsea los query params de periodo en { fromDate, toDate }.
 *
 * Prioridad:
 *   1. fromDate + toDate  → rango exacto (YYYY-MM-DD)
 *   2. year + month       → mes completo
 *   3. year               → año completo
 *   4. ninguno            → 400
 *
 * fromDate se toma a las 00:00:00, toDate a las 23:59:59.
 */
function parsePeriod(query: Record<string, unknown>): { fromDate: Date; toDate: Date } {
  const { fromDate, toDate, year, month } = query as Record<string, string | undefined>;

  if (fromDate && toDate) {
    const from = new Date(fromDate);
    const to = new Date(toDate);
    if (isNaN(from.getTime())) throw badRequest('fromDate inválido. Usa YYYY-MM-DD.');
    if (isNaN(to.getTime())) throw badRequest('toDate inválido. Usa YYYY-MM-DD.');
    if (from > to) throw badRequest('fromDate debe ser anterior o igual a toDate.');
    to.setHours(23, 59, 59, 999);
    return { fromDate: from, toDate: to };
  }

  if (year) {
    const y = parseInt(year, 10);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) {
      throw badRequest('year inválido. Usa un año entre 2000 y 2100.');
    }

    if (month) {
      const m = parseInt(month, 10);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw badRequest('month inválido. Usa un número entre 1 y 12.');
      }
      return {
        fromDate: new Date(y, m - 1, 1, 0, 0, 0, 0),
        toDate: new Date(y, m, 0, 23, 59, 59, 999), // día 0 del mes siguiente = último del actual
      };
    }

    return {
      fromDate: new Date(y, 0, 1, 0, 0, 0, 0),
      toDate: new Date(y, 11, 31, 23, 59, 59, 999),
    };
  }

  throw badRequest(
    'Indica al menos uno de: fromDate+toDate | year+month | year.',
  );
}

export const reportsController = {
  /**
   * GET /companies/:companyId/reports/income
   * Ingresos contabilizados (base imponible de facturas emitidas del VATBook)
   */
  income: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getIncomeReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),

  /**
   * GET /companies/:companyId/reports/expenses
   * Gastos contabilizados (base imponible de facturas recibidas del VATBook)
   */
  expenses: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getExpensesReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),

  /**
   * GET /companies/:companyId/reports/result
   * Resultado = ingresos - gastos, desglosado por mes
   */
  result: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getResultReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),

  /**
   * GET /companies/:companyId/reports/vat
   * IVA repercutido vs soportado, cuota a ingresar/devolver
   */
  vat: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getVatReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),

  /**
   * GET /companies/:companyId/reports/retentions
   * Retenciones IRPF practicadas (RetentionBook), por mes y por tercero
   */
  retentions: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getRetentionReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),

  /**
   * GET /companies/:companyId/reports/treasury
   * Movimientos de tesorería (cuentas 57x POSTED), saldo apertura/cierre
   */
  treasury: asyncHandler(async (req, res) => {
    const { fromDate, toDate } = parsePeriod(req.query);
    const data = await financialReportsService.getTreasuryReport(
      req.companyId!,
      fromDate,
      toDate,
    );
    sendOk(res, data);
  }),
};
