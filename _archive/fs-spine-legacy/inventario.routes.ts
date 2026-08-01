import { Router } from 'express';
import { inventarioController } from '../controllers/inventario.controller';

const router = Router({ mergeParams: true });

router.get('/', inventarioController.list);
router.get('/:id', inventarioController.getById);
router.post('/', inventarioController.create);
router.put('/:id', inventarioController.update);
router.delete('/:id', inventarioController.remove);

export default router;
