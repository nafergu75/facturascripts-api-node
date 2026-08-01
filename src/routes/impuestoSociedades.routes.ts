import { Router } from 'express';
import { impuestoSociedadesController } from '../controllers/impuestoSociedades.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });
router.use(authorize('contabilidad:read'));

router.get('/preview', impuestoSociedadesController.preview);
router.get('/fichero', impuestoSociedadesController.fichero);

export default router;
