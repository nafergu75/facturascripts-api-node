/**
 * Controller del EXTRACTOR CONTABLE DE FACTURAS con IA.
 * Rutas: /companies/:companyId/invoice-extractor/* (ver invoice-extractor.routes.ts)
 *
 * La subida acepta DOS formatos, para que cualquier consumidor pueda integrarse
 * sin multipart (p. ej. el proxy del backend de Newzelland envía JSON base64):
 *  - multipart/form-data con campo 'archivo' (+ campos empresaNif/empresaNombre)
 *  - JSON: { archivoBase64, nombre, mimeType, empresaNif?, empresaNombre? }
 */
import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/http-errors';
import { invoiceExtractorService } from '../services/invoice-extractor.service';

interface ArchivoSubido {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** Normaliza la subida (multipart multer o JSON base64) a un archivo en memoria. */
function extraerArchivo(req: Request): { archivo: ArchivoSubido; empresaNif: string | null; empresaNombre: string | null } {
  const file = (req as Request & { file?: ArchivoSubido }).file;
  if (file?.buffer?.length) {
    return {
      archivo: { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype },
      empresaNif: typeof req.body?.empresaNif === 'string' ? req.body.empresaNif : null,
      empresaNombre: typeof req.body?.empresaNombre === 'string' ? req.body.empresaNombre : null,
    };
  }

  const { archivoBase64, nombre, mimeType, empresaNif, empresaNombre } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof archivoBase64 === 'string' && archivoBase64.length > 0) {
    const buffer = Buffer.from(archivoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length === 0) throw badRequest('archivoBase64 no contiene datos válidos.');
    return {
      archivo: {
        buffer,
        originalname: typeof nombre === 'string' && nombre ? nombre : 'documento.pdf',
        mimetype: typeof mimeType === 'string' && mimeType ? mimeType : 'application/pdf',
      },
      empresaNif: typeof empresaNif === 'string' ? empresaNif : null,
      empresaNombre: typeof empresaNombre === 'string' ? empresaNombre : null,
    };
  }

  throw badRequest("No se recibió archivo: usa multipart (campo 'archivo') o JSON { archivoBase64, nombre, mimeType }.");
}

export const invoiceExtractorController = {
  /** POST /extract — extraer datos contables de una factura (síncrono). */
  extraer: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    const { archivo, empresaNif, empresaNombre } = extraerArchivo(req);
    const resultado = await invoiceExtractorService.extraer(companyId, userId, archivo, { empresaNif, empresaNombre });
    res.status(201).json({ ok: true, data: resultado });
  }),

  /** GET /:id — detalle de una extracción. */
  detalle: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const resultado = await invoiceExtractorService.detalle(companyId, req.params.id);
    res.json({ ok: true, data: resultado });
  }),

  /** PUT /:id — corregir la extracción (revisión manual); recalcula derivados. */
  corregir: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const { empresaNif, empresaNombre, ...patch } = (req.body ?? {}) as Record<string, unknown>;
    const resultado = await invoiceExtractorService.corregir(companyId, req.params.id, patch as never, {
      empresaNif: typeof empresaNif === 'string' ? empresaNif : null,
      empresaNombre: typeof empresaNombre === 'string' ? empresaNombre : null,
    });
    res.json({ ok: true, data: resultado });
  }),

  /** POST /:id/confirm — guardar PDF en carpeta definitiva y crear el asiento. */
  confirmar: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const resultado = await invoiceExtractorService.confirmar(companyId, req.params.id);
    res.json({ ok: true, data: resultado });
  }),
};
