import { Router, raw } from 'express';
import { accountingClosureController } from '../controllers/accounting-closure.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

/**
 * Crear cierre de período.
 * POST /api/accounting/closures
 */
router.post('/', authorize('contable'), accountingClosureController.crearCierre);

/**
 * Listar cierres.
 * GET /api/accounting/closures?estado=CERRADO&desde=2024&hasta=2025
 */
router.get('/', accountingClosureController.listarCierres);

/**
 * Obtener cierre por ejercicio.
 * GET /api/accounting/closures/2024
 */
router.get('/:ejercicio', accountingClosureController.obtenerCierre);

/**
 * Cambiar estado de cierre.
 * PATCH /api/accounting/closures/2024/status
 */
router.patch(
  '/:ejercicio/status',
  authorize('contable'),
  accountingClosureController.cambiarEstado,
);

/**
 * Subir archivo de cierre (PDF, Excel).
 * POST /api/accounting/closures/2024/upload?tipoContenido=BALANCE_GENERAL
 */
router.post(
  '/:ejercicio/upload',
  authorize('contable'),
  raw({ type: ['application/json', 'text/plain', 'application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: '10mb' }),
  accountingClosureController.subirArchivo,
);

/**
 * Listar archivos de cierre.
 * GET /api/accounting/closures/2024/files
 */
router.get('/:ejercicio/files', accountingClosureController.listarArchivos);

/**
 * Guardar datos de ejercicio anterior.
 * POST /api/accounting/prior-years
 */
router.post('/prior-years', authorize('contable'), accountingClosureController.guardarDatosAnterior);

/**
 * Obtener datos de ejercicio anterior.
 * GET /api/accounting/prior-years/2023
 */
router.get('/prior-years/:ejercicio', accountingClosureController.obtenerDatosAnterior);

/**
 * Listar ejercicios anteriores.
 * GET /api/accounting/prior-years
 */
router.get('/prior-years', accountingClosureController.listarEjerciciosAnteriores);

/**
 * Obtener comparativa entre dos años.
 * GET /api/accounting/comparativas/2023/2024
 */
router.get('/comparativas/:ej1/:ej2', accountingClosureController.obtenerComparativa);

export default router;
