import { Router } from 'express';
import { complianceController } from '../controllers/compliance.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/alertas', authorize('contabilidad:read'), complianceController.alertas);
router.get('/alertas/historico', authorize('contabilidad:read'), complianceController.historico);

export default router;
