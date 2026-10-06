import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from './income-invoices.service';
import { invoiceExtractorService, type InvoiceExtraction } from './invoice-extractor.service';

/**
 * Lector de facturas de INGRESO (pantalla "Lector de ingresos").
 *
 * Digitaliza una factura que emitio la empresa (en papel o desde otro programa)
 * y la registra como factura de ingreso. La lectura la hace invoice-extractor;
 * este modulo adapta su resultado a la pantalla y, al confirmar, crea la
 * factura con los datos GUARDADOS en el servidor (no con lo que reenvie el
 * navegador).
 *
 * En una factura de ingreso el emisor es la empresa y el CLIENTE es el receptor
 * (`customer` de la extraccion).
 */

/** Lo que muestra la pantalla tras leer la factura. */
export interface IngresoExtraido {
  documentId: string;
  numeroFactura: string | null;
  cliente: string | null;
  nifCliente: string | null;
  fecha: string | null;
  concepto: string | null;
  cuentaContable: string;
  base: number;
  iva: number;
  retencion: number;
  total: number;
  /** 0 a 1. */
  confianza: number;
  /** Problemas que impiden confirmar. */
  errores: string[];
}

/** Cuenta de ventas por defecto del PGC (700 Ventas de mercaderias / prestacion de servicios). */
const CUENTA_VENTAS = '700';

const limpiarNif = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const limpio = v.toUpperCase().replace(/^ES/, '').replace(/[.\s-]/g, '');
  return limpio || null;
};

export function aIngresoExtraido(documentId: string, e: InvoiceExtraction): IngresoExtraido {
  const errores = [...e.validation.errors];
  if (!limpiarNif(e.customer.tax_id)) errores.push('Falta el NIF del cliente: es obligatorio en una factura de ingreso.');
  if (!e.invoice.number) errores.push('No se ha podido leer el numero de la factura.');
  if (e.amounts.bases.length === 0) errores.push('No se ha podido leer ninguna base imponible.');
  if (e.amounts.withholdings.length > 1) errores.push('La factura tiene varias retenciones; registrala a mano.');

  return {
    documentId,
    numeroFactura: [e.invoice.series, e.invoice.number].filter(Boolean).join('-') || null,
    cliente: e.customer.name,
    nifCliente: limpiarNif(e.customer.tax_id),
    fecha: e.invoice.issue_date,
    concepto: e.lines.find((l) => l.description)?.description ?? null,
    cuentaContable: CUENTA_VENTAS,
    base: e.amounts.subtotal,
    iva: e.amounts.tax_total,
    retencion: e.amounts.withholding_total,
    total: e.amounts.total_net,
    confianza: e.confidence,
    errores,
  };
}

/**
 * Separa el numero de factura en serie y numero correlativo, que es como se
 * guardan: "A-2025-0042" -> { serie: "A-2025", numero: 42 }. Sin prefijo, la
 * serie es el ano de emision.
 */
export function separarNumero(
  serieLeida: string | null,
  numeroLeido: string | null,
  fecha: string | null,
): { serie: string; numero: number } {
  const texto = [serieLeida, numeroLeido].filter(Boolean).join('-').trim();
  const m = /^(.*?)(\d+)\D*$/.exec(texto);
  if (!m) throw badRequest(`No se puede interpretar el numero de factura "${texto || '(vacio)'}".`);
  const numero = Number.parseInt(m[2], 10);
  if (!Number.isSafeInteger(numero) || numero <= 0) throw badRequest(`Numero de factura no valido: "${texto}".`);
  const prefijo = m[1].replace(/[\s/._-]+$/, '').trim();
  const serie = prefijo || (fecha ? fecha.slice(0, 4) : String(new Date().getFullYear()));
  return { serie, numero };
}

const centimos = (n: number) => Math.round(n * 100) / 100;

