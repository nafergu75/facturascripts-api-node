import { Router } from 'express';
import { companiesController } from '../controllers/companies.controller';

const router = Router();

router.get('/', companiesController.list);
router.get('/:id', companiesController.getById);
router.post('/', companiesController.create);
router.put('/:id', companiesController.update);
router.delete('/:id', companiesController.remove);

export default router;
