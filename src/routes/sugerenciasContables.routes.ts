import { Router } from 'express';
import { sugerenciasController } from '../controllers/sugerenciasContables.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

router.post('/subcuenta-tercero', authorize('contabilidad:write'), sugerenciasController.subcuentaTercero);
router.post('/subcuenta-familia', authorize('contabilidad:write'), sugerenciasController.subcuentaFamilia);

export default router;
