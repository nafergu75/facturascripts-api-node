import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest, notImplemented } from '../utils/http-errors';
import { incomeInvoicesService, CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { registrarAuditoria } from '../services/auditoria.service';
import { accountingHooksService } from '../services/accounting-hooks.service';

export const incomeInvoicesController = {
  /**
   * POST /api/invoices/income
   * Crear una factura de ingreso completa (cliente+líneas+totales).
   */
  crearIngreso: asyncHandler(async (req, res) => {
    const dto: CrearFacturaIngresoDTO = {
      companyId: req.companyId!,
      ...req.body,
    };

    const factura = await incomeInvoicesService.crearIngreso(dto);

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CREAR_FACTURA_INGRESO',
      resourceType: 'INCOME_INVOICE',
      resourceId: factura.id,
      meta: {
        numeroCompleto: factura.numeroCompleto,
        total: factura.totalFactura,
        cliente: factura.customerId,
      },
    });

    sendOk(res, { invoice: factura }, undefined, 201);
  }),

  /**
   * GET /api/invoices/income
   * Listar facturas de ingreso con filtros.
   */
  listar: asyncHandler(async (req, res) => {
    const resultado = await incomeInvoicesService.listar(req.companyId!, {
      estado: req.query.estado as string | undefined,
      customerId: req.query.customerId as string | undefined,
      desde: req.query.desde as string | undefined,
      hasta: req.query.hasta as string | undefined,
      skip: req.query.skip ? Number(req.query.skip) : 0,
      take: req.query.take ? Number(req.query.take) : 20,
    });

    sendOk(res, resultado);
  }),

  /**
   * GET /api/invoices/income/:id
   * Obtener una factura por ID.
   */
  obtenerPorId: asyncHandler(async (req, res) => {
    const factura = await incomeInvoicesService.obtenerPorId(req.companyId!, req.params.id);
    sendOk(res, { invoice: factura });
  }),

  /**
   * PATCH /api/invoices/income/:id/status
   * Cambiar estado de la factura (ej. PENDING -> PAID).
   */
  cambiarEstado: asyncHandler(async (req, res) => {
    const nuevoEstado = String(req.body?.estado ?? '').toUpperCase();
    if (!['DRAFT', 'PENDING', 'PAID', 'OVERDUE'].includes(nuevoEstado)) {
      throw badRequest('Estado inválido. Usa: DRAFT, PENDING, PAID, OVERDUE');
    }

    const factura = await incomeInvoicesService.cambiarEstado(req.companyId!, req.params.id, nuevoEstado);

    // 🔴 ENGANCHE: Contabilizar automáticamente al confirmar (PENDING)
    if (nuevoEstado === 'PENDING') {
      try {
        await accountingHooksService.onIncomeInvoiceConfirmed(req.companyId!, req.params.id);
      } catch (hookErr) {
        // Log error but don't fail the factura confirmation
        console.error(
          `Aviso: Error en contabilización automática de factura ${req.params.id}:`,
          hookErr instanceof Error ? hookErr.message : String(hookErr)
        );
      }
    }

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CAMBIAR_ESTADO_FACTURA_INGRESO',
      resourceType: 'INCOME_INVOICE',
      resourceId: req.params.id,
      meta: { nuevoEstado, numeroCompleto: factura.numeroCompleto },
    });

    sendOk(res, { invoice: factura });
  }),

  /**
   * POST /api/invoices/income/:id/credit-note
   * Crear factura rectificativa (abono).
   */
  crearRectificativa: asyncHandler(async (req, res) => {
    const factura = await incomeInvoicesService.crearRectificativa(
      req.companyId!,
      req.params.id,
      req.body?.lineas,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CREAR_FACTURA_RECTIFICATIVA',
      resourceType: 'INCOME_INVOICE',
      resourceId: factura.id,
      meta: { original: req.params.id, numeroCompleto: factura.numeroCompleto },
    });

    sendOk(res, { invoice: factura }, undefined, 201);
  }),

  /**
   * POST /api/invoices/income/:id/send-email
   * TODO: Enviar factura por email (requiere configuración SMTP + render PDF).
   */
  enviarEmail: asyncHandler(async (req) => {
    void req;
    throw notImplemented('Envío de email pendiente. Requiere configurar SMTP + render PDF (plantilla de factura).');
  }),

  /**
   * POST /api/invoices/income/:id/make-recurring
   * TODO: Crear factura periódica (requiere configuración de recurrencia + job).
   */
  hacerRecurrente: asyncHandler(async (req) => {
    void req;
    throw notImplemented('Facturas periódicas pendientes. Requiere job scheduler + persistencia de patrón de recurrencia.');
  }),

  /**
   * GET /api/invoices/income/resumen/periodo
   * Obtener resumen de ingresos por período (para el dashboard).
   */
  resumenPeriodo: asyncHandler(async (req, res) => {
    const resumen = await incomeInvoicesService.resumenPorPeriodo(
      req.companyId!,
      req.query.desde as string | undefined,
      req.query.hasta as string | undefined,
    );

    sendOk(res, { resumen });
  }),
};
