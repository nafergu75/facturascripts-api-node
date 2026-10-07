import { Router, raw } from 'express';
import { accountingClosureController } from '../controllers/accounting-closure.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';

/**
 * Archivo de documentos de cierre (/accounting/closures). OJO: su estado NO es
 * el estado del ejercicio (ese lo llevan FiscalYear y Cierre y traspaso de
 * saldos).
 *
 * Las rutas fijas (prior-years, generar-asiento, comparativas) van ANTES que
 * las de '/:ejercicio': antes GET '/:ejercicio' iba primero y GET '/prior-years'
 * nunca se alcanzaba (se buscaba el cierre del ejercicio "prior-years").
 */
const router = Router({ mergeParams: true });

/** :ejercicio y :ej1/:ej2 son años de cuatro cifras; cualquier otra cosa es un 400 claro. */
const exigirAnio = (_req: unknown, _res: unknown, next: (err?: unknown) => void, valor: string) =>
  next(/^\d{4}$/.test(valor) ? undefined : badRequest(`"${valor}" no es un ejercicio válido: indica el año con cuatro cifras (por ejemplo, 2025).`));
router.param('ejercicio', exigirAnio);
router.param('ej1', exigirAnio);
router.param('ej2', exigirAnio);

// --- Rutas fijas ---

/**
 * Crear cierre de período.
 * POST /api/accounting/closures
 */
router.post('/', authorize('contabilidad:write'), accountingClosureController.crearCierre);

/**
 * Listar cierres.
 * GET /api/accounting/closures?estado=CERRADO&desde=2024&hasta=2025
 */
router.get('/', accountingClosureController.listarCierres);

/**
 * Listar ejercicios anteriores.
 * GET /api/accounting/closures/prior-years
 */
router.get('/prior-years', accountingClosureController.listarEjerciciosAnteriores);

/**
 * Guardar datos de ejercicio anterior.
 * POST /api/accounting/closures/prior-years
 */
router.post('/prior-years', authorize('contabilidad:write'), accountingClosureController.guardarDatosAnterior);

/**
 * Obtener datos de ejercicio anterior.
 * GET /api/accounting/closures/prior-years/2023
 */
router.get('/prior-years/:ejercicio', accountingClosureController.obtenerDatosAnterior);

/**
 * Generar asiento de cierre contable.
 * POST /api/accounting/closures/generar-asiento
 * Body: { fechaDesde: YYYY-MM-DD, fechaHasta: YYYY-MM-DD }
 */
router.post(
  '/generar-asiento',
  authorize('contabilidad:write'),
  accountingClosureController.generarAsientoCierre,
);

/**
 * Obtener comparativa entre dos años.
 * GET /api/accounting/closures/comparativas/2023/2024
 */
router.get('/comparativas/:ej1/:ej2', accountingClosureController.obtenerComparativa);

// --- Rutas de un ejercicio (siempre detras de las fijas) ---

/**
 * Obtener cierre por ejercicio.
 * GET /api/accounting/closures/2024
 */
router.get('/:ejercicio', accountingClosureController.obtenerCierre);

/**
 * Cambiar estado del documento de cierre (solo ABIERTO, EN_CIERRE, CERRADO o REABIERTO).
 * PATCH /api/accounting/closures/2024/status
 */
router.patch(
  '/:ejercicio/status',
  authorize('contabilidad:write'),
  accountingClosureController.cambiarEstado,
);

/**
 * Subir archivo de cierre (PDF, Excel).
 * POST /api/accounting/closures/2024/upload?tipoContenido=BALANCE_GENERAL
 */
router.post(
  '/:ejercicio/upload',
  authorize('contabilidad:write'),
  raw({ type: ['application/json', 'text/plain', 'application/pdf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: '10mb' }),
  accountingClosureController.subirArchivo,
);

/**
 * Listar archivos de cierre.
 * GET /api/accounting/closures/2024/files
 */
router.get('/:ejercicio/files', accountingClosureController.listarArchivos);

export default router;