/** Lineas de la factura: una por tipo de IVA, con la retencion (si la hay) en todas. */
export function lineasDesdeExtraccion(e: InvoiceExtraction, concepto: string | null): CrearLineaIngresoDTO[] {
  if (e.amounts.withholdings.length > 1) throw badRequest('La factura tiene varias retenciones; registrala a mano.');
  const tipoRetencion = e.amounts.withholdings[0]?.rate ?? 0;
  return e.amounts.bases.map((b) => {
    if (!Number.isInteger(b.tax_rate)) throw badRequest(`Tipo de IVA no valido: ${b.tax_rate}%.`);
    return {
      descripcion: concepto ?? 'Factura digitalizada',
      cantidad: 1,
      precioUnitario: b.base_amount,
      descuentoPorcentaje: 0,
      tipoIva: b.tax_rate,
      tipoRetencion,
    };
  });
}

/**
 * Comprueba ANTES de crear la factura que las lineas reproducen al centimo el
 * total leido. Si no, la factura quedaria registrada con otros importes.
 */
export function comprobarTotales(lineas: CrearLineaIngresoDTO[], e: InvoiceExtraction): void {
  let base = 0;
  let iva = 0;
  let retencion = 0;
  for (const l of lineas) {
    const b = centimos(l.cantidad * l.precioUnitario);
    base += b;
    iva += centimos((b * (l.tipoIva ?? 0)) / 100);
    retencion += centimos((b * (l.tipoRetencion ?? 0)) / 100);
  }
  const total = base + iva - retencion;
  if (aCentimos(total) !== aCentimos(e.amounts.total_net)) {
    throw badRequest(
      `Los importes leidos no cuadran: las bases y tipos dan ${centimos(total).toFixed(2)} EUR y el total de la factura es ` +
        `${e.amounts.total_net.toFixed(2)} EUR. Revisa la factura y registrala a mano.`,
    );
  }
}

export const ingresosExtractorService = {
  /** Lee la factura (PDF o imagen) y la deja pendiente de confirmar. */
  async extraer(
    companyId: string,
    userId: string | undefined,
    archivo: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<IngresoExtraido> {
    const { documentId, extraccion } = await invoiceExtractorService.extraer(companyId, userId, archivo);
    return aIngresoExtraido(documentId, extraccion);
  },

  /** Crea la factura de ingreso a partir de la extraccion guardada. */
  async confirmar(companyId: string, documentId: string): Promise<{ facturaId: string; numeroCompleto: string; total: number }> {
    const doc = await prisma.incomeReaderDocument.findFirst({
      where: { id: documentId, companyId, sourceType: 'EXTRACTOR_IA' },
    });
    if (!doc) throw notFound('Documento no encontrado.');
    if (doc.status !== 'READY_FOR_VERIFICATION') throw badRequest(`El documento esta en estado ${doc.status}; ya no se puede confirmar.`);

    const e = doc.parsedData as unknown as InvoiceExtraction;
    const resumen = aIngresoExtraido(documentId, e);
    if (resumen.errores.length > 0) throw badRequest(`No se puede registrar: ${resumen.errores.join(' ')}`);

    const { serie, numero } = separarNumero(e.invoice.series, e.invoice.number, e.invoice.issue_date);
    const lineas = lineasDesdeExtraccion(e, resumen.concepto);
    comprobarTotales(lineas, e);

    const nif = resumen.nifCliente as string;
    const existente = await prisma.customer.findFirst({ where: { companyId, nifCif: nif } });
    const customer = existente
      ? { id: existente.id }
      : { nuevo: { nombreFiscal: e.customer.name || `Cliente ${nif}`, nifCif: nif, direccion: e.customer.address ?? undefined, pais: 'ES' } };

    const factura = await incomeInvoicesService.crearIngreso({
      companyId,
      customer,
      serie,
      numero,
      fechaEmision: e.invoice.issue_date ?? undefined,
      fechaVencimiento: e.invoice.due_date ?? undefined,
      lineas,
      observaciones: `Digitalizada desde ${doc.originalFileName}`,
    });

    // Archivar el PDF en su carpeta definitiva. No es critico: si falla, la
    // factura ya esta creada y el documento queda enlazado igualmente.
    try {
      await invoiceExtractorService.confirmar(companyId, documentId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('ingresos-extractor: no se pudo archivar el PDF', err);
    }
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: { status: 'VERIFIED', verifiedAt: new Date(), linkedInvoiceId: factura.id },
    });

    return { facturaId: factura.id, numeroCompleto: factura.numeroCompleto, total: factura.totalFactura };
  },
};
