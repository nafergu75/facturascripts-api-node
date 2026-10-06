import { Router } from 'express';
import { treasuryController } from '../controllers/treasury.controller';
import { authorize } from '../middleware/authorize.middleware';

// Rutas de la pantalla de tesoreria del frontend. Se montan bajo
// /companies/:companyId/treasury, despues de companyScope.
const router = Router({ mergeParams: true });

router.get('/summary', authorize('tesoreria:read'), treasuryController.resumen);
router.get('/bank-accounts', authorize('tesoreria:read'), treasuryController.listarCuentas);
router.post('/bank-accounts', authorize('tesoreria:write'), treasuryController.crearCuenta);
router.get('/bank-accounts/:accountId/movements', authorize('tesoreria:read'), treasuryController.listarMovimientos);
router.post('/bank-accounts/:accountId/statements', authorize('tesoreria:write'), treasuryController.subirExtracto);
router.post('/movements/:movementId/reconcile', authorize('tesoreria:write'), treasuryController.conciliar);

export default router;
