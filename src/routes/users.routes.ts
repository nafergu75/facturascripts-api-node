import { Router } from 'express';
import { usersController } from '../controllers/users.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router();

// Gestion de usuarios de plataforma: solo admin global.
router.use(authorize('admin:global'));

router.get('/', usersController.list);
router.get('/:id', usersController.getById);
router.post('/', usersController.create);
router.put('/:id', usersController.update);
router.delete('/:id', usersController.remove);

export default router;
