import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  crearDocumentoArchivo,
  listarDocumentosPorPeriodo,
  obtenerDocumento,
  descargarArchivo,
  actualizarEstadoDocumento,
  eliminarDocumento,
  obtenerEstadisticasPeriodo,
  buscarDocumentos,
} from '../services/documentoArchivo.service';
import {
  arbolArchivo,
  listarTrimestre,
  zipTrimestre,
  regenerarArchivo,
  pdfFacturaVenta,
  validarPeriodo,
} from '../services/archivoFacturas.service';

/** Content-Disposition que admite nombres con tildes (RFC 5987) sin romper la cabecera. */
function adjunto(nombre: string): string {
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`;
}

export const documentoArchivoController = {
  /**
   * POST /companies/:companyId/archivo
   * Crea un nuevo registro de documento en el archivo
   */
  crear: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const {
      tipo,
      numeroFactura,
      emisor,
      receptor,
      nifCif,
      fecha,
      base,
      iva,
      retencion,
      total,
      archivoNombre,
      archivoTipo,
      origen,
      confianza,
      observaciones,
      facturaId,
    } = req.body;

    // Validar campos obligatorios
    if (!tipo || !['ingreso', 'gasto'].includes(tipo)) {
      throw badRequest('Tipo debe ser "ingreso" o "gasto"');
    }
    if (!fecha) {
      throw badRequest('Fecha es obligatoria');
    }
    if (!req.file) {
      throw badRequest('Archivo es obligatorio');
    }

    // Crear documento
    const documento = await crearDocumentoArchivo(companyId, {
      tipo,
      numeroFactura,
      emisor,
      receptor,
      nifCif,
      fecha,
      base: base ? parseFloat(base) : undefined,
      iva: iva ? parseFloat(iva) : undefined,
      retencion: retencion ? parseFloat(retencion) : undefined,
      total: total ? parseFloat(total) : undefined,
      archivoNombre: archivoNombre || req.file.originalname,
      archivoTipo: req.file.mimetype,
      archivoBuffer: req.file.buffer,
      // Opcional: adjuntar el original a una factura ya registrada.
      incomeInvoiceId: tipo === 'ingreso' && facturaId ? String(facturaId) : undefined,
      expenseInvoiceId: tipo === 'gasto' && facturaId ? String(facturaId) : undefined,
      origen,
      confianza: confianza ? parseFloat(confianza) : undefined,
      observaciones,
      uploadedBy: req.user?.userId,
    });

    sendOk(res, documento, undefined, 201);
  }),

  /**
   * GET /companies/:companyId/archivo
   * Lista documentos de un período con filtros opcionales
   * Query params:
   *  - año (obligatorio): número del año
   *  - mes (opcional): 1-12
   *  - trimestre (opcional): 1-4
   *  - tipo (opcional): "ingreso" o "gasto"
   *  - estado (opcional): "activo", "reemplazado", "anulado"
   *  - limite (opcional, default=50)
   *  - pagina (opcional, default=1)
   */
  listar: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { año, mes, trimestre, tipo, estado, limite, pagina } = req.query;

    if (!año) {
      throw badRequest('Parámetro "año" es obligatorio');
    }

    const resultado = await listarDocumentosPorPeriodo(companyId, {
      anio: parseInt(año as string),
      mes: mes ? parseInt(mes as string) : undefined,
      trimestre: trimestre ? parseInt(trimestre as string) : undefined,
      tipo: (tipo as any) || undefined,
      estado: (estado as string) || undefined,
      limite: limite ? parseInt(limite as string) : 50,
      pagina: pagina ? parseInt(pagina as string) : 1,
    });

    sendOk(res, resultado.documentos, {
      total: resultado.total,
      limite: limite ? parseInt(limite as string) : 50,
      pagina: pagina ? parseInt(pagina as string) : 1,
    });
  }),

  /**
   * GET /companies/:companyId/archivo/:id
   * Obtiene los detalles de un documento específico
   */
  obtener: asyncHandler(async (req, res) => {
    const { companyId, id } = req.params;
    const documento = await obtenerDocumento(companyId, id);
    sendOk(res, documento);
  }),

  /**
   * GET /companies/:companyId/archivo/:id/descargar
   * Descarga el archivo original
   */
  descargar: asyncHandler(async (req, res) => {
    const { companyId, id } = req.params;
    const { buffer, nombre, tipo } = await descargarArchivo(companyId, id);

    res.setHeader('Content-Type', tipo || 'application/octet-stream');
    res.setHeader('Content-Disposition', adjunto(nombre));
    res.setHeader('Content-Length', buffer.length);

    res.send(buffer);
  }),

  /**
   * PATCH /companies/:companyId/archivo/:id/estado
   * Actualiza el estado de un documento
   * Body: { estado: "activo" | "reemplazado" | "anulado", observaciones?: string }
   */
  actualizarEstado: asyncHandler(async (req, res) => {
    const { companyId, id } = req.params;
    const { estado, observaciones } = req.body;

    if (!estado || !['activo', 'reemplazado', 'anulado'].includes(estado)) {
      throw badRequest('Estado debe ser "activo", "reemplazado" o "anulado"');
    }

    const documento = await actualizarEstadoDocumento(companyId, id, estado, observaciones);
    sendOk(res, documento);
  }),

  /**
   * DELETE /companies/:companyId/archivo/:id
   * Marca un documento como anulado (soft delete)
   */
  eliminar: asyncHandler(async (req, res) => {
    const { companyId, id } = req.params;
    await eliminarDocumento(companyId, id);
    sendMessage(res, 'Documento anulado correctamente');
  }),

  /**
   * GET /companies/:companyId/archivo/estadisticas/periodo
   * Obtiene estadísticas de un período
   * Query params:
   *  - año (obligatorio)
   *  - mes (opcional)
   *  - trimestre (opcional)
   */
  obtenerEstadisticas: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { año, mes, trimestre } = req.query;

    if (!año) {
      throw badRequest('Parámetro "año" es obligatorio');
    }

    const estadisticas = await obtenerEstadisticasPeriodo(
      companyId,
      parseInt(año as string),
      mes ? parseInt(mes as string) : undefined,
      trimestre ? parseInt(trimestre as string) : undefined,
    );

    sendOk(res, estadisticas);
  }),

  /**
   * GET /companies/:companyId/archivo/buscar
   * Busca documentos por número de factura, emisor o receptor
   * Query params:
   *  - termino (obligatorio)
   *  - tipo (opcional): "ingreso" o "gasto"
   *  - limite (opcional, default=20)
   */
  buscar: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { termino, tipo, limite } = req.query;

    if (!termino) {
      throw badRequest('Parámetro "termino" es obligatorio');
    }

    const documentos = await buscarDocumentos(
      companyId,
      termino as string,
      (tipo as any) || undefined,
      limite ? parseInt(limite as string) : 20,
    );

    sendOk(res, documentos);
  }),
  /**
   * GET /companies/:companyId/archivo/arbol
   * Años (de más reciente a más antiguo) con sus 4 trimestres: nº y total de ventas y gastos.
   */
  arbol: asyncHandler(async (req, res) => {
    sendOk(res, await arbolArchivo(req.params.companyId));
  }),

  /**
   * GET /companies/:companyId/archivo/trimestre?anio=2026&trimestre=1
   * Facturas de venta y de gasto del trimestre.
   */
  trimestre: asyncHandler(async (req, res) => {
    const { anio, trimestre } = validarPeriodo(req.query.anio, req.query.trimestre ?? '');
    sendOk(res, await listarTrimestre(req.params.companyId, anio, trimestre));
  }),

  /**
   * GET /companies/:companyId/archivo/trimestre/zip?anio=2026&trimestre=1
   * ZIP con ventas/*.pdf, gastos/* y resumen.csv.
   */
  trimestreZip: asyncHandler(async (req, res) => {
    const { anio, trimestre } = validarPeriodo(req.query.anio, req.query.trimestre ?? '');
    const { nombre, contenido } = await zipTrimestre(req.params.companyId, anio, trimestre);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', adjunto(nombre));
    res.setHeader('Content-Length', contenido.length);
    res.send(contenido);
  }),

  /**
   * GET /companies/:companyId/archivo/ventas/:facturaId/pdf
   * PDF de una factura de venta del archivo (copia guardada o generada al vuelo).
   */
  pdfVenta: asyncHandler(async (req, res) => {
    const { nombre, contenido, mime } = await pdfFacturaVenta(req.params.companyId, req.params.facturaId);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', adjunto(nombre));
    res.send(contenido);
  }),

  /**
   * POST /companies/:companyId/archivo/regenerar  { anio?: number }
   * Archiva las facturas que aún no tienen documento (completa el histórico).
   */
  regenerar: asyncHandler(async (req, res) => {
    const anioBody = req.body?.anio ?? req.query.anio;
    const anio = anioBody ? validarPeriodo(anioBody).anio : undefined;
    sendOk(res, await regenerarArchivo(req.params.companyId, anio));
  }),
};
