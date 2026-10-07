import { Router } from 'express';
import { fiscalYearsController } from '../controllers/fiscalYears.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/fiscal-years (scoped). El cierre y demás
// acciones por ejercicio viven en registroMercantil.routes (/fiscal-years/:fyId/...).
const router = Router({ mergeParams: true });

router.get('/', authorize('contabilidad:read'), fiscalYearsController.listar);
router.post('/', authorize('contabilidad:write'), fiscalYearsController.crear);
// Reabrir un ejercicio cerrado sin asientos (lo cerraba el boton de Registro Mercantil).
router.post('/:fyId/reabrir', authorize('admin:empresa'), fiscalYearsController.reabrir);

export default router;
