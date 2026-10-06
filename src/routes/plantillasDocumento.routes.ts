import { Router } from 'express';
import { plantillasController } from '../controllers/plantillasDocumento.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.get('/', plantillasController.list);
router.get('/tipo/:tipoDocumento/predeterminada', plantillasController.predeterminada);
router.get('/:plantillaId', plantillasController.getById);
router.post('/', authorize('config:write'), plantillasController.create);
router.put('/:plantillaId', authorize('config:write'), plantillasController.update);
router.delete('/:plantillaId', authorize('config:write'), plantillasController.remove);

export default router;
