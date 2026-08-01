import { Router } from 'express';
import { nominasController } from '../controllers/nominas.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.post('/resumen', authorize('contabilidad:write'), nominasController.importar);
router.get('/resumen', nominasController.listar);

export default router;
