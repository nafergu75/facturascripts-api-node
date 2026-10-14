/**
 * Imagenes de la plantilla B de factura (Configuracion > Facturacion):
 *  - MARCA: el segundo logo, el de la marca (PRACTIKA en la muestra NZ013_2026),
 *    que sale arriba en el centro, debajo del logo de la empresa;
 *  - SELLO: el sello de la empresa, abajo a la izquierda, junto a los totales.
 * Son opcionales: sin ellas, la factura sale sin esos huecos rellenos.
 *
 * PNG o JPG de 1 MB como mucho (por su cabecera, no por la extension), una de
 * cada por empresa, en la BD (tabla ImagenFactura), como el logo de la empresa:
 * son pequenas y asi no dependen de Vercel Blob. Valen para los PDF que se
 * generen despues. Una factura ya emitida se descarga con la copia que se
 * archivo al emitirla (facturaPdf.service, pdfParaDescargar), con las imagenes
 * de entonces; solo si esa copia falta se genera con las de ahora.
 */
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import { tipoImagen } from './legalConfig.service';

export const TIPOS_IMAGEN_FACTURA = ['MARCA', 'SELLO'] as const;
export type TipoImagenFactura = (typeof TIPOS_IMAGEN_FACTURA)[number];

/** 1 MB, como el logo de la empresa. */
export const IMAGEN_FACTURA_MAX = 1024 * 1024;

const NOMBRE: Record<TipoImagenFactura, string> = { MARCA: 'El logo de la marca', SELLO: 'El sello' };

/** Tipo de la ruta (marca | sello, sin distinguir mayusculas); si no, 400. */
export function leerTipoImagenFactura(v: unknown): TipoImagenFactura {
  const t = String(v ?? '').trim().toUpperCase();
  if ((TIPOS_IMAGEN_FACTURA as readonly string[]).includes(t)) return t as TipoImagenFactura;
  throw badRequest('La imagen tiene que ser «marca» (el logo de la marca) o «sello» (el sello de la empresa).', { campo: 'tipo' });
}

/** Guarda (o cambia) la imagen: PNG o JPG de 1 MB como mucho. */
export async function guardarImagenFactura(companyId: string, tipo: TipoImagenFactura, fichero: Buffer | undefined): Promise<void> {
  if (!fichero?.length) throw badRequest('Elige una imagen PNG o JPG.', { campo: 'imagen' });
  if (fichero.length > IMAGEN_FACTURA_MAX) throw badRequest(`${NOMBRE[tipo]} no puede pasar de 1 MB.`, { campo: 'imagen' });
  const mime = tipoImagen(fichero);
  if (!mime) throw badRequest(`${NOMBRE[tipo]} tiene que ser una imagen PNG o JPG.`, { campo: 'imagen' });
  await prisma.imagenFactura.upsert({
    where: { companyId_tipo: { companyId, tipo } },
    create: { companyId, tipo, datos: fichero, mime },
    update: { datos: fichero, mime },
  });
}

/** La imagen (bytes y tipo), o null si no hay. */
export async function obtenerImagenFactura(companyId: string, tipo: TipoImagenFactura): Promise<{ bytes: Buffer; mime: string } | null> {
  const fila = await prisma.imagenFactura.findUnique({ where: { companyId_tipo: { companyId, tipo } }, select: { datos: true, mime: true } });
  return fila ? { bytes: Buffer.from(fila.datos), mime: fila.mime } : null;
}

/** Quita la imagen (si no habia, no pasa nada). */
export async function borrarImagenFactura(companyId: string, tipo: TipoImagenFactura): Promise<void> {
  await prisma.imagenFactura.deleteMany({ where: { companyId, tipo } });
}

/** Las dos imagenes para el PDF de la plantilla B (null las que no hay). Solo lee. */
export async function imagenesPdfPlantillaB(companyId: string): Promise<{ marca: { bytes: Uint8Array; mime: string } | null; sello: { bytes: Uint8Array; mime: string } | null }> {
  if (typeof (prisma as unknown as { imagenFactura?: { findMany?: unknown } }).imagenFactura?.findMany !== 'function') return { marca: null, sello: null };
  const filas = await prisma.imagenFactura.findMany({ where: { companyId }, select: { tipo: true, datos: true, mime: true } });
  const de = (t: TipoImagenFactura) => {
    const f = filas.find((x) => x.tipo === t);
    return f ? { bytes: new Uint8Array(f.datos), mime: f.mime } : null;
  };
  return { marca: de('MARCA'), sello: de('SELLO') };
}
