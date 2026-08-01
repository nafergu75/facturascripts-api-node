/**
 * Contabilidad LEGACY (spine FacturaScripts; CRUD directo de asientos, hoy 501).
 * Sucesor canónico: /accounting (motor Prisma de asientos, usado por el Chakra).
 * Ver ADR-002 "Consolidación de spine: Prisma canónico".
 */
import { Router } from 'express';
import { contabilidadController } from '../controllers/contabilidad.controller';
import { deprecacion } from '../middleware/deprecation.middleware';

const router = Router({ mergeParams: true });
router.use(deprecacion('/companies/:companyId/accounting'));

router.get('/', contabilidadController.list);
router.get('/:id', contabilidadController.getById);
router.post('/', contabilidadController.create);
router.put('/:id', contabilidadController.update);
router.delete('/:id', contabilidadController.remove);

export default router;
