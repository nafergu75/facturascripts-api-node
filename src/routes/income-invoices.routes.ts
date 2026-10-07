import { Router } from 'express';
import { incomeInvoicesController } from '../controllers/income-invoices.controller';
import { authorize } from '../middleware/authorize.middleware';
import { cobrosController } from '../controllers/cobrosPagos.controller';

const router = Router({ mergeParams: true });

/**
 * Crear factura de ingreso completa (cliente+líneas+totales).
 * POST /api/invoices/income
 * Con { proforma: true } crea una factura proforma (serie P, sin efectos fiscales).
 */
router.post('/', authorize('ventas:write'), incomeInvoicesController.crearIngreso);

/**
 * Listar facturas de ingreso (sin proformas).
 * GET /api/invoices/income?estado=PENDING&customerId=...&desde=...&hasta=...
 * Las proformas: ?estadoDocumento=PROFORMA
 */
router.get('/', incomeInvoicesController.listar);

/**
 * Obtener resumen de ingresos por período (para dashboard).
 * GET /api/invoices/income/resumen/periodo?desde=2024-01-01&hasta=2024-12-31
 */
router.get('/resumen/periodo', incomeInvoicesController.resumenPeriodo);

/**
 * Cobros de clientes para el panel: pendiente de cobro (todas las facturas
 * emitidas, de cualquier año) y vencido, cobrado en el año y las proximas
 * facturas a cobrar. Va antes de '/:id' para que "stats" no se tome por un id.
 * GET /stats/cobros?anio=2026
 */
router.get('/stats/cobros', authorize('ventas:read', 'contabilidad:read'), incomeInvoicesController.estadisticasCobros);

/**
 * Obtener factura por ID.
 * GET /api/invoices/income/:id
 */
router.get('/:id', incomeInvoicesController.obtenerPorId);

/** Modificar / borrar un borrador o una proforma pendiente (las facturas emitidas no se tocan). */
router.put('/:id', authorize('ventas:write'), incomeInvoicesController.actualizar);
router.delete('/:id', authorize('ventas:write'), incomeInvoicesController.eliminar);

/** Emitir un borrador: numero de la serie, sin huecos. */
router.post('/:id/finalizar', authorize('ventas:write'), incomeInvoicesController.finalizar);

/** Copiar una factura en un borrador nuevo (una proforma, en otra proforma). */
router.post('/:id/duplicar', authorize('ventas:write'), incomeInvoicesController.duplicar);

/** Proformas: pasar a factura (crea un borrador enlazado) o rechazar. */
router.post('/:id/pasar-a-factura', authorize('ventas:write'), incomeInvoicesController.pasarAFactura);
router.post('/:id/rechazar', authorize('ventas:write'), incomeInvoicesController.rechazar);

/** Descargar la factura en PDF. */
router.get('/:id/pdf', incomeInvoicesController.pdf);

/** Datos que faltan en la factura (emisor, cliente, IBAN, logo). */
router.get('/:id/avisos', incomeInvoicesController.avisos);

/**
 * Cambiar estado de factura (PENDING -> PAID, etc.).
 * PATCH /api/invoices/income/:id/status
 */
router.patch('/:id/status', authorize('ventas:write'), incomeInvoicesController.cambiarEstado);

/**
 * Cobros de la factura (parciales o totales), cada uno con su asiento
 * 572/570 contra 430. Anular deja el cobro ANULADO y su asiento REVERSED.
 * GET  /:id/cobros
 * POST /:id/cobros               { fecha, importe, cuentaBancariaId | caja, nota }
 * POST /:id/cobros/:cobroId/anular { fecha? } (solo si el periodo del cobro esta cerrado)
 */
router.get('/:id/cobros', authorize('ventas:read', 'contabilidad:read'), cobrosController.listar);
router.post('/:id/cobros', authorize('ventas:write', 'contabilidad:write'), cobrosController.registrar);
router.post('/:id/cobros/:cobroId/anular', authorize('ventas:write', 'contabilidad:write'), cobrosController.anular);

/**
 * Crear factura rectificativa (abono).
 * POST /api/invoices/income/:id/credit-note
 */
router.post('/:id/credit-note', authorize('ventas:write'), incomeInvoicesController.crearRectificativa);

/**
 * Enviar factura por email.
 * POST /api/invoices/income/:id/send-email
 * (TODO: requiere SMTP + render PDF)
 */
router.post('/:id/send-email', authorize('ventas:write'), incomeInvoicesController.enviarEmail);

/**
 * Crear factura periódica/recurrente.
 * POST /api/invoices/income/:id/make-recurring
 * (TODO: requiere job de recurrencia)
 */
router.post('/:id/make-recurring', authorize('ventas:write'), incomeInvoicesController.hacerRecurrente);

export default router;
