import { Router } from 'express';
import { seriesController } from '../controllers/series.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Las ve quien factura y tambien quien lleva la contabilidad (antes el contable recibia un 403).
router.get('/', authorize('ventas:read', 'contabilidad:read'), seriesController.listar);
router.post('/', authorize('ventas:write'), seriesController.crear);
router.put('/:id', authorize('ventas:write'), seriesController.actualizar);

export default router;
