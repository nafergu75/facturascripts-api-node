import { Router } from 'express';
import { comprasService } from '../services/compras.service';
import { makeScopedController } from '../controllers/scoped-crud.controller';
import { authorize } from '../middleware/authorize.middleware';

/**
 * Facturas de GASTO (modelo Prisma `ExpenseInvoice`, MIGRADO de FS). Alias
 * antiguo de solo lectura: el alta, la edicion y la anulacion van por
 * /expense-invoices. Lectura con Compras o Contabilidad.
 */
const c = makeScopedController(comprasService);

const router = Router({ mergeParams: true });
router.get('/', authorize('compras:read', 'contabilidad:read'), c.list);
router.get('/:id', authorize('compras:read', 'contabilidad:read'), c.getById);

export default router;
