import { Router } from 'express';
import { periodosController } from '../controllers/periodos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', periodosController.listar);
router.put('/:mes/estado', authorize('contabilidad:write'), periodosController.cambiarEstado);
// Cierre del ejercicio y traspaso de saldos: vista previa, cierre y deshacer.
router.get('/cierre', authorize('contabilidad:read'), periodosController.vistaCierre);
router.post('/cierre', authorize('contabilidad:write'), periodosController.cierre);
router.delete('/cierre', authorize('contabilidad:write'), periodosController.deshacerCierre);

export default router;
