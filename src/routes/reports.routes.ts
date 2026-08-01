/**
 * RUTAS DE INFORMES - /api/reports/*
 *
 * Endpoints para:
 * - Balance General
 * - Cuenta de Pérdidas y Ganancias
 * - Mayor por cuenta
 * - Evolución mensual
 * - Análisis por cliente
 */

import { Router, Request, Response } from 'express';
import { reportsService } from '../services/reports.service';
import { authMiddleware } from '../middleware/auth.middleware';
import { HttpError } from '../utils/http-errors';
import { reportsController } from '../controllers/reports.controller';

// mergeParams: hereda :companyId del router padre (/companies/:companyId/reports).
export const reportsRoutes = Router({ mergeParams: true });

/**
 * GET /api/companies/:companyId/reports/balance
 *
 * Balance General (Activo/Pasivo/Patrimonio)
 *
 * Query params:
 *   - from: YYYY-MM-DD (REQUERIDO)
 *   - to: YYYY-MM-DD (REQUERIDO)
 *
 * Response:
 *   {
 *     fecha,
 *     activo: { noCirculante, circulante },
 *     pasivo: { noCirculante, circulante },
 *     patrimonioNeto
 *   }
 */
reportsRoutes.get(
  '/balance',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { from, to } = req.query;

      if (!from || !to) {
        return res
          .status(400)
          .json({
            error:
              'Parameters "from" and "to" required (format: YYYY-MM-DD)',
          });
      }

      const balance = await reportsService.obtenerBalance(
        companyId,
        from as string,
        to as string
      );

      res.json(balance);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/reports/profit-and-loss
 *
 * Cuenta de Pérdidas y Ganancias (Ingresos - Gastos)
 *
 * Query params:
 *   - from: YYYY-MM-DD (REQUERIDO)
 *   - to: YYYY-MM-DD (REQUERIDO)
 *
 * Response:
 *   { desde, hasta, ingresos, gastos, resultadoExplotacion }
 */
reportsRoutes.get(
  '/profit-and-loss',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { from, to } = req.query;

      if (!from || !to) {
        return res
          .status(400)
          .json({ error: 'Parameters "from" and "to" required' });
      }

      const pyg = await reportsService.obtenerPyG(
        companyId,
        from as string,
        to as string
      );

      res.json(pyg);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/reports/ledger
 *
 * Mayor de una cuenta (movimientos debe/haber)
 *
 * Query params:
 *   - accountCode: string (REQUERIDO) - Código PGC (ej. "700")
 *   - from: YYYY-MM-DD (REQUERIDO)
 *   - to: YYYY-MM-DD (REQUERIDO)
 *
 * Response:
 *   {
 *     cuenta: string,
 *     movimientos: [{ fecha, referencia, debe, haber }],
 *     saldoFinal: number
 *   }
 */
reportsRoutes.get(
  '/ledger',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { accountCode, from, to } = req.query;

      if (!accountCode || !from || !to) {
        return res.status(400).json({
          error:
            'Parameters "accountCode", "from", "to" required',
        });
      }

      const mayor = await reportsService.obtenerMayor(
        companyId,
        accountCode as string,
        from as string,
        to as string
      );

      res.json(mayor);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/reports/analytics/monthly
 *
 * Evolución de ingresos/gastos/beneficio por mes
 *
 * Query params:
 *   - year: number (REQUERIDO) - Año (ej. 2026)
 *
 * Response:
 *   {
 *     year,
 *     meses: {
 *       "01": { ingresos, gastos, beneficio },
 *       "02": { ... },
 *       ...
 *     }
 *   }
 */
reportsRoutes.get(
  '/analytics/monthly',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { year } = req.query;

      if (!year) {
        return res
          .status(400)
          .json({ error: 'Parameter "year" required (e.g. 2026)' });
      }

      const evolucion = await reportsService.obtenerEvolucionMensual(
        companyId,
        parseInt(year as string)
      );

      res.json(evolucion);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/reports/analytics/by-customer
 *
 * Análisis de facturación por cliente (total facturado, saldo pendiente)
 *
 * Query params:
 *   - from: YYYY-MM-DD (REQUERIDO)
 *   - to: YYYY-MM-DD (REQUERIDO)
 *
 * Response:
 *   {
 *     clientes: [
 *       { id, nombre, totalFacturado, saldoPendiente },
 *       ...
 *     ]
 *   }
 */
reportsRoutes.get(
  '/analytics/by-customer',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { from, to } = req.query;

      if (!from || !to) {
        return res
          .status(400)
          .json({ error: 'Parameters "from" and "to" required' });
      }

      const analisis = await reportsService.obtenerAnalisisPorCliente(
        companyId,
        from as string,
        to as string
      );

      res.json(analisis);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Informes financieros estructurados (módulo front)
// Todos aceptan: ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
//            o: ?year=2026&month=1
//            o: ?year=2026
// ─────────────────────────────────────────────────────────────────────────────

/** GET /companies/:companyId/reports/income — Ingresos contabilizados */
reportsRoutes.get('/income', reportsController.income);

/** GET /companies/:companyId/reports/expenses — Gastos contabilizados */
reportsRoutes.get('/expenses', reportsController.expenses);

/** GET /companies/:companyId/reports/result — Resultado (ingresos - gastos) */
reportsRoutes.get('/result', reportsController.result);

/** GET /companies/:companyId/reports/vat — IVA repercutido vs soportado */
reportsRoutes.get('/vat', reportsController.vat);

/** GET /companies/:companyId/reports/retentions — Retenciones IRPF practicadas */
reportsRoutes.get('/retentions', reportsController.retentions);

/** GET /companies/:companyId/reports/treasury — Tesorería (cuentas 57x POSTED) */
reportsRoutes.get('/treasury', reportsController.treasury);
