/**
 * RUTAS DE HACIENDA - /api/tax/*
 *
 * Endpoints para:
 * - Libros de IVA (emitidas/recibidas)
 * - Resúmenes fiscales (303, 190)
 * - Exportación de modelos
 */

import { Router, Request, Response } from 'express';
import { taxDocumentsService } from '../services/tax-documents.service';
import { authMiddleware } from '../middleware/auth.middleware';
import { HttpError } from '../utils/http-errors';

// mergeParams: hereda :companyId del router padre (/companies/:companyId/tax).
export const taxRoutes = Router({ mergeParams: true });

/**
 * GET /api/companies/:companyId/tax/vat/books/issued
 *
 * Libro de Facturas Emitidas (IVA Repercutido)
 *
 * Query params:
 *   - period: string (REQUERIDO) - Formato Q1-2026, Q2-2026, etc.
 *
 * Response:
 *   {
 *     periodo,
 *     facturas: [ { fecha, numero, nif, nombre, base, tipoIva, cuota } ],
 *     totalBases,
 *     totalCuotas
 *   }
 */
taxRoutes.get(
  '/vat/books/issued',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { period } = req.query;

      if (!period) {
        return res.status(400).json({
          error:
            'Parameter "period" required (format: Q1-2026, Q2-2026, Q3-2026, Q4-2026)',
        });
      }

      const libro = await taxDocumentsService.obtenerLibroIVAEmitidas(
        companyId,
        period as string
      );

      res.json(libro);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/tax/vat/books/received
 *
 * Libro de Facturas Recibidas (IVA Soportado)
 *
 * Query params:
 *   - period: string (REQUERIDO) - Formato Q1-2026, Q2-2026, etc.
 *
 * Response:
 *   {
 *     periodo,
 *     facturas: [ { fecha, numero, nif, nombre, base, tipoIva, cuota } ],
 *     totalBases,
 *     totalCuotas
 *   }
 */
taxRoutes.get(
  '/vat/books/received',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { period } = req.query;

      if (!period) {
        return res.status(400).json({
          error:
            'Parameter "period" required (format: Q1-2026, Q2-2026, Q3-2026, Q4-2026)',
        });
      }

      const libro = await taxDocumentsService.obtenerLibroIVARecibidas(
        companyId,
        period as string
      );

      res.json(libro);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/tax/vat/summary
 *
 * Resumen 303 (IVA Trimestral)
 *
 * Query params:
 *   - period: string (REQUERIDO) - Q1-2026, Q2-2026, etc.
 *
 * Response:
 *   {
 *     periodo,
 *     emitidas: { totalBases, totalCuotas },
 *     recibidas: { totalBases, totalCuotas },
 *     cuotaAIngresar,
 *     deuda: boolean
 *   }
 */
taxRoutes.get(
  '/vat/summary',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { period } = req.query;

      if (!period) {
        return res.status(400).json({
          error: 'Parameter "period" required (format: Q1-2026, etc.)',
        });
      }

      const resumen = await taxDocumentsService.obtenerResumen303(
        companyId,
        period as string
      );

      res.json(resumen);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/tax/retentions/summary
 *
 * Resumen 190 (Retenciones)
 *
 * Query params:
 *   - year: number (REQUERIDO) - Año fiscal
 *
 * Response:
 *   {
 *     ano,
 *     retenciones: [ { nif, nombre, tipo, porcentaje, base, cuota } ],
 *     totalBases,
 *     totalRetenciones
 *   }
 */
taxRoutes.get(
  '/retentions/summary',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { year } = req.query;

      if (!year) {
        return res.status(400).json({
          error: 'Parameter "year" required (e.g. 2026)',
        });
      }

      const resumen = await taxDocumentsService.obtenerResumen190(
        companyId,
        parseInt(year as string)
      );

      res.json(resumen);
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);

/**
 * GET /api/companies/:companyId/tax/export/modelo-303
 *
 * Exportar Modelo 303 (borrador)
 *
 * Query params:
 *   - period: string (REQUERIDO) - Q1-2026, Q2-2026, etc.
 *   - format: 'txt' | 'json' (default: json)
 *
 * Response:
 *   - Si format=txt: String con contenido TXT
 *   - Si format=json: Object con datos del modelo
 */
taxRoutes.get(
  '/export/modelo-303',
  authMiddleware,
  async (req: Request, res: Response) => {
    try {
      const { companyId } = req.params;
      const { period, format = 'json' } = req.query;

      if (!period) {
        return res.status(400).json({
          error:
            'Parameter "period" required (format: Q1-2026, Q2-2026, etc.)',
        });
      }

      if (
        format &&
        !['txt', 'json'].includes(String(format))
      ) {
        return res.status(400).json({
          error: 'Parameter "format" must be txt or json',
        });
      }

      const exportado = await taxDocumentsService.exportarModelo303(
        companyId,
        period as string,
        (format as 'txt' | 'json') || 'json'
      );

      if (format === 'txt') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.send(exportado);
      } else {
        res.json(exportado);
      }
    } catch (err) {
      const statusCode =
        err instanceof HttpError ? err.statusCode : 400;
      const message = err instanceof Error ? err.message : String(err);
      res.status(statusCode).json({ error: message });
    }
  }
);
