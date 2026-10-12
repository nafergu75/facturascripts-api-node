import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from './income-invoices.service';
import { invoiceExtractorService, type InvoiceExtraction } from './invoice-extractor.service';
import { archivarVentaSinRomper } from './archivoFacturas.service';
import { accountingHooksService } from './accounting-hooks.service';
import { paisDelCliente } from '../domain/tipo-operacion.model';
import { comprobarRevisionVenta, vincularLectura } from './lectura/confirmar';

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
  /**
   * Las lineas con que se registrara (una por tipo de IVA), en el mismo orden
   * que en el confirmar: la pantalla deja elegir la cuenta de cada una.
   */
  lineas: Array<{ descripcion: string; base: number; tipoIva: number }>;
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

  const concepto = e.lines.find((l) => l.description)?.description ?? null;
  return {
    documentId,
    numeroFactura: [e.invoice.series, e.invoice.number].filter(Boolean).join('-') || null,
    cliente: e.customer.name,
    nifCliente: limpiarNif(e.customer.tax_id),
    fecha: e.invoice.issue_date,
    concepto,
    cuentaContable: CUENTA_VENTAS,
    base: e.amounts.subtotal,
    iva: e.amounts.tax_total,
    retencion: e.amounts.withholding_total,
    total: e.amounts.total_net,
    confianza: e.confidence,
    errores,
    lineas: e.amounts.bases.map((b) => ({ descripcion: descripcionLinea(e, b, concepto), base: b.base_amount, tipoIva: b.tax_rate })),
  };
}

/** Texto de relleno de las lineas sin descripcion (aInvoiceExtraction pone «Item 2»...). */
const RELLENO = /^Item \d+$/;

/**
 * Texto de la linea de un tipo de IVA: las partidas de ese tramo (lector con
 * Azure); si no las hay, con varios tipos, la primera linea leida de ese tipo;
 * si no, el concepto de la factura o uno generico. Asi cada linea dice lo que
 * es (antes todas llevaban el concepto de la primera).
 */
function descripcionLinea(e: InvoiceExtraction, b: InvoiceExtraction['amounts']['bases'][number], concepto: string | null): string {
  const propia = b.description?.trim();
  if (propia) return propia;
  if (e.amounts.bases.length > 1) {
    const deSuTipo = e.lines.find((l) => l.tax_rate === b.tax_rate && l.description?.trim() && !RELLENO.test(l.description.trim()));
    if (deSuTipo?.description) return deSuTipo.description.trim();
  }
  return concepto ?? 'Factura digitalizada';
}

/**
 * Cuentas de ingresos elegidas en la pantalla con «Cambiar cuenta»: una por
 * linea, en el mismo orden que `lineas` de IngresoExtraido. De cada linea solo
 * se toma la cuenta; lo demas sale de lo leido y guardado en el servidor. null
 * o vacia = la de por defecto (700). Que sea una cuenta de ventas activa del
 * plan lo comprueba el alta de la factura (400 con campo lineas.N.cuenta).
 */
export function cuentasElegidas(raw: unknown, numLineas: number): Array<string | undefined> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Las cuentas de las líneas no tienen el formato esperado.', { campo: 'lineas' });
  if (raw.length > numLineas) {
    throw badRequest(`Llegan cuentas para ${raw.length} líneas y la factura leída tiene ${numLineas === 1 ? 'una' : numLineas}. Vuelve a leerla.`, { campo: 'lineas' });
  }
  return raw.map((l, i) => {
    const c = l && typeof l === 'object' ? (l as { cuenta?: unknown }).cuenta : undefined;
    if (c === undefined || c === null) return undefined;
    if (typeof c !== 'string' || c.length > 20) throw badRequest(`Línea ${i + 1}: la cuenta de ingresos no es válida.`, { campo: `lineas.${i}.cuenta` });
    return c.replace(/[\s.]/g, '') || undefined;
  });
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
  const serie = prefijo || (fecha ? fecha.slice(0, 4) : hoyEspana().slice(0, 4));
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
      descripcion: descripcionLinea(e, b, concepto),
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

/** Lo que ha pasado con el asiento de una factura registrada desde el lector. */
export interface ContabilidadVentaLeida {
  contabilizada: boolean;
  /** El asiento creado (para el enlace «Ver el asiento»). */
  asientoId?: string;
  /** El asiento esta en borrador: cuenta en el balance cuando se aprueba en el Motor contable. */
  asientoEnBorrador?: boolean;
  /** Por que no se ha creado el asiento (se puede contabilizar despues desde la ficha). */
  motivoSinAsiento?: string | null;
}

