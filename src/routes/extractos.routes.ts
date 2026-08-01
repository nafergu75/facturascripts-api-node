import { Router } from 'express';
import { extractosController } from '../controllers/extractos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });
router.use(authorize('tesoreria:read'));

// Extracto bancario de una cuenta. Query: desde, hasta, saldoInicial.
router.get('/cuentas/:cuentaId/extracto', extractosController.extracto);
router.get('/cuentas/:cuentaId/extracto.csv', extractosController.extractoCsv);
// Revision gastos/ingresos vs contabilidad. Query: ejercicio (+ desde/hasta).
router.get('/cuentas/:cuentaId/revision', extractosController.revision);

export default router;
