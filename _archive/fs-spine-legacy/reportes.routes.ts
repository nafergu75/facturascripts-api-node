/**
 * Informes LEGACY (spine FacturaScripts). Sucesor canónico: /reports (motor
 * Prisma, usado por el frontend Chakra). Se mantiene por el frontend vanilla.
 * Ver ADR-002 "Consolidación de spine: Prisma canónico".
 */
import { Router } from 'express';
import { reportesController } from '../controllers/reportes.controller';
import { authorize } from '../middleware/authorize.middleware';
import { deprecacion } from '../middleware/deprecation.middleware';

const router = Router({ mergeParams: true });
router.use(deprecacion('/companies/:companyId/reports'));

// Informes (lectura contable)
router.get('/margen/cliente', authorize('contabilidad:read'), reportesController.margenCliente);
router.get('/margen/producto', authorize('contabilidad:read'), reportesController.margenProducto);

// Exportaciones CSV
router.get('/margen/cliente/csv', authorize('contabilidad:read'), reportesController.margenClienteCsv);
router.get('/contabilidad/libro-diario/csv', authorize('contabilidad:read'), reportesController.libroDiarioCsv);
router.get('/contabilidad/mayor/:cuentaCodigo/csv', authorize('contabilidad:read'), reportesController.mayorCsv);

// Informes y exportaciones (pantalla del front). ?ejercicio= (+ ?periodo= donde aplica)
router.get('/libro-iva-ingresos.csv', authorize('contabilidad:read'), reportesController.libroIvaIngresosCsv);
router.get('/libro-iva-gastos.csv', authorize('contabilidad:read'), reportesController.libroIvaGastosCsv);
router.get('/perdidas-ganancias.csv', authorize('contabilidad:read'), reportesController.perdidasGananciasCsv);
router.get('/export-a3.dat', authorize('contabilidad:read'), reportesController.exportA3);
router.get('/gastos-rechazados.csv', authorize('contabilidad:read'), reportesController.gastosRechazadosCsv);

export default router;
