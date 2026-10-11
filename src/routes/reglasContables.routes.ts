import { Router } from 'express';
import { reglasContablesController } from '../controllers/reglasContables.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', reglasContablesController.get);
// Digitos de las subcuentas de clientes y proveedores (7-10); 409 si ya hay alguna asignada.
router.get('/longitud-subcuentas', reglasContablesController.getLongitudSubcuentas);
router.put('/longitud-subcuentas', authorize('contabilidad:write'), reglasContablesController.putLongitudSubcuentas);
router.put('/', authorize('contabilidad:write'), reglasContablesController.put);

export default router;
