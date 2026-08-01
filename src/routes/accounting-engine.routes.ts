/**
 * RUTAS DE CONTABILIZACIÓN - /api/accounting/*
 *
 * Endpoints para:
 * - Contabilizar facturas (automático/manual)
 * - Listar asientos
 * - Obtener detalle de asiento
 * - Aprobar asientos
 * - Recalcular asientos
 * - Ajustar líneas
 */

import { Router, Request, Response } from 'express';
import { accountingEngineController } from '../controllers/accounting-engine.controller';
import { authorize } from '../middleware/authorize.middleware';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { contabilizarQuerySchema } from '../schemas/accounting-engine.schemas';
import { HttpError } from '../utils/http-errors';

// mergeParams: hereda :companyId del router padre (/companies/:companyId/accounting).
export const accountingEngineRoutes = Router({ mergeParams: true });

/**
 * POST /api/companies/:companyId/accounting/contabilizar/:invoiceId
 *
 * Contabilizar factura manualmente (o disparar automático nuevamente)
 *
 * Query params:
 *   - tipo: 'INGRESO' | 'GASTO' (REQUERIDO)
 *   - mode: 'AUTO' | 'MANUAL' (default: AUTO)
 *
 * Response:
 *   { journalEntryId, estado: 'DRAFT' | 'PENDING_REVIEW', advertencias?: [] }
 */
accountingEngineRoutes.post(
  '/contabilizar/:invoiceId',
  authMiddleware,
  validate(contabilizarQuerySchema, 'query'),
  async (req: Request, res: Response) => {
    try {
      const { companyId, invoiceId } = req.params;
      const { tipo, mode = 'AUTO' } = req.query;

      const resultado =
        String(tipo) === 'INGRESO'
          ? await accountingEngineController.contabilizarFacturaIngreso(
              companyId,
              invoiceId,
              (mode as 'AUTO' | 'MANUAL') || 'AUTO'
            )
          : await accountingEngineController.contabilizarFacturaGasto(
              companyId,
              invoiceId,
              (mode as 'AUTO' | 'MANUAL') || 'AUTO'
            );

      res.json(resultado);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/accounting/journal-entries
 *
 * Listar asientos con filtros
 *
 * Query params:
 *   - estado: 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED'
 *   - desde: YYYY-MM-DD (fecha inicio)
 *   - hasta: YYYY-MM-DD (fecha fin)
 *   - origen: 'INCOME_INVOICE' | 'EXPENSE_INVOICE'
 *
 * Response: JournalEntry[]
 */
accountingEngineRoutes.get(
  '/journal-entries',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { estado, desde, hasta, origen } = req.query;

      const asientos = await accountingEngineController.listarAsientos(
        companyId,
        {
          estado: estado as string,
          desde: desde as string,
          hasta: hasta as string,
          origen: origen as string,
        }
      );

      res.json(asientos);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/accounting/journal-entries/:journalEntryId
 *
 * Obtener detalle completo de un asiento (para review/aprobación)
 *
 * Response:
 *   {
 *     asiento: JournalEntry,
 *     lineas: JournalEntryLine[],
 *     factura?: IncomeInvoice,
 *     validaciones: { cuadrado, errores, advertencias },
 *     permitidoAprobar: boolean,
 *     permitidoAjustar: boolean
 *   }
 */
accountingEngineRoutes.get(
  '/journal-entries/:journalEntryId',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId, journalEntryId } = req.params;
      const detalle = await accountingEngineController.obtenerAsientoDetallado(
        companyId,
        journalEntryId
      );
      res.json(detalle);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * POST /api/companies/:companyId/accounting/journal-entries/:journalEntryId/approve
 *
 * Aprobar/contabilizar un asiento (PENDING_REVIEW → POSTED)
 *
 * Body:
 *   { observaciones?: string }
 *
 * Auth: Requiere role 'contable' o 'admin'
 *
 * Response:
 *   { journalEntryId, estado: 'POSTED', contabilizadoEn: Date }
 */
accountingEngineRoutes.post(
  '/journal-entries/:journalEntryId/approve',
  authMiddleware,
  authorize('contabilidad:write'),
  async (req: Request, res: Response) => {
    try {
      const { companyId, journalEntryId } = req.params;
      const { observaciones } = req.body;
      const userId = req.user?.userId ?? 'unknown';

      const resultado = await accountingEngineController.aprobarAsiento(
        companyId,
        journalEntryId,
        userId,
        observaciones
      );

      res.json(resultado);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * POST /api/companies/:companyId/accounting/journal-entries/:journalEntryId/recalculate
 *
 * Recalcular un asiento (si factura fue modificada)
 *
 * Crea:
 * - Asiento de reversión (líneas opuestas, POSTED)
 * - Nuevo asiento (PENDING_REVIEW) con valores corregidos
 *
 * Auth: Requiere role 'contable' o 'admin'
 *
 * Response:
 *   { asientoReversado, asientoNuevo, estado: 'PENDING_REVIEW' }
 */
accountingEngineRoutes.post(
  '/journal-entries/:journalEntryId/recalculate',
  authMiddleware,
  authorize('contabilidad:write'),
  async (req: Request, res: Response) => {
    try {
      const { companyId, journalEntryId } = req.params;
      const userId = req.user?.userId ?? 'unknown';

      const resultado = await accountingEngineController.recalcularAsiento(
        companyId,
        journalEntryId,
        userId
      );

      res.json(resultado);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * PATCH /api/companies/:companyId/accounting/journal-entries/:journalEntryId/lines/:lineId
 *
 * Ajustar línea de asiento (cambiar cuenta, debe/haber)
 *
 * Restricciones:
 * - Solo si asiento está en DRAFT o PENDING_REVIEW
 * - Después de ajuste, DEBE validarse que debe = haber
 *
 * Body:
 *   { accountCode?: string, debe?: number, haber?: number }
 *
 * Auth: Requiere role 'contable' o 'admin'
 *
 * Response:
 *   { lineaActualizada: JournalEntryLine, asientoValidado: boolean }
 */
accountingEngineRoutes.patch(
  '/journal-entries/:journalEntryId/lines/:lineId',
  authMiddleware,
  authorize('contabilidad:write'),
  async (req: Request, res: Response) => {
    try {
      const { companyId, journalEntryId, lineId } = req.params;
      const { accountCode, debe, haber } = req.body;
      const userId = req.user?.userId ?? 'unknown';

      const resultado = await accountingEngineController.ajustarLineaAsiento(
        companyId,
        journalEntryId,
        lineId,
        { accountCode, debe, haber },
        userId
      );

      res.json(resultado);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);
