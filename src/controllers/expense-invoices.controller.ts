import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { expenseInvoicesService, type FiltrosGastos } from '../services/expense-invoices.service';
import { buscarOriginales, datosParaRectificar } from '../services/rectificativasGasto.service';
import { anularCompensacion, aplicarAbono, compensacionesDe } from '../services/compensacionesGasto.service';

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

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
   * GET /companies/:companyId/expense-invoices/originales?supplierId=&numero=&nif=
   * Candidatas a factura original de un abono: la del mismo numero y las parecidas (8 como mucho).
   */
  originales: asyncHandler(async (req, res) => {
    sendOk(res, await buscarOriginales(req.companyId!, { supplierId: texto(req.query.supplierId), numero: texto(req.query.numero), nif: texto(req.query.nif) }));
  }),

  /**
   * GET /companies/:companyId/expense-invoices/:id/rectificar
   * Datos para prellenar un abono o rectificativa de esta factura.
   */
  paraRectificar: asyncHandler(async (req, res) => {
    sendOk(res, await datosParaRectificar(req.companyId!, req.params.id));
  }),

  /**
   * GET /companies/:companyId/expense-invoices/:id/compensaciones
   * Aplicaciones del abono a otras facturas, o de abonos a esta factura.
   */
  compensaciones: asyncHandler(async (req, res) => {
    sendOk(res, await compensacionesDe(req.companyId!, req.params.id));
  }),

  /**
   * POST /companies/:companyId/expense-invoices/:id/compensaciones
   * Aplica el abono :id a otra factura del proveedor: { facturaId, importe?, fecha? }
   * o a una de fuera de la app: { numeroFuera, fechaFuera, importe?, fecha? }.
   */
  aplicar: asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const c = await aplicarAbono(
      req.companyId!,
      req.params.id,
      { facturaId: b.facturaId, numeroFuera: b.numeroFuera, fechaFuera: b.fechaFuera, importe: b.importe, fecha: b.fecha },
      { userId: req.user?.userId },
    );
    sendOk(res, c, undefined, 201);
  }),

  /**
   * POST /companies/:companyId/expense-invoices/:id/compensaciones/:cid/anular
   * Anula una aplicacion del abono :id ({ fecha? } si su periodo esta cerrado).
   */
  anularAplicacion: asyncHandler(async (req, res) => {
    const { fecha } = (req.body ?? {}) as { fecha?: unknown };
    sendOk(res, await anularCompensacion(req.companyId!, req.params.id, req.params.cid, { fecha }, { userId: req.user?.userId }));
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
