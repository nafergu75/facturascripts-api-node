import { Router } from 'express';
import { planContableController } from '../controllers/planContable.controller';
import { authorize } from '../middleware/authorize.middleware';

// Subcuentas por empresa (montado bajo /companies/:companyId/plan-contable).
const router = Router({ mergeParams: true });

router.get('/subcuentas', planContableController.listarSubcuentas);
router.post('/subcuentas', authorize('contabilidad:write'), planContableController.crearSubcuenta);
router.post('/subcuentas/gasto-rapido', authorize('contabilidad:write'), planContableController.crearSubcuentaGasto);
router.put('/subcuentas/:id', planContableController.actualizarSubcuenta);
router.delete('/subcuentas/:id', planContableController.desactivarSubcuenta);

export default router;
