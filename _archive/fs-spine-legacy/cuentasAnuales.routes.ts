/**
 * Cuentas anuales LEGACY (spine FacturaScripts; lee asientos de FS). Sucesores
 * canónicos: /accounting/closures (cierres) y /reports (estados). Migración de
 * fuente de datos PENDIENTE — ver ADR-002, Paso 3.
 */
import { Router } from 'express';
import { cuentasAnualesController } from '../controllers/cuentasAnuales.controller';
import { authorize } from '../middleware/authorize.middleware';
import { deprecacion } from '../middleware/deprecation.middleware';

const router = Router({ mergeParams: true });
router.use(deprecacion('/companies/:companyId/accounting/closures'));
router.use(authorize('contabilidad:read'));

router.get('/preview', cuentasAnualesController.preview);
router.get('/libro-diario', cuentasAnualesController.libroDiario);
router.get('/libro-inventarios', cuentasAnualesController.libroInventarios);
router.get('/efe', cuentasAnualesController.efe);

export default router;
