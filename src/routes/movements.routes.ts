import { Router } from 'express';
import { movementsController } from '../controllers/movements.controller';

const router = Router({ mergeParams: true });

// POST /companies/:companyId/movements
router.post('/', movementsController.create);

// GET /companies/:companyId/movements
router.get('/', movementsController.list);

// ⚠️ IMPORTANT: Specific routes MUST come BEFORE dynamic routes like /:id
// Otherwise Express will treat /stats/summary as /:id where id='stats/summary'

// GET /companies/:companyId/movements/stats/summary
router.get('/stats/summary', movementsController.getSummary);

// GET /companies/:companyId/movements/stats/by-category
router.get('/stats/by-category', movementsController.getByCategory);

// GET /companies/:companyId/movements/stats/by-month
router.get('/stats/by-month', movementsController.getByMonth);

// PATCH /companies/:companyId/movements/:id
router.patch('/:id', movementsController.update);

// DELETE /companies/:companyId/movements/:id
router.delete('/:id', movementsController.delete);

export default router;
