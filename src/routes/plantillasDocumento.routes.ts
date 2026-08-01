import { Router } from 'express';
import { plantillasController } from '../controllers/plantillasDocumento.controller';

const router = Router({ mergeParams: true });

router.get('/', plantillasController.list);
router.get('/tipo/:tipoDocumento/predeterminada', plantillasController.predeterminada);
router.get('/:plantillaId', plantillasController.getById);
router.post('/', plantillasController.create);
router.put('/:plantillaId', plantillasController.update);
router.delete('/:plantillaId', plantillasController.remove);

export default router;
