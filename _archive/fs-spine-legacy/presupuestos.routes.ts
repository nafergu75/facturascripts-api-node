import { Router } from 'express';
import { presupuestosController } from '../controllers/presupuestos.controller';

const router = Router({ mergeParams: true });

router.get('/', presupuestosController.list);
router.get('/:id', presupuestosController.getById);
router.post('/', presupuestosController.create);
router.put('/:id', presupuestosController.update);
router.delete('/:id', presupuestosController.remove);

export default router;
