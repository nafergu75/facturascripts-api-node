import { Router } from 'express';
import { fiscalYearsController } from '../controllers/fiscalYears.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/fiscal-years (scoped). El cierre y demás
// acciones por ejercicio viven en registroMercantil.routes (/fiscal-years/:fyId/...).
const router = Router({ mergeParams: true });

router.get('/', fiscalYearsController.listar);
router.post('/', authorize('contabilidad:write'), fiscalYearsController.crear);

export default router;
