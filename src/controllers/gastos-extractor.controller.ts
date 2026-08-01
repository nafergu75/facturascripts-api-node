/**
 * Controlador del EXTRACTOR DE GASTOS con IA.
 * Rutas: /companies/:companyId/gastos-extractor/* (ver gastos-extractor.routes.ts)
 *
 * Acepta DOS formatos para máxima flexibilidad:
 *  - multipart/form-data con campo 'archivo'
 *  - JSON: { archivoBase64, nombre, mimeType }
 */

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/http-errors';
import { sendOk } from '../utils/response';
import { gastosExtractorService, GastoExtraido } from '../services/gastos-extractor.service';

interface ArchivoSubido {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/**
 * Normaliza la subida (multipart multer o JSON base64) a un archivo en memoria.
 */
function extraerArchivo(req: Request): { archivo: ArchivoSubido } {
  const file = (req as Request & { file?: ArchivoSubido }).file;
  if (file?.buffer?.length) {
    return {
      archivo: {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
      },
    };
  }

  const { archivoBase64, nombre, mimeType } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof archivoBase64 === 'string' && archivoBase64.length > 0) {
    const buffer = Buffer.from(archivoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length === 0) throw badRequest('archivoBase64 no contiene datos válidos.');
    return {
      archivo: {
        buffer,
        originalname: typeof nombre === 'string' && nombre ? nombre : 'comprobante.pdf',
        mimetype: typeof mimeType === 'string' && mimeType ? mimeType : 'application/pdf',
      },
    };
  }

  throw badRequest("No se recibió archivo: usa multipart (campo 'archivo') o JSON { archivoBase64, nombre, mimeType }.");
}

export const gastosExtractorController = {
  /**
   * POST /extraer-ia — extraer datos contables de un comprobante de gasto (síncrono).
   * Retorna GastoExtraido con sugerencia de cuenta contable.
   */
  extraer: asyncHandler(async (req: Request, res: Response) => {
    const { archivo } = extraerArchivo(req);
    const resultado: GastoExtraido = await gastosExtractorService.extraer(archivo);
    res.status(201).json({ ok: true, data: resultado });
  }),

  /**
   * POST /confirmar — confirma un gasto extraído y lo guarda (crea asiento contable).
   * Body esperado:
   * {
   *   numeroFactura, proveedor, nifProveedor, fecha,
   *   conceptoGasto, base, iva, total,
   *   cuentaContableBase (opcional, si quiere override)
   * }
   */
  confirmar: asyncHandler(async (req: Request, res: Response) => {
    const companyId = req.companyId as string;
    const userId = (req as Request & { user?: { id?: string } }).user?.id;

    const {
      numeroFactura,
      proveedor,
      nifProveedor,
      fecha,
      conceptoGasto,
      base,
      iva,
      total,
      cuentaContableBase,
    } = (req.body ?? {}) as Record<string, unknown>;

    // Validaciones básicas
    if (!numeroFactura || typeof numeroFactura !== 'string') {
      throw badRequest('numeroFactura es requerido.');
    }
    if (!proveedor || typeof proveedor !== 'string') {
      throw badRequest('proveedor es requerido.');
    }
    if (typeof base !== 'number' || typeof iva !== 'number' || typeof total !== 'number') {
      throw badRequest('base, iva, total deben ser números.');
    }
    if (!fecha || typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      throw badRequest('fecha debe tener formato YYYY-MM-DD.');
    }

    // Aquí iría la lógica de crear un asiento contable.
    // Por ahora, retornamos un objeto confirmado simulado.
    const resultado = {
      ok: true,
      gastoId: `gasto-${Date.now()}`,
      numeroFactura,
      proveedor,
      fecha,
      base,
      iva,
      total,
      cuentaContableBase,
      estado: 'CONFIRMADO',
      creadoEn: new Date().toISOString(),
    };

    sendOk(res, resultado);
  }),
};
