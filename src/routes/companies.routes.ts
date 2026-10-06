import { Router } from 'express';
import { companiesController } from '../controllers/companies.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router();

router.get('/', companiesController.list);
router.get('/:id', companiesController.getById);
router.post('/', authorize('admin:global'), companiesController.create);
router.put('/:id', authorize('admin:global'), companiesController.update);
router.delete('/:id', authorize('admin:global'), companiesController.remove);

export default router;
