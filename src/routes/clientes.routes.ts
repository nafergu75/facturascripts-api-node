import { Router } from 'express';
import { clientesController } from '../controllers/clientes.controller';
import { authorize } from '../middleware/authorize.middleware';

// mergeParams permite leer :companyId del router padre (/companies/:companyId).
const router = Router({ mergeParams: true });

router.get('/', clientesController.list);
// Buscador (antes de /:id para que 'buscar' no se interprete como id).
router.get('/buscar', authorize('ventas:read'), clientesController.buscar);
router.get('/:id', clientesController.getById);
router.post('/', authorize('ventas:write'), clientesController.create);
router.put('/:id', authorize('ventas:write'), clientesController.update);
router.delete('/:id', authorize('ventas:write'), clientesController.remove);

export default router;
