import { Router } from 'express';
import { productosController } from '../controllers/productos.controller';

const router = Router({ mergeParams: true });

router.get('/', productosController.list);
router.get('/:id', productosController.getById);
router.post('/', productosController.create);
router.put('/:id', productosController.update);
router.delete('/:id', productosController.remove);

export default router;
