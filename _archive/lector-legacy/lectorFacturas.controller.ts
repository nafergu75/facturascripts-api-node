/**
 * Controlador del lector LEGACY. Sustituido por income-reader.controller.ts.
 * No usar para nuevas integraciones: el lector canónico es income-reader,
 * consumido por el frontend Chakra. Este controlador solo sirve al frontend
 * vanilla antiguo. Ver ADR "Consolidación de lector OCR".
 */
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  procesarFacturaSubida,
  listarFacturasLeidas,
  obtenerFacturaLeida,
  actualizarFacturaLeida,
} from '../services/lectorFacturas.service';
import { crearFacturaDesdeFacturaLeida } from '../services/facturas.service';

/** Tipos de archivo aceptados por el lector de facturas. */
const MIME_PERMITIDOS = /^(application\/pdf|image\/(jpeg|png|gif|webp)|application\/xml|text\/xml)$/i;
const TAMANO_MAXIMO_BYTES = 15 * 1024 * 1024; // 15 MB, igual que el limite de multer

/**
 * Extrae el archivo subido. En produccion se usaria multer (req.file). Aqui se
 * admiten 3 formas para que funcione sin dependencias nuevas:
 *  - multer:  req.file = { buffer, originalname, mimetype }   (TODO middleware)
 *  - binario: express.raw -> req.body Buffer + Content-Type + ?nombre / X-Filename
 *  - JSON:    { nombreArchivo, mimeType, contenidoBase64 }
 *
 * Valida tipo MIME (solo PDF/imagen/XML) y tamano (<= 15 MB) antes de pasar el
 * archivo al servicio de extraccion.
 */
function extraerArchivo(req: {
  file?: { buffer: Buffer; originalname: string; mimetype: string };
  body: unknown;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
}): { buffer: Buffer; originalname: string; mimetype: string } {
  const archivo = leerArchivo(req);
  if (!MIME_PERMITIDOS.test(archivo.mimetype)) {
    throw badRequest(`Tipo de archivo no admitido (${archivo.mimetype}). Solo se aceptan PDF, imagenes (JPEG/PNG/GIF/WEBP) y XML.`);
  }
  if (archivo.buffer.length === 0) {
    throw badRequest('El archivo recibido esta vacio.');
  }
  if (archivo.buffer.length > TAMANO_MAXIMO_BYTES) {
    throw badRequest('El archivo supera el tamano maximo permitido (15 MB).');
  }
  return archivo;
}

function leerArchivo(req: {
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
  throw badRequest('No se ha recibido archivo. Usa multipart (multer), binario crudo o { nombreArchivo, mimeType, contenidoBase64 }.');
}

export const lectorFacturasController = {
  // POST /facturas/lector/upload
  upload: asyncHandler(async (req, res) => {
    const archivo = extraerArchivo(req as never);
    const fl = await procesarFacturaSubida(req.companyId!, archivo);
    sendOk(res, fl, undefined, 201);
  }),

  // GET /facturas/lector
  listar: asyncHandler(async (req, res) => {
    sendOk(res, await listarFacturasLeidas(req.companyId!));
  }),

  // GET /facturas/lector/:id
  detalle: asyncHandler(async (req, res) => {
    sendOk(res, await obtenerFacturaLeida(req.companyId!, req.params.id));
  }),

  // PUT /facturas/lector/:id  -> corregir el borrador tras el OCR (campos/lineas)
  actualizar: asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // Solo se permiten campos de datos del borrador (no id/companyId/estado/facturaId).
    const permitidos = ['numero', 'fecha', 'nifEmisor', 'nombreEmisor', 'nifReceptor', 'nombreReceptor', 'lineas', 'totalBase', 'totalIva', 'totalFactura', 'tipoDetectado'] as const;
    const patch: Record<string, unknown> = {};
    for (const k of permitidos) if (b[k] !== undefined) patch[k] = b[k];
    sendOk(res, await actualizarFacturaLeida(req.companyId!, req.params.id, patch));
  }),

  // POST /facturas/lector/:id/crear-factura?tipo=compra|venta
  crearFactura: asyncHandler(async (req, res) => {
    const tipo = String(req.query.tipo ?? '');
    if (tipo !== 'venta' && tipo !== 'compra') throw badRequest('Parametro tipo debe ser venta|compra.');
    const resultado = await crearFacturaDesdeFacturaLeida(req.companyId!, req.params.id, tipo);
    sendOk(res, resultado, undefined, 201);
  }),
};
