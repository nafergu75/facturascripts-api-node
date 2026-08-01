/**
 * ============================================================================
 * LECTOR DE FACTURAS — LEGACY. Sustituido por income-reader.service.ts.
 * ============================================================================
 *
 * NO USAR PARA NUEVAS INTEGRACIONES. El lector canónico del proyecto es
 * `income-reader.service.ts` (persistencia Prisma, consumido por el frontend
 * Chakra en /lector). Este módulo se mantiene VIVO solo porque el frontend
 * vanilla antiguo (`frontend/`, puerto 5173) todavía consume sus rutas
 * `/companies/:companyId/facturas/lector/*` y espera esta forma de respuesta
 * (`FacturaLeida`, con totalBase/totalIva/totalFactura y estado
 * pendiente_revision). Ver ADR "Consolidación de lector OCR".
 *
 * Para evitar duplicar la integración con Claude, el OCR de PDF/imagen YA NO
 * vive aquí: se delega en `procesarOCR` de income-reader y se mapea su salida
 * (`ParsedInvoiceData`) a `SalidaOCRFactura`. Lo único propio que conserva este
 * lector es el parser de Facturae XML (`parsearFacturaeXML`), que income-reader
 * no implementa todavía.
 * ============================================================================
 */
import { randomUUID } from 'crypto';
import path from 'path';
import { FacturaLeida, LineaFacturaLeida, SalidaOCRFactura, TipoFacturaDetectada } from '../domain/lector-facturas.model';
import { getFsClientForCompany } from './facturascripts-client';
import { notFound } from '../utils/http-errors';
import { config } from '../config/env';
import { procesarOCR, parsearFacturaeXML as parsearFacturaeXMLCanonico, ParsedInvoiceData } from './income-reader.service';
import { putObject } from '../utils/storage';

// TODO (legacy): este lector persiste en memoria; el canónico income-reader ya
// persiste en BD (tabla IncomeReaderDocument). No migrar este Map: deprecar.
const store = new Map<string, FacturaLeida>();
const ahora = (): string => new Date().toISOString();

/** True si hay un OCR real disponible (Claude configurado vía income-reader). */
const ocrDisponible = !!config.anthropicApiKey;

/**
 * Mapea la salida del OCR canónico (`ParsedInvoiceData` de income-reader) a la
 * forma legacy `SalidaOCRFactura` que espera el frontend vanilla. Renombra los
 * totales (baseImponible→totalBase, total→totalFactura) y descarta campos que
 * el modelo legacy no contempla (confianza, retención, tipoRetencion).
 */
function mapearParsedASalidaOCR(p: ParsedInvoiceData): SalidaOCRFactura {
  const lineas: LineaFacturaLeida[] = (p.lineas ?? []).map((l) => ({
    descripcion: l.descripcion ?? 'Concepto',
    cantidad: l.cantidad ?? 1,
    baseImponible: l.baseImponible,
    tipoIva: l.tipoIva,
    // income-reader no expone importeIva por línea; se reconstruye desde base×tipo
    // (redondeo a céntimos) para conservar el contrato legacy del frontend vanilla.
    importeIva:
      l.baseImponible != null && l.tipoIva != null
        ? Math.round(l.baseImponible * l.tipoIva) / 100
        : undefined,
    totalLinea: l.totalLinea,
  }));

  return {
    numero: p.numero,
    fecha: p.fecha,
    nifEmisor: p.nifEmisor,
    nombreEmisor: p.nombreEmisor,
    nifReceptor: p.nifReceptor,
    nombreReceptor: p.nombreReceptor,
    lineas: lineas.length > 0 ? lineas : undefined,
    totalBase: p.baseImponible,
    totalIva: p.totalIva,
    totalFactura: p.total,
  };
}

/**
 * Extracción de datos del archivo subido (PDF/imagen/XML): DELEGA TODO en el
 * lector canónico (income-reader `procesarOCR`), que ya distingue XML Facturae
 * (parser estructurado, sin clave) de PDF/imagen (OCR Claude), y mapea su salida
 * `ParsedInvoiceData` a la forma legacy `SalidaOCRFactura`. No duplica ni el OCR
 * ni el parser XML.
 */
async function extraerDatosFactura(buffer: Buffer, mimeType: string): Promise<SalidaOCRFactura> {
  const parsed = await procesarOCR(buffer, mimeType);
  return mapearParsedASalidaOCR(parsed);
}

/**
 * Parser de Facturae XML — SHIM LEGACY. Conserva la firma histórica
 * (`xml -> SalidaOCRFactura`) que usan los tests y el frontend vanilla, pero el
 * parsing REAL ya vive en income-reader (`parsearFacturaeXMLCanonico`): aquí solo
 * se adapta el resultado a la forma legacy. Cuando se retire el frontend vanilla,
 * este export puede eliminarse y usarse directamente el canónico.
 */
export function parsearFacturaeXML(xml: string): SalidaOCRFactura {
  return mapearParsedASalidaOCR(parsearFacturaeXMLCanonico(xml));
}

