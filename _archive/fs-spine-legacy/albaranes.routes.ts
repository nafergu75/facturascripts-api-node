import { Router } from 'express';
import { albaranesController } from '../controllers/albaranes.controller';

const router = Router({ mergeParams: true });

router.get('/', albaranesController.list);
router.get('/:id', albaranesController.getById);
router.post('/', albaranesController.create);
router.put('/:id', albaranesController.update);
router.delete('/:id', albaranesController.remove);

export default router;
