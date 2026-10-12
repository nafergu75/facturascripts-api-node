import { Router } from 'express';
import { clientesController } from '../controllers/clientes.controller';
import { authorize } from '../middleware/authorize.middleware';

// mergeParams permite leer :companyId del router padre (/companies/:companyId).
const router = Router({ mergeParams: true });

router.get('/', authorize('ventas:read', 'contabilidad:read'), clientesController.list);
// Buscador (antes de /:id para que 'buscar' no se interprete como id).
router.get('/buscar', authorize('ventas:read'), clientesController.buscar);
// Por NIF (el lector de ventas y el alta): antes de /:id.
router.get('/por-nif/:nif', authorize('ventas:read', 'contabilidad:read'), clientesController.porNif);
router.get('/:id', authorize('ventas:read', 'contabilidad:read'), clientesController.getById);
router.post('/', authorize('ventas:write'), clientesController.create);
router.put('/:id', authorize('ventas:write'), clientesController.update);
router.delete('/:id', authorize('ventas:write'), clientesController.remove);

export default router;
