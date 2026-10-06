import { Router } from 'express';
import { movementsController } from '../controllers/movements.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// POST /companies/:companyId/movements
router.post('/', authorize('contabilidad:write'), movementsController.create);

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
router.patch('/:id', authorize('contabilidad:write'), movementsController.update);

// DELETE /companies/:companyId/movements/:id
router.delete('/:id', authorize('contabilidad:write'), movementsController.delete);

export default router;
