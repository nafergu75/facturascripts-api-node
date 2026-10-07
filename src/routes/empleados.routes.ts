import { Router } from 'express';
import { empleadosController as c } from '../controllers/empleados.controller';
import { authorize } from '../middleware/authorize.middleware';

/**
 * Trabajadores (para las nominas): /companies/:companyId/empleados.
 * Solo admin y contable (nominas:read / nominas:write).
 */
const router = Router({ mergeParams: true });

router.get('/', authorize('nominas:read'), c.listar);
router.post('/', authorize('nominas:write'), c.crear);
router.get('/:id', authorize('nominas:read'), c.obtener);
router.put('/:id', authorize('nominas:write'), c.actualizar);
router.post('/:id/baja', authorize('nominas:write'), c.baja);
router.delete('/:id', authorize('nominas:write'), c.borrar);

export default router;