/**
 * Asiento de una factura de venta registrada desde un lector, igual que al
 * emitir una en la app (POST /income-invoices). Como viene del lector (el
 * documento ya esta enlazado), queda en borrador hasta aprobarlo en el Motor
 * contable. No es critico: si falla, la factura ya esta registrada y se
 * contabiliza desde su ficha.
 */
export async function contabilizarVentaLeida(companyId: string, facturaId: string): Promise<ContabilidadVentaLeida> {
  try {
    const r = await accountingHooksService.onIncomeInvoiceConfirmed(companyId, facturaId);
    if (!r.contabilizada || !r.journalEntryId) return { contabilizada: false, motivoSinAsiento: r.motivo ?? null };
    const asiento = await prisma.journalEntry.findFirst({ where: { id: r.journalEntryId, companyId }, select: { estado: true } });
    return { contabilizada: true, asientoId: r.journalEntryId, asientoEnBorrador: asiento?.estado !== 'POSTED' };
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`Aviso: no se pudo contabilizar la factura ${facturaId} del lector:`, motivo);
    return { contabilizada: false, motivoSinAsiento: motivo };
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
  async confirmar(
    companyId: string,
    documentId: string,
    opciones: { revisado?: boolean; userId?: string; lineas?: unknown } = {},
  ): Promise<{ facturaId: string; numeroCompleto: string; total: number } & ContabilidadVentaLeida> {
    const doc = await prisma.incomeReaderDocument.findFirst({
      where: { id: documentId, companyId, sourceType: 'EXTRACTOR_IA' },
    });
    if (!doc) throw notFound('Documento no encontrado.');
    if (doc.status !== 'READY_FOR_VERIFICATION') throw badRequest(`El documento esta en estado ${doc.status}; ya no se puede confirmar.`);
    // Leido con /lecturas: si algo estaba marcado, hace falta "He revisado".
    await comprobarRevisionVenta(companyId, documentId, opciones.revisado === true);

    const e = doc.parsedData as unknown as InvoiceExtraction;
    const resumen = aIngresoExtraido(documentId, e);
    if (resumen.errores.length > 0) throw badRequest(`No se puede registrar: ${resumen.errores.join(' ')}`);

    const { serie, numero } = separarNumero(e.invoice.series, e.invoice.number, e.invoice.issue_date);
    // La cuenta de cada linea, si se cambio en la pantalla (no cambia importes).
    const cuentas = cuentasElegidas(opciones.lineas, e.amounts.bases.length);
    const lineas = lineasDesdeExtraccion(e, resumen.concepto).map((l, i) => (cuentas[i] ? { ...l, cuenta: cuentas[i] } : l));
    comprobarTotales(lineas, e);

    const nif = resumen.nifCliente as string;
    const existente = await prisma.customer.findFirst({ where: { companyId, nifCif: nif } });
    const customer = existente
      ? { id: existente.id }
      : {
          nuevo: {
            nombreFiscal: e.customer.name || `Cliente ${nif}`,
            nifCif: nif,
            direccion: e.customer.address ?? undefined,
            // ES salvo que el NIF lleve el prefijo de otro Estado de la UE (FR..., DE...; EL = Grecia).
            pais: paisDelCliente({ pais: 'ES', nifCif: nif }),
          },
        };

    // Origen lector: la fiscalidad avisa en vez de rechazar (y en una empresa no
    // espanola quita el IVA que el OCR pone por defecto).
    const factura = await incomeInvoicesService.crearIngreso(
      {
        companyId,
        customer,
        serie,
        numero,
        fechaEmision: e.invoice.issue_date ?? undefined,
        fechaVencimiento: e.invoice.due_date ?? undefined,
        lineas,
        observaciones: `Digitalizada desde ${doc.originalFileName}`,
      },
      // El numero se guarda tal como se leyo (con sus ceros y su separador), el que ve la pantalla.
      { origen: 'lector', numeroLeido: resumen.numeroFactura },
    );

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

    // Archivo por trimestres: el PDF original queda en su carpeta (no bloqueante).
    await archivarVentaSinRomper(companyId, factura.id);
    await vincularLectura(companyId, { incomeReaderDocumentId: documentId }, { incomeInvoiceId: factura.id, userId: opciones.userId, revisada: opciones.revisado === true });

    // Despues de enlazar el documento: asi el asiento sale en borrador, como el de las compras leidas.
    const contable = await contabilizarVentaLeida(companyId, factura.id);

    return { facturaId: factura.id, numeroCompleto: factura.numeroCompleto ?? '', total: factura.totalFactura, ...contable };
  },
};
