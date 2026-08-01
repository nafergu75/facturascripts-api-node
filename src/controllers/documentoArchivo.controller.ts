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
      origen,
      confianza: confianza ? parseFloat(confianza) : undefined,
      observaciones,
      uploadedBy: (req as any).userId,
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

    res.setHeader('Content-Type', tipo);
    res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
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
};
