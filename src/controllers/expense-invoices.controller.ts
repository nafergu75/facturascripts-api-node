import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { expenseInvoicesService, type FiltrosGastos } from '../services/expense-invoices.service';

/**
 * Facturas de gasto: /companies/:companyId/expense-invoices. Las respuestas
 * van en un solo sobre ({ ok, data }); antes la lista y la ficha iban en dos.
 */
export const expenseInvoicesController = {
  /**
   * GET /companies/:companyId/expense-invoices
   * Listado paginado (page, limit) con filtros (q, estado, pago, supplierId,
   * desde, hasta), contadores y totales.
   */
  list: asyncHandler(async (req, res) => {
    sendOk(res, await expenseInvoicesService.listarGastos(req.companyId!, req.query as FiltrosGastos));
  }),

  /**
   * POST /companies/:companyId/expense-invoices
   * Alta con su asiento en firme (la factura queda contabilizada).
   */
  create: asyncHandler(async (req, res) => {
    const factura = await expenseInvoicesService.crearGasto(
      { ...(req.body ?? {}), companyId: req.companyId! },
      { contabilizar: 'POSTED', usuarioEmail: req.user?.email, userId: req.user?.userId },
    );
    sendOk(res, factura, undefined, 201);
  }),

  /**
   * GET /companies/:companyId/expense-invoices/:id
   * Ficha de la factura de gasto.
   */
  getById: asyncHandler(async (req, res) => {
    sendOk(res, await expenseInvoicesService.obtenerPorId(req.companyId!, req.params.id));
  }),

  /**
   * PUT /companies/:companyId/expense-invoices/:id
   * Corrige la factura (y rehace su asiento y sus libros).
   */
  update: asyncHandler(async (req, res) => {
    sendOk(res, await expenseInvoicesService.editarGasto(req.companyId!, req.params.id, req.body ?? {}, { userId: req.user?.userId, usuarioEmail: req.user?.email }));
  }),

  /**
   * POST /companies/:companyId/expense-invoices/:id/anular
   * Anula la factura: { motivo, fecha? }.
   */
  anular: asyncHandler(async (req, res) => {
    const { motivo, fecha } = (req.body ?? {}) as { motivo?: unknown; fecha?: unknown };
    sendOk(res, await expenseInvoicesService.anularGasto(req.companyId!, req.params.id, { motivo, fecha }, { userId: req.user?.userId }));
  }),

  /**
   * PATCH /companies/:companyId/expense-invoices/:id/estado
   * Cambio de estado a mano (solo entre PENDING, OVERDUE y CONFIRMED).
   */
  cambiarEstado: asyncHandler(async (req, res) => {
    const { nuevoEstado } = (req.body ?? {}) as { nuevoEstado?: unknown };
    sendOk(res, await expenseInvoicesService.cambiarEstado(req.companyId!, req.params.id, nuevoEstado));
  }),
};
