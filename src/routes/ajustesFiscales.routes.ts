import { Router } from 'express';
import { ajustesController } from '../controllers/ajustes.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/ajustes-fiscales (scoped). Solo empresas
// españolas (si no, 409). Los ve quien ve los impuestos; los cambia quien los
// lleva (impuestos:write: el contable) y el administrador, que lo tiene todo.
const router = Router({ mergeParams: true });

router.get('/', authorize('impuestos:read'), ajustesController.leerFiscales);
router.put('/', authorize('impuestos:write'), ajustesController.guardarFiscales);
// Calendario que saldría con unos ajustes, sin guardarlos (no escribe nada).
router.post('/vista-previa', authorize('impuestos:read'), ajustesController.vistaPreviaFiscales);

export default router;
