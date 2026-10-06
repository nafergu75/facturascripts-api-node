import { Router } from 'express';
import { expenseInvoicesController } from '../controllers/expense-invoices.controller';
import { authorize } from '../middleware/authorize.middleware';
import { pagosController } from '../controllers/cobrosPagos.controller';

const router = Router({ mergeParams: true });

// GET /companies/:companyId/expense-invoices - Listar gastos (lectura)
router.get('/', authorize('compras:read'), expenseInvoicesController.list);

// POST /companies/:companyId/expense-invoices - Crear gasto (escritura)
router.post('/', authorize('compras:write'), expenseInvoicesController.create);

// GET /companies/:companyId/expense-invoices/:id - Obtener detalle de gasto
router.get('/:id', authorize('compras:read'), expenseInvoicesController.getById);

// PATCH /companies/:companyId/expense-invoices/:id/estado - Cambiar estado
router.patch('/:id/estado', authorize('compras:write'), expenseInvoicesController.cambiarEstado);

// Pagos de la factura (parciales o totales), cada uno con su asiento 400/410
// contra 572/570. Anular deja el pago ANULADO y su asiento REVERSED.
router.get('/:id/pagos', authorize('compras:read', 'contabilidad:read'), pagosController.listar);
router.post('/:id/pagos', authorize('compras:write', 'contabilidad:write'), pagosController.registrar);
router.post('/:id/pagos/:cobroId/anular', authorize('compras:write', 'contabilidad:write'), pagosController.anular);

export default router;
