import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { accountingClosureService } from '../services/accounting-closure.service';
import { registrarAuditoria } from '../services/auditoria.service';

/**
 * Extrae el archivo subido del request.
 */
function extraerArchivo(req: {
  file?: { buffer: Buffer; originalname: string; mimetype: string };
  body: unknown;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): { buffer: Buffer; originalname: string; mimetype: string } {
  if (req.file) return req.file;

  if (Buffer.isBuffer(req.body)) {
    const nombre = String(req.query.nombre ?? req.headers['x-filename'] ?? 'cierre.bin');
    const mime = String(req.headers['content-type'] ?? 'application/octet-stream');
    return { buffer: req.body, originalname: nombre, mimetype: mime };
  }

  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.contenidoBase64 === 'string') {
    return {
      buffer: Buffer.from(b.contenidoBase64, 'base64'),
      originalname: String(b.nombreArchivo ?? 'cierre.bin'),
      mimetype: String(b.mimeType ?? 'application/octet-stream'),
    };
  }

  throw badRequest('No archivo recibido. Usa multipart, binario o { nombreArchivo, mimeType, contenidoBase64 }.');
}

export const accountingClosureController = {
  /**
   * POST /api/accounting/closures
   * Crear cierre de período.
   */
  crearCierre: asyncHandler(async (req, res) => {
    const { ejercicio } = req.body ?? {};
    if (!ejercicio) throw badRequest('ejercicio requerido.');

    const cierre = await accountingClosureService.crearCierrePeriodo(
      req.companyId!,
      Number(ejercicio),
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CREAR_CIERRE_PERIODO',
      resourceType: 'ACCOUNTING_CLOSURE',
      resourceId: cierre.id,
      meta: { ejercicio },
    });

    sendOk(res, { cierre }, undefined, 201);
  }),

  /**
   * GET /api/accounting/closures
   * Listar cierres.
   */
  listarCierres: asyncHandler(async (req, res) => {
    const estado = req.query.estado as string | undefined;
    const desde = req.query.desde ? Number(req.query.desde) : undefined;
    const hasta = req.query.hasta ? Number(req.query.hasta) : undefined;

    const cierres = await accountingClosureService.listarCierres(
      req.companyId!,
      { estado, desde, hasta },
    );

    sendOk(res, { cierres, cantidad: cierres.length });
  }),

  /**
   * GET /api/accounting/closures/:ejercicio
   * Obtener cierre por ejercicio.
   */
  obtenerCierre: asyncHandler(async (req, res) => {
    const cierre = await accountingClosureService.obtenerCierre(
      req.companyId!,
      Number(req.params.ejercicio),
    );

    sendOk(res, { cierre });
  }),

  /**
   * PATCH /api/accounting/closures/:ejercicio/status
   * Cambiar estado de cierre.
   */
  cambiarEstado: asyncHandler(async (req, res) => {
    const { estado, cierreContable, balanceGeneral, cuentaResultados, observaciones } = req.body ?? {};
    if (!estado) throw badRequest('estado requerido.');

    const cierre = await accountingClosureService.cambiarEstadoCierre(
      req.companyId!,
      Number(req.params.ejercicio),
      estado,
      { cierreContable, balanceGeneral, cuentaResultados, observaciones },
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CAMBIAR_ESTADO_CIERRE',
      resourceType: 'ACCOUNTING_CLOSURE',
      resourceId: cierre.id,
      meta: { estado },
    });

    sendOk(res, { cierre });
  }),

  /**
   * POST /api/accounting/closures/:ejercicio/upload
   * Subir archivo de cierre (PDF, Excel).
   */
  subirArchivo: asyncHandler(async (req, res) => {
    const archivo = extraerArchivo(req as never);
    const tipoContenido = req.query.tipoContenido as string || 'BALANCE_GENERAL';

    const archivoRegistro = await accountingClosureService.subirArchivoCierre(
      req.companyId!,
      Number(req.params.ejercicio),
      archivo,
      tipoContenido,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'SUBIR_ARCHIVO_CIERRE',
      resourceType: 'ACCOUNTING_CLOSURE_FILE',
      resourceId: archivoRegistro.id,
      meta: { tipoArchivo: archivoRegistro.tipoArchivo, tipoContenido },
    });

    sendOk(res, { archivo: archivoRegistro }, undefined, 201);
  }),

  /**
   * GET /api/accounting/closures/:ejercicio/files
   * Listar archivos de cierre.
   */
  listarArchivos: asyncHandler(async (req, res) => {
    const archivos = await accountingClosureService.listarArchivosCierre(
      req.companyId!,
      Number(req.params.ejercicio),
    );

    sendOk(res, { archivos, cantidad: archivos.length });
  }),

  /**
   * POST /api/accounting/prior-years
   * Guardar datos de ejercicio anterior.
   */
  guardarDatosAnterior: asyncHandler(async (req, res) => {
    const { ejercicio, ...datos } = req.body ?? {};
    if (!ejercicio) throw badRequest('ejercicio requerido.');

    const registro = await accountingClosureService.guardarDatosEjercicioAnterior(
      req.companyId!,
      Number(ejercicio),
      datos,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'GUARDAR_DATOS_EJERCICIO',
      resourceType: 'PRIOR_YEAR_DATA',
      resourceId: registro.id,
      meta: { ejercicio },
    });

    sendOk(res, { datos: registro }, undefined, 201);
  }),

  /**
   * GET /api/accounting/prior-years/:ejercicio
   * Obtener datos de ejercicio anterior.
   */
  obtenerDatosAnterior: asyncHandler(async (req, res) => {
    const datos = await accountingClosureService.obtenerDatosEjercicioAnterior(
      req.companyId!,
      Number(req.params.ejercicio),
    );

    sendOk(res, { datos });
  }),

  /**
   * GET /api/accounting/prior-years
   * Listar ejercicios anteriores.
   */
  listarEjerciciosAnteriores: asyncHandler(async (req, res) => {
    const desde = req.query.desde ? Number(req.query.desde) : undefined;
    const hasta = req.query.hasta ? Number(req.query.hasta) : undefined;

    const ejercicios = await accountingClosureService.listarEjerciciosAnteriores(
      req.companyId!,
      { desde, hasta },
    );

    sendOk(res, { ejercicios, cantidad: ejercicios.length });
  }),

  /**
   * GET /api/accounting/comparativas/:ej1/:ej2
   * Obtener comparativa entre dos años.
   */
  obtenerComparativa: asyncHandler(async (req, res) => {
    const comparativa = await accountingClosureService.obtenerComparativa(
      req.companyId!,
      Number(req.params.ej1),
      Number(req.params.ej2),
    );

    sendOk(res, { comparativa });
  }),
};
