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
import { badRequest, notImplemented } from '../utils/http-errors';
import { prisma } from '../config/database';
import { AVISO_NO_FACTURA, gastosExtractorService, GastoExtraido } from '../services/gastos-extractor.service';

/**
 * Si la empresa lleva las nominas en la app (tiene trabajadores dados de alta).
 * Solo entonces una nomina, un RLC o una cuenta 640-642 tienen que ir por
 * Nominas: una empresa sin trabajadores (p. ej. una SL cuyo administrador paga
 * su cuota de autonomos) registra el recibo de la Seguridad Social como gasto.
 */
async function empresaConNominas(companyId: string): Promise<boolean> {
  const db = prisma as unknown as { empleado?: { count?: unknown } };
  if (typeof db.empleado?.count !== 'function') return false;
  try {
    return (await prisma.empleado.count({ where: { companyId } })) > 0;
  } catch {
    return false; // sin la tabla de nominas (esquema sin aplicar): como antes de existir
  }
}

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
   * POST /confirmar — de momento NO registra nada: responde 501 (ver al final).
   * Las nominas y los seguros sociales con trabajadores siguen dando 400 (van a Nominas).
   * Body esperado:
   * {
   *   numeroFactura, proveedor, nifProveedor, fecha,
   *   conceptoGasto, base, iva, total,
   *   cuentaContableBase (opcional, si quiere override)
   * }
   */
  confirmar: asyncHandler(async (req: Request, _res: Response) => {
    const companyId = req.companyId as string;
    const { cuentaContableBase, tipoDocumento } = (req.body ?? {}) as Record<string, unknown>;

    // Las nominas y los seguros sociales de una empresa que lleva sus nominas en la
    // app no son facturas de gasto: van a Nominas (antes se guardaban como facturas
    // de la 640/642, sin trabajador ni retenciones). Si el usuario corrige la
    // clasificacion en la pantalla ("Es una factura de gasto"), llega como 'factura'.
    const conNominas = (tipoDocumento === 'nomina' || tipoDocumento === 'seguros_sociales' || typeof cuentaContableBase === 'string') && (await empresaConNominas(companyId));
    if (conNominas && (tipoDocumento === 'nomina' || tipoDocumento === 'seguros_sociales')) {
      throw badRequest(AVISO_NO_FACTURA[tipoDocumento]);
    }
    if (conNominas && typeof cuentaContableBase === 'string' && /^64[012]/.test(cuentaContableBase.trim())) {
      throw badRequest('Las cuentas 640, 641 y 642 son de nóminas: con trabajadores dados de alta, se registran en Nóminas, no como facturas de gasto.');
    }

    // Antes devolvia un gasto "confirmado" inventado (gastoId falso) sin guardar
    // nada, y la pantalla decia «Gasto registrado». Hasta que se conecte con el
    // alta real de facturas de gasto, no se finge: 501 y no se crea nada.
    throw notImplemented('El registro desde el lector de gastos aún no está disponible: da de alta la factura en Compras');
  }),
};
