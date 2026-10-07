import { Router } from 'express';
import { usersController } from '../controllers/users.controller';
import { authorize } from '../middleware/authorize.middleware';

// Gestion de usuarios de plataforma: solo admin global (authorize EN LINEA en
// cada ruta, como en /admin). El alta, los cambios y la baja aplican las mismas
// reglas que /admin/usuarios (contrasena de 12 caracteres como minimo, nadie se
// desactiva a si mismo, nunca sin administrador global activo) y quedan en la
// auditoria.
const router = Router();

router.get('/', authorize('admin:global'), usersController.list);
router.get('/:id', authorize('admin:global'), usersController.getById);
router.post('/', authorize('admin:global'), usersController.create);
router.put('/:id', authorize('admin:global'), usersController.update);
router.delete('/:id', authorize('admin:global'), usersController.remove);

export default router;
