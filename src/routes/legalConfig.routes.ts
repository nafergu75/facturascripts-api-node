import { Router } from 'express';
import { legalConfigController } from '../controllers/legalConfig.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/legal-config (scoped: companyScope ya validó acceso).
const router = Router({ mergeParams: true });

router.get('/', legalConfigController.obtener);
router.put('/', authorize('contabilidad:write'), legalConfigController.actualizar);

export default router;
