import { Router } from 'express';
import { reglasContablesController } from '../controllers/reglasContables.controller';

const router = Router({ mergeParams: true });

router.get('/', reglasContablesController.get);
router.put('/', reglasContablesController.put);

export default router;
