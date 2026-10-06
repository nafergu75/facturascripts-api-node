/**
 * RUTAS DE MODELOS FISCALES - /api/companies/:companyId/tax-models
 *
 * Endpoints para:
 * - Generar modelo 303 (IVA trimestral)
 * - Generar modelo 111 (retenciones trimestral)
 * - Generar modelo 200 (impuesto de sociedades anual)
 * - Generar modelo 347 (operaciones con terceros anual)
 * - Generar modelo 115 (arrendamientos locales trimestral)
 * - Generar modelo 390 (resumen anual de IVA)
 * - Generar modelo 190 (resumen anual de retenciones)
 * - Marcar modelos como presentados
 */

import { Router } from 'express';
import { taxModelsController } from '../controllers/tax-models.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * GET /tax-models/303
 * Generar modelo 303 (IVA trimestral)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - trimestre: 1-4 (REQUERIDO)
 */
router.get(
  '/303',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo303
);

/**
 * POST /tax-models/303/presentado
 * Marcar modelo 303 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     trimestre: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/303/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar303Presentado
);

/**
 * GET /tax-models/111
 * Generar modelo 111 (retenciones)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - trimestre: 1-4 (REQUERIDO)
 */
router.get(
  '/111',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo111
);

/**
 * POST /tax-models/111/presentado
 * Marcar modelo 111 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     trimestre: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/111/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar111Presentado
);

/**
 * GET /tax-models/200
 * Generar modelo 200 (impuesto de sociedades)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 */
router.get(
  '/200',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo200
);

/**
 * POST /tax-models/200/presentado
 * Marcar modelo 200 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/200/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar200Presentado
);

/**
 * GET /tax-models/347
 * Generar modelo 347 (operaciones con terceros)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 */
router.get(
  '/347',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo347
);

/**
 * POST /tax-models/347/presentado
 * Marcar modelo 347 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/347/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar347Presentado
);

/**
 * GET /tax-models/115
 * Generar modelo 115 (arrendamientos locales)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - trimestre: 1-4 (REQUERIDO)
 */
router.get(
  '/115',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo115
);

/**
 * POST /tax-models/115/presentado
 * Marcar modelo 115 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     trimestre: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/115/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar115Presentado
);

/**
 * GET /tax-models/390
 * Generar modelo 390 (resumen anual de IVA)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 */
router.get(
  '/390',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo390
);

/**
 * POST /tax-models/390/presentado
 * Marcar modelo 390 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/390/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar390Presentado
);

/**
 * GET /tax-models/190
 * Generar modelo 190 (resumen anual de retenciones)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 */
router.get(
  '/190',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo190
);

/**
 * POST /tax-models/190/presentado
 * Marcar modelo 190 como presentado
 *
 * Body:
 *   {
 *     ejercicio: number,
 *     justificante: { numero: string, fecha: string }
 *   }
 */
router.post(
  '/190/presentado',
  authorize('impuestos:write'),
  taxModelsController.marcar190Presentado
);

/**
 * GET /tax-models
 * Listar modelos por empresa
 *
 * Query params:
 *   - codigo: '303' | '111' | '200' | '347' | '115' | '390' | '190' (opcional)
 *   - ejercicio: number (opcional)
 */
router.get(
  '/',
  authorize('impuestos:read'),
  taxModelsController.listarModelos
);

/**
 * GET /tax-models/:codigo/:ejercicio/:periodo
 * Obtener modelo específico
 */
router.get(
  '/:codigo/:ejercicio/:periodo',
  authorize('impuestos:read'),
  taxModelsController.obtenerModeloEspecifico
);

export default router;
