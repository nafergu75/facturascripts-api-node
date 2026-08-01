import { Router } from 'express';
import { pedidosController } from '../controllers/pedidos.controller';

const router = Router({ mergeParams: true });

router.get('/', pedidosController.list);
router.get('/:id', pedidosController.getById);
router.post('/', pedidosController.create);
router.put('/:id', pedidosController.update);
router.delete('/:id', pedidosController.remove);

export default router;
