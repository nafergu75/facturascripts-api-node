import { Router } from 'express';
import { cuadreBancosController } from '../controllers/cuadreBancos.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Cuadre de bancos del ejercicio. Query: ejercicio.
router.get('/', authorize('tesoreria:read'), cuadreBancosController.cuadre);
// Chequeo previo al cierre (puedeCerrar / motivo / cuadre). Query: ejercicio.
router.get('/chequeo-cierre', authorize('contabilidad:read'), cuadreBancosController.chequeoCierre);
// Configuracion de cierre (exigir cuadre / tolerancia).
router.get('/config', authorize('contabilidad:read'), cuadreBancosController.getConfig);
router.put('/config', authorize('contabilidad:write'), cuadreBancosController.putConfig);

export default router;
