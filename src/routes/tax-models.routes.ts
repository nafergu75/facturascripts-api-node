/**
 * RUTAS DE MODELOS FISCALES - /api/companies/:companyId/tax-models
 *
 * Endpoints para:
 * - Borrador del 303, 111, 115 y 190 (los del 347, 390 y 200 estan en
 *   /impuestos/borradores; los del 349, 180 y 202, en borradores-aeat.routes)
 * - Marcar modelos como presentados
 */

import { Router } from 'express';
import { taxModelsController } from '../controllers/tax-models.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * GET /tax-models/303
 * Generar modelo 303 (IVA trimestral o mensual)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - trimestre: 1-4, o periodo: 1T-4T o 01-12 (mensual: REDEME o SII) (REQUERIDO uno de los dos)
 *   - tipoDeclaracion: I, U, C, D o N (opcional; por defecto el que toca por el resultado)
 *   - aCompensar: cuotas a compensar de periodos anteriores [110] (opcional; por defecto las del 303 anterior)
 *   - cuentaBancariaId: cuenta para domiciliar o para la devolucion (opcional; por defecto la primera activa)
 *
 * Devuelve el borrador con el diseno oficial 2026: casillas303 (numero,
 * descripcion de la AEAT e importe, las mismas que el fichero), tipo de
 * declaracion y los posibles, cuotas a compensar, cuentas, errores y avisos.
 */
router.get(
  '/303',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo303
);

/**
 * GET /tax-models/111
 * Generar modelo 111 (retenciones)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - periodo: 1T-4T o 01-12 (mensual: grandes empresas), o trimestre: 1-4
 */
router.get(
  '/111',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo111
);

/**
 * GET /tax-models/115
 * Modelo 115 (retenciones de alquileres)
 *
 * Query params:
 *   - ejercicio: number (REQUERIDO)
 *   - periodo: 1T-4T o 01-12 (mensual), o trimestre: 1-4. Sin ninguno, el resumen anual por arrendador (los datos del 180), sin guardar nada.
 */
router.get(
  '/115',
  authorize('impuestos:read'),
  taxModelsController.obtenerModelo115
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
