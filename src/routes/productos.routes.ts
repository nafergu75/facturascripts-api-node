import { Router } from 'express';
import { productosController } from '../controllers/productos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', productosController.list);
router.get('/:id', productosController.getById);
router.post('/', authorize('ventas:write'), productosController.create);
router.put('/:id', authorize('ventas:write'), productosController.update);
router.delete('/:id', authorize('ventas:write'), productosController.remove);

export default router;
