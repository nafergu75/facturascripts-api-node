import { Request } from 'express';
import { badRequest } from './http-errors';

export interface ArchivoSubido {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

/** Tipos que leen los extractores de facturas (Claude vision): PDF e imagenes. */
const TIPOS_FACTURA = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Firma de los primeros bytes: el tipo declarado tiene que coincidir con el contenido. */
function tipoReal(buffer: Buffer): string | null {
  const b = buffer.subarray(0, 12);
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  return null;
}

/**
 * Normaliza la subida de una factura: multipart (campo 'archivo') o JSON
 * { archivoBase64, nombre, mimeType }. Solo acepta PDF e imagenes, y comprueba
 * el contenido real, no solo el tipo que declara el cliente.
 */
export function leerFacturaSubida(req: Request): ArchivoSubido {
  let archivo: ArchivoSubido | null = null;

  const file = (req as Request & { file?: ArchivoSubido }).file;
  if (file?.buffer?.length) {
    archivo = { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype };
  } else {
    const { archivoBase64, nombre, mimeType } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof archivoBase64 === 'string' && archivoBase64.length > 0) {
      const buffer = Buffer.from(archivoBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buffer.length === 0) throw badRequest('archivoBase64 no contiene datos validos.');
      archivo = {
        buffer,
        originalname: typeof nombre === 'string' && nombre ? nombre : 'factura.pdf',
        mimetype: typeof mimeType === 'string' && mimeType ? mimeType : 'application/pdf',
      };
    }
  }
  if (!archivo) {
    throw badRequest("No se recibio archivo: usa multipart (campo 'archivo') o JSON { archivoBase64, nombre, mimeType }.");
  }

  const real = tipoReal(archivo.buffer);
  if (!real || !TIPOS_FACTURA.has(real)) throw badRequest('Solo se admiten facturas en PDF o imagen (JPG, PNG, WEBP).');
  // Se usa el tipo detectado: el declarado por el cliente puede no coincidir.
  return { ...archivo, mimetype: real };
}
