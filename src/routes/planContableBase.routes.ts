import { Router } from 'express';
import { planContableController } from '../controllers/planContable.controller';

// Plan base (solo lectura, sin companyId). Publico.
const router = Router();

router.get('/grupos', planContableController.grupos);
router.get('/subgrupos', planContableController.subgrupos);
router.get('/cuentas', planContableController.cuentas);
router.get('/todo', planContableController.todo);

export default router;
