import { Router } from 'express';
import { reglasContablesController } from '../controllers/reglasContables.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', reglasContablesController.get);
router.put('/', authorize('contabilidad:write'), reglasContablesController.put);

export default router;
