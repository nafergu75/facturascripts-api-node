import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { incomeReaderService, ParsedInvoiceData } from '../services/income-reader.service';
import { registrarAuditoria } from '../services/auditoria.service';

/**
 * Extrae el archivo subido del request.
 * Soporta:
 * - multer: req.file
 * - binario crudo: req.body Buffer + Content-Type + ?nombre / X-Filename
 * - JSON: { nombreArchivo, mimeType, contenidoBase64 }
 */
function extraerArchivo(req: {
  file?: { buffer: Buffer; originalname: string; mimetype: string };
  body: unknown;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): { buffer: Buffer; originalname: string; mimetype: string } {
  if (req.file) return req.file;

  if (Buffer.isBuffer(req.body)) {
    const nombre = String(req.query.nombre ?? req.headers['x-filename'] ?? 'factura.bin');
    const mime = String(req.headers['content-type'] ?? 'application/octet-stream');
    return { buffer: req.body, originalname: nombre, mimetype: mime };
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.contenidoBase64 === 'string') {
    return {
      buffer: Buffer.from(b.contenidoBase64, 'base64'),
      originalname: String(b.nombreArchivo ?? 'factura.bin'),
      mimetype: String(b.mimeType ?? 'application/octet-stream'),
    };
  }

  throw badRequest('No archivo recibido. Usa multipart (multer), binario o { nombreArchivo, mimeType, contenidoBase64 }.');
}

export const incomeReaderController = {
  /**
   * POST /api/income-reader/mobile-upload
   * Subir foto desde app móvil.
   */
  subirDesdeMovil: asyncHandler(async (req, res) => {
    const archivo = extraerArchivo(req as never);
    const documento = await incomeReaderService.subirDesdeMovil(
      req.companyId!,
      req.user?.userId || 'unknown',
      archivo,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'SUBIR_DOCUMENTO_LECTOR_MOVIL',
      resourceType: 'INCOME_READER_DOCUMENT',
      resourceId: documento.id,
      meta: { fileName: archivo.originalname, mimeType: archivo.mimetype },
    });

    sendOk(res, { document: documento }, undefined, 201);
  }),

  /**
   * POST /api/income-reader/web-upload
   * Subir archivo desde web (drag & drop).
   */
  subirDesdeWeb: asyncHandler(async (req, res) => {
    const archivo = extraerArchivo(req as never);
    const documento = await incomeReaderService.subirDesdeWeb(
      req.companyId!,
      req.user?.userId || 'unknown',
      archivo,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'SUBIR_DOCUMENTO_LECTOR_WEB',
      resourceType: 'INCOME_READER_DOCUMENT',
      resourceId: documento.id,
      meta: { fileName: archivo.originalname, mimeType: archivo.mimetype },
    });

    sendOk(res, { document: documento }, undefined, 201);
  }),

  /**
   * POST /api/income-reader/email-hook
   * Webhook para recibir facturas por email.
   * Body: { readerEmail, remitente, adjuntos: [{buffer (base64), nombre, mimetype}] }
   */
  procesarDesdeEmail: asyncHandler(async (req, res) => {
    const { readerEmail, remitente, adjuntos } = req.body ?? {};

    if (!readerEmail || !Array.isArray(adjuntos)) {
      throw badRequest('Se requiere readerEmail y adjuntos (array).');
    }

    // Convertir base64 a buffer si es necesario
    const adjuntosBuffer = (adjuntos as Array<Record<string, unknown>>).map((a) => {
      const buf = typeof a.buffer === 'string' ? Buffer.from(a.buffer, 'base64') : a.buffer;
      return {
        buffer: buf as Buffer,
        nombre: String(a.nombre || 'attachment'),
        mimetype: String(a.mimetype || 'application/octet-stream'),
      };
    });

    const documentos = await incomeReaderService.procesarDesdeEmail(
      req.companyId!,
      readerEmail,
      remitente,
      adjuntosBuffer,
    );

    await registrarAuditoria({
      userId: 'system-email-hook',
      companyId: req.companyId,
      action: 'PROCESAR_DOCUMENTOS_EMAIL',
      resourceType: 'INCOME_READER_DOCUMENT',
      meta: { cantidad: documentos.length, remitente },
    });

    sendOk(res, { documents: documentos, cantidad: documentos.length }, undefined, 201);
  }),

  /**
   * GET /api/income-reader/pending
   * Listar documentos pendientes de verificar.
   */
  listarPendientes: asyncHandler(async (req, res) => {
    const documentos = await incomeReaderService.listarPendientes(req.companyId!);
    sendOk(res, { documents: documentos, cantidad: documentos.length });
  }),

  /**
   * GET /api/income-reader/:id
   * Obtener detalle de un documento.
   */
  obtenerDetalle: asyncHandler(async (req, res) => {
    const documento = await incomeReaderService.obtenerDetalle(req.companyId!, req.params.id);
    sendOk(res, { document: documento });
  }),

  /**
   * PUT /api/income-reader/:id
   * Actualizar datos extraídos (correcciones manuales antes de verificar).
   */
  actualizar: asyncHandler(async (req, res) => {
    const patch: Partial<ParsedInvoiceData> = {};

    const permitidos = ['numero', 'fecha', 'fechaVencimiento', 'nifEmisor', 'nombreEmisor', 'nifReceptor', 'nombreReceptor', 'baseImponible', 'totalIva', 'totalRetencion', 'total', 'lineas', 'tipoDetectado'] as const;

    for (const k of permitidos) {
      if ((req.body ?? {})[k] !== undefined) {
        (patch as Record<string, unknown>)[k] = (req.body as Record<string, unknown>)[k];
      }
    }

    const documento = await incomeReaderService.actualizarParsedData(req.companyId!, req.params.id, patch);

    sendOk(res, { document: documento });
  }),

  /**
   * POST /api/income-reader/:id/verify
   * Verificar documento y crear factura de ingreso.
   */
  verificar: asyncHandler(async (req, res) => {
    const resultado = await incomeReaderService.verificarYCrearFactura(req.companyId!, req.params.id);

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'VERIFICAR_DOCUMENTO_LECTOR',
      resourceType: 'INCOME_READER_DOCUMENT',
      resourceId: req.params.id,
      meta: { linkedInvoiceId: resultado.linkedInvoiceId },
    });

    sendOk(res, resultado, undefined, 201);
  }),

  /**
   * POST /api/income-reader/:id/reject
   * Rechazar un documento.
   */
  rechazar: asyncHandler(async (req, res) => {
    const motivo = req.body?.motivo as string | undefined;
    const documento = await incomeReaderService.rechazar(req.companyId!, req.params.id, motivo);

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'RECHAZAR_DOCUMENTO_LECTOR',
      resourceType: 'INCOME_READER_DOCUMENT',
      resourceId: req.params.id,
      meta: { motivo: motivo || 'No especificado' },
    });

    sendOk(res, { document: documento });
  }),

  /**
   * GET /api/income-reader/config
   * Obtener configuración de email del lector.
   */
  obtenerConfig: asyncHandler(async (req, res) => {
    const config = await incomeReaderService.obtenerConfig(req.companyId!);
    sendOk(res, { config });
  }),

  /**
   * POST /api/income-reader/config
   * Crear/actualizar configuración de email del lector.
   */
  actualizarConfig: asyncHandler(async (req, res) => {
    const { readerEmail, isActive } = req.body ?? {};
    if (!readerEmail) throw badRequest('Se requiere readerEmail.');

    const config = await incomeReaderService.actualizarConfig(
      req.companyId!,
      readerEmail,
      isActive ?? true,
    );

    sendOk(res, { config }, undefined, 201);
  }),
};
