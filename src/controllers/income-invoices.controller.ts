import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest, notImplemented } from '../utils/http-errors';
import { incomeInvoicesService, CrearFacturaIngresoDTO, ESTADOS_COBRO } from '../services/income-invoices.service';
import { avisosFactura, generarPdfFactura } from '../services/facturaPdf.service';
import { registrarAuditoria } from '../services/auditoria.service';
import { accountingHooksService } from '../services/accounting-hooks.service';
import { archivarVentaSinRomper } from '../services/archivoFacturas.service';

/**
 * Contabiliza una factura recien emitida y la guarda en el archivo de su
 * trimestre. No es critico: si falla (p. ej. sin plan contable o sin
 * almacenamiento), la factura queda emitida y se puede contabilizar o archivar
 * a mano (Archivo > Completar historial).
 */
async function contabilizar(companyId: string, invoiceId: string): Promise<void> {
  try {
    await accountingHooksService.onIncomeInvoiceConfirmed(companyId, invoiceId);
  } catch (err) {
    console.error(
      `Aviso: no se pudo contabilizar automáticamente la factura ${invoiceId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  await archivarVentaSinRomper(companyId, invoiceId);
}

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

    // Si se ha emitido directamente (no borrador), se contabiliza como al finalizar.
    if (factura.estadoDocumento === 'FINAL') await contabilizar(req.companyId!, factura.id);

    sendOk(res, { invoice: factura }, undefined, 201);
  }),

  /** PUT /:id — modifica un borrador (las emitidas no se tocan). */
  actualizar: asyncHandler(async (req, res) => {
    const factura = await incomeInvoicesService.actualizarBorrador(req.companyId!, req.params.id, req.body ?? {});
    sendOk(res, { invoice: factura });
  }),

  /** DELETE /:id — borra un borrador. */
  eliminar: asyncHandler(async (req, res) => {
    await incomeInvoicesService.eliminarBorrador(req.companyId!, req.params.id);
    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'BORRAR_BORRADOR_FACTURA',
      resourceType: 'INCOME_INVOICE',
      resourceId: req.params.id,
    });
    sendMessage(res, 'Borrador eliminado.');
  }),

  /** POST /:id/finalizar — emite el borrador: numero de la serie y datos congelados. */
  finalizar: asyncHandler(async (req, res) => {
    const factura = await incomeInvoicesService.finalizar(req.companyId!, req.params.id, {
      fechaEmision: req.body?.fechaEmision,
    });
    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'EMITIR_FACTURA_INGRESO',
      resourceType: 'INCOME_INVOICE',
      resourceId: factura.id,
      meta: { numeroCompleto: factura.numeroCompleto, total: factura.totalFactura },
    });
    await contabilizar(req.companyId!, factura.id);
    sendOk(res, { invoice: factura });
  }),

  /** POST /:id/duplicar — copia la factura en un borrador nuevo. */
  duplicar: asyncHandler(async (req, res) => {
    const factura = await incomeInvoicesService.duplicar(req.companyId!, req.params.id);
    sendOk(res, { invoice: factura }, undefined, 201);
  }),

  /** GET /:id/avisos — datos que faltan para que la factura salga completa. */
  avisos: asyncHandler(async (req, res) => {
    sendOk(res, { avisos: await avisosFactura(req.companyId!, req.params.id) });
  }),

  /** GET /:id/pdf — la factura en PDF (o el borrador, marcado como tal). */
  pdf: asyncHandler(async (req, res) => {
    const { nombre, contenido } = await generarPdfFactura(req.companyId!, req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
    res.send(contenido);
  }),

  /**
   * GET /api/invoices/income
   * Listar facturas de ingreso con filtros.
   */
  listar: asyncHandler(async (req, res) => {
    const resultado = await incomeInvoicesService.listar(req.companyId!, {
      estado: req.query.estado as string | undefined,
      estadoDocumento: req.query.estadoDocumento as string | undefined,
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
    if (!(ESTADOS_COBRO as readonly string[]).includes(nuevoEstado)) {
      throw badRequest(`Estado de cobro no válido. Usa: ${ESTADOS_COBRO.join(', ')}. Para emitir un borrador, finalízalo.`);
    }

    const b = req.body ?? {};
    const factura = await incomeInvoicesService.cambiarEstado(req.companyId!, req.params.id, nuevoEstado, {
      fecha: b.fecha,
      cuentaBancariaId: b.cuentaBancariaId,
      caja: b.caja === true || b.caja === 'true',
      nota: b.nota,
      userId: req.user?.userId,
    });

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
    const b = req.body ?? {};
    const factura = await incomeInvoicesService.crearRectificativa(req.companyId!, req.params.id, {
      motivo: b.motivo,
      lineas: b.lineas,
      tipoFactura: b.tipoFactura,
      tipoRectificativa: b.tipoRectificativa,
      serie: b.serie,
      borrador: b.borrador,
    });
    if (factura.estadoDocumento === 'FINAL') await contabilizar(req.companyId!, factura.id);

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
