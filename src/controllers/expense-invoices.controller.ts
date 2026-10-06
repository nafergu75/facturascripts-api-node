import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest, notFound } from '../utils/http-errors';
import { expenseInvoicesService, CrearFacturaGastoDTO } from '../services/expense-invoices.service';
import { archivarGastoSinRomper } from '../services/archivoFacturas.service';

export const expenseInvoicesController = {
  /**
   * GET /companies/:companyId/expense-invoices
   * Listar facturas de gasto con paginación y filtros.
   */
  list: asyncHandler(async (req, res) => {
    const companyId = req.companyId!;
    const { estado, supplierId, desde, hasta, skip, take } = req.query;

    const result = await expenseInvoicesService.listarGastos(companyId, {
      estado: estado as string | undefined,
      supplierId: supplierId as string | undefined,
      desde: desde as string | undefined,
      hasta: hasta as string | undefined,
      skip: skip ? parseInt(skip as string, 10) : undefined,
      take: take ? parseInt(take as string, 10) : undefined,
    });

    sendOk(res, { data: result });
  }),

  /**
   * POST /companies/:companyId/expense-invoices
   * Crear una nueva factura de gasto.
   */
  create: asyncHandler(async (req, res) => {
    const dto: CrearFacturaGastoDTO = {
      ...req.body,
      companyId: req.companyId!,
    };

    const factura = await expenseInvoicesService.crearGasto(dto);
    // Queda registrada en el archivo de su trimestre (sin original: se puede
    // adjuntar desde Archivo). No bloqueante.
    await archivarGastoSinRomper(req.companyId!, factura.id);
    sendOk(res, { data: factura }, undefined, 201);
  }),

  /**
   * GET /companies/:companyId/expense-invoices/:id
   * Obtener detalle de una factura de gasto.
   */
  getById: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const factura = await expenseInvoicesService.obtenerPorId(req.companyId!, id);
    sendOk(res, { data: factura });
  }),

  /**
   * PATCH /companies/:companyId/expense-invoices/:id/estado
   * Cambiar el estado de una factura de gasto.
   */
  cambiarEstado: asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { nuevoEstado } = req.body;

    if (!nuevoEstado) {
      throw badRequest('Se requiere nuevoEstado en el body');
    }

    const factura = await expenseInvoicesService.cambiarEstado(req.companyId!, id, nuevoEstado);
    sendOk(res, { data: factura });
  }),
};