/** True si el OCR no ha podido detectar ningun dato util de la factura. */
function sinDatosDetectados(ocr: SalidaOCRFactura): boolean {
  return !ocr.numero && !ocr.fecha && !ocr.nifEmisor && !ocr.nifReceptor && !ocr.totalFactura && !(ocr.lineas && ocr.lineas.length > 0);
}

/**
 * Heuristica de tipo: compara el NIF del receptor/emisor con el NIF de la empresa
 * (leido de FacturaScripts). Si la empresa es el RECEPTOR -> compra; si es el
 * EMISOR -> venta; si no se puede determinar -> desconocido.
 */
async function detectarTipo(companyId: string, ocr: SalidaOCRFactura): Promise<TipoFacturaDetectada> {
  if (!ocr.nifEmisor && !ocr.nifReceptor) return 'desconocido';
  let nifEmpresa = '';
  try {
    const fs = await getFsClientForCompany(companyId);
    const { items } = await fs.listWithMeta('empresas', { limit: 1 });
    nifEmpresa = String((items[0] as Record<string, unknown> | undefined)?.cifnif ?? '').toUpperCase();
  } catch {
    // Sin acceso a FS no se puede contrastar -> desconocido (el usuario decide).
  }
  if (!nifEmpresa) return 'desconocido';
  if (ocr.nifReceptor && ocr.nifReceptor.toUpperCase() === nifEmpresa) return 'compra';
  if (ocr.nifEmisor && ocr.nifEmisor.toUpperCase() === nifEmpresa) return 'venta';
  return 'desconocido';
}

/**
 * Procesa una factura subida:
 *  1) guarda el archivo en almacenamiento -> rutaAlmacenamiento
 *  2) extrae datos via OCR (TODO conector real)
 *  3) detecta el tipo (venta/compra) por NIF
 *  4) construye y almacena el borrador FacturaLeida (estado pendiente_revision)
 */
export async function procesarFacturaSubida(
  companyId: string,
  file: { buffer: Buffer; originalname: string; mimetype: string },
  origen: FacturaLeida['origen'] = 'upload',
): Promise<FacturaLeida> {
  const id = randomUUID();

  // 1) Guardar el binario (Vercel Blob en producción, disco local en dev).
  const ext = path.extname(file.originalname) || '';
  const rutaAlmacenamiento = await putObject(`facturas-leidas/${companyId}_${id}${ext}`, file.buffer, file.mimetype);

  // 2) OCR / extraccion
  const ocr = await extraerDatosFactura(file.buffer, file.mimetype);

  // 3) Tipo
  const tipoDetectado = await detectarTipo(companyId, ocr);

  // 3b) Aviso si el OCR no ha detectado nada (revision manual necesaria)
  let avisoLectura: string | undefined;
  if (sinDatosDetectados(ocr)) {
    avisoLectura = ocrDisponible
      ? 'No se han podido detectar datos de esta factura automaticamente. Completa los campos manualmente.'
      : 'El lector automatico de PDF/imagen no esta configurado (falta ANTHROPIC_API_KEY). Completa los campos manualmente.';
  }

  // 4) Borrador
  const fl: FacturaLeida = {
    id,
    companyId,
    tipoDetectado,
    origen,
    nombreArchivo: file.originalname,
    mimeType: file.mimetype,
    rutaAlmacenamiento,
    numero: ocr.numero,
    fecha: ocr.fecha,
    nifEmisor: ocr.nifEmisor,
    nombreEmisor: ocr.nombreEmisor,
    nifReceptor: ocr.nifReceptor,
    nombreReceptor: ocr.nombreReceptor,
    lineas: ocr.lineas ?? [],
    totalBase: ocr.totalBase,
    totalIva: ocr.totalIva,
    totalFactura: ocr.totalFactura,
    estado: 'pendiente_revision',
    avisoLectura,
    creadaEn: ahora(),
    actualizadaEn: ahora(),
  };
  store.set(id, fl);
  return fl;
}

export async function listarFacturasLeidas(companyId: string): Promise<FacturaLeida[]> {
  return [...store.values()]
    .filter((f) => f.companyId === companyId)
    .sort((a, b) => (a.creadaEn < b.creadaEn ? 1 : -1));
}

export async function obtenerFacturaLeida(companyId: string, id: string): Promise<FacturaLeida> {
  const fl = store.get(id);
  if (!fl || fl.companyId !== companyId) throw notFound('Factura leida no encontrada.');
  return fl;
}

/** Actualiza campos del borrador (correccion manual tras el OCR, o enlace a factura). */
export async function actualizarFacturaLeida(
  companyId: string,
  id: string,
  patch: Partial<FacturaLeida>,
): Promise<FacturaLeida> {
  const fl = await obtenerFacturaLeida(companyId, id);
  const actualizada: FacturaLeida = { ...fl, ...patch, id: fl.id, companyId, creadaEn: fl.creadaEn, actualizadaEn: ahora() };
  store.set(id, actualizada);
  return actualizada;
}
