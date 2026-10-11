import { Router } from 'express';
import { planContableController } from '../controllers/planContable.controller';
import { authorize } from '../middleware/authorize.middleware';

// Subcuentas por empresa (montado bajo /companies/:companyId/plan-contable).
const router = Router({ mergeParams: true });

// Como el plan de /accounting/chart-of-accounts: solo con contabilidad:read.
router.get('/subcuentas', authorize('contabilidad:read'), planContableController.listarSubcuentas);
router.post('/subcuentas', authorize('contabilidad:write'), planContableController.crearSubcuenta);
router.post('/subcuentas/gasto-rapido', authorize('contabilidad:write'), planContableController.crearSubcuentaGasto);
router.put('/subcuentas/:id', authorize('contabilidad:write'), planContableController.actualizarSubcuenta);
router.delete('/subcuentas/:id', authorize('contabilidad:write'), planContableController.desactivarSubcuenta);

export default router;
