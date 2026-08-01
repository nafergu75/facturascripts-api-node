import { Router } from 'express';
import { impuestosModuloController as c } from '../controllers/impuestosModulo.controller';
import { authorize } from '../middleware/authorize.middleware';

/**
 * Modulo "Impuestos" (montado en /companies/:companyId/impuestos). Flujo Quipu:
 * lista (vigente/expirado/omitido/presentado) -> editar (recalcular/guardar) ->
 * listo para presentar -> TXT AEAT + copia PDF. Protegido con authMiddleware +
 * companyScope (router padre) + impuestos:read/write.
 */
const router = Router({ mergeParams: true });

// Lista del calendario fiscal. ?ejercicio=&tab=activos|omitidos|presentados
router.get('/modelos', authorize('impuestos:read'), c.listar);
router.get('/modelos/:modeloId', authorize('impuestos:read'), c.detalle);

// "Recalcular importes" (autorrelleno; guarda automaticamente, pisa lo manual)
router.post('/modelos/:modeloId/recalcular', authorize('impuestos:write'), c.recalcular);
// "Guardar" (conserva ediciones manuales; origen manual-mixto)
router.put('/modelos/:modeloId', authorize('impuestos:write'), c.guardar);

// Estados (pestanas del video)
router.post('/modelos/:modeloId/omitir', authorize('impuestos:write'), c.omitir);
router.post('/modelos/:modeloId/recuperar', authorize('impuestos:write'), c.recuperar);
router.post('/modelos/:modeloId/listo-para-presentar', authorize('impuestos:write'), c.listoParaPresentar);
router.post('/modelos/:modeloId/no-presentado', authorize('impuestos:write'), c.noPresentado);

// Descargas
router.get('/modelos/:modeloId/txt', authorize('impuestos:read'), c.txt);
router.get('/modelos/:modeloId/pdf', authorize('impuestos:read'), c.pdf);

// Excel de ingresos/gastos para validar antes de presentar. ?ejercicio=&periodo=Q1|1T|0A
router.get('/ingresos-gastos/excel', authorize('impuestos:read'), c.excelIngresosGastos);

// Calculo directo de casillas oficiales (sin tocar borradores guardados).
// ?model_type=303|111&year=2026&period=1T
router.get('/calculate', authorize('impuestos:read'), c.calculate);
// PDF a partir de un JSON de casillas (p.ej. editadas en el front).
router.post('/generate-pdf', authorize('impuestos:read'), c.generatePdf);

export default router;
