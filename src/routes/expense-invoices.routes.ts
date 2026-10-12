import { Router } from 'express';
import { expenseInvoicesController } from '../controllers/expense-invoices.controller';
import { authorize } from '../middleware/authorize.middleware';
import { pagosController } from '../controllers/cobrosPagos.controller';

const router = Router({ mergeParams: true });

// Lecturas: Compras o Contabilidad (el admin, todo).
// GET /companies/:companyId/expense-invoices - Listado paginado con contadores
router.get('/', authorize('compras:read', 'contabilidad:read'), expenseInvoicesController.list);

// POST /companies/:companyId/expense-invoices - Alta con su asiento en firme
// (con el bloque `rectificativa`, un abono o rectificativa del proveedor)
router.post('/', authorize('compras:write'), expenseInvoicesController.create);

// GET /companies/:companyId/expense-invoices/originales - Candidatas a original de un abono
// (antes de /:id, para que «originales» no se tome por un id)
router.get('/originales', authorize('compras:read', 'contabilidad:read'), expenseInvoicesController.originales);

// GET /companies/:companyId/expense-invoices/:id - Ficha de la factura
router.get('/:id', authorize('compras:read', 'contabilidad:read'), expenseInvoicesController.getById);

// GET /companies/:companyId/expense-invoices/:id/rectificar - Datos para prellenar un abono de la factura
router.get('/:id/rectificar', authorize('compras:read', 'contabilidad:read'), expenseInvoicesController.paraRectificar);

// PUT /companies/:companyId/expense-invoices/:id - Corregir (rehace el asiento y los libros)
router.put('/:id', authorize('compras:write'), expenseInvoicesController.update);

// POST /companies/:companyId/expense-invoices/:id/anular - Anular (REVERSED o contraasiento)
router.post('/:id/anular', authorize('compras:write'), expenseInvoicesController.anular);

// PATCH /companies/:companyId/expense-invoices/:id/estado - Cambiar estado (solo PENDING/OVERDUE/CONFIRMED)
router.patch('/:id/estado', authorize('compras:write'), expenseInvoicesController.cambiarEstado);

// Pagos de la factura (parciales o totales), cada uno con su asiento 400/410
// contra 572/570. Anular deja el pago ANULADO y su asiento REVERSED.
router.get('/:id/pagos', authorize('compras:read', 'contabilidad:read'), pagosController.listar);
router.post('/:id/pagos', authorize('compras:write', 'contabilidad:write'), pagosController.registrar);
router.post('/:id/pagos/:cobroId/anular', authorize('compras:write', 'contabilidad:write'), pagosController.anular);

export default router;
