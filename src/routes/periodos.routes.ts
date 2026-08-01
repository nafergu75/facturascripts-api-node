import { Router } from 'express';
import { periodosController } from '../controllers/periodos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', periodosController.listar);
router.put('/:mes/estado', authorize('contabilidad:write'), periodosController.cambiarEstado);
router.post('/cierre', authorize('contabilidad:write'), periodosController.cierre);

export default router;
