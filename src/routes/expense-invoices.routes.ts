import { Router } from 'express';
import { expenseInvoicesController } from '../controllers/expense-invoices.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// GET /companies/:companyId/expense-invoices - Listar gastos (lectura)
router.get('/', authorize('compras:read'), expenseInvoicesController.list);

// POST /companies/:companyId/expense-invoices - Crear gasto (escritura)
router.post('/', authorize('compras:write'), expenseInvoicesController.create);

// GET /companies/:companyId/expense-invoices/:id - Obtener detalle de gasto
router.get('/:id', authorize('compras:read'), expenseInvoicesController.getById);

// PATCH /companies/:companyId/expense-invoices/:id/estado - Cambiar estado
router.patch('/:id/estado', authorize('compras:write'), expenseInvoicesController.cambiarEstado);

export default router;
