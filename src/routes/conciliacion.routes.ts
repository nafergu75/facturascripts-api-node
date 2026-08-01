import { Router } from 'express';
import { conciliacionController } from '../controllers/conciliacion.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.post('/proponer', authorize('tesoreria:write'), conciliacionController.proponer);

export default router;
