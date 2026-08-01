import { Router } from 'express';
import { seriesController } from '../controllers/series.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', authorize('ventas:read'), seriesController.listar);
router.post('/', authorize('ventas:write'), seriesController.crear);
router.put('/:id', authorize('ventas:write'), seriesController.actualizar);

export default router;
