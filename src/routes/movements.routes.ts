import { Router } from 'express';
import { movementsController } from '../controllers/movements.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// POST /companies/:companyId/movements
router.post('/', authorize('contabilidad:write'), movementsController.create);

// GET /companies/:companyId/movements
router.get('/', authorize('contabilidad:read', 'tesoreria:read'), movementsController.list);

// ⚠️ IMPORTANT: Specific routes MUST come BEFORE dynamic routes like /:id
// Otherwise Express will treat /stats/summary as /:id where id='stats/summary'

// Panel del resumen (panel.service): sale de las FACTURAS y las NOMINAS, por la
// fecha de la factura, no de la tabla Movement. Todas admiten ?anio (por defecto
// el año en curso) y ?trimestre=1-4 o ?mes=1-12.

// GET /companies/:companyId/movements/stats/summary
router.get('/stats/summary', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getSummary);

// GET /companies/:companyId/movements/stats/fiscal?anio=2026[&trimestre=1-4 | &mes=1-12]
// IVA repercutido, IVA soportado y retenciones, sacados de las facturas.
router.get('/stats/fiscal', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getResumenFiscal);

// GET /companies/:companyId/movements/stats/by-category
router.get('/stats/by-category', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getByCategory);

// GET /companies/:companyId/movements/stats/by-month
router.get('/stats/by-month', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getByMonth);

// GET /companies/:companyId/movements/stats/ingresos-por-cliente
router.get('/stats/ingresos-por-cliente', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getIngresosPorCliente);

// GET /companies/:companyId/movements/stats/gastos-por-proveedor
router.get('/stats/gastos-por-proveedor', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getGastosPorProveedor);

// GET /companies/:companyId/movements/stats/ultimas-facturas?limit=15[&anio=2026]
router.get('/stats/ultimas-facturas', authorize('contabilidad:read', 'tesoreria:read'), movementsController.getUltimasFacturas);

// PATCH /companies/:companyId/movements/:id
router.patch('/:id', authorize('contabilidad:write'), movementsController.update);

// DELETE /companies/:companyId/movements/:id
router.delete('/:id', authorize('contabilidad:write'), movementsController.delete);

export default router;
