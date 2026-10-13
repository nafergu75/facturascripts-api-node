/**
 * De prebuilt-invoice (Azure DI 2024-11-30) a LecturaNormalizada.
 *
 * Campo a campo, con su confianza (0-1) y su pagina. No se guarda nada bruto:
 * ni polygon, ni spans, ni words, ni el content (que solo se devuelve en
 * memoria para el complemento con Claude).
 *
 * Azure no da la base de cada tipo de IVA ni la retencion de IRPF: la base se
 * saca de las lineas o de la cuota, y la retencion se propone si el total a
 * pagar es el total menos un porcentaje habitual de la base. Un tipo de
 * recargo de equivalencia dentro de TaxDetails se empareja con su IVA.
 */
import { prefijoNifIvaUe, limpiarNif } from '../../domain/tipo-operacion.model';
import { aCentimos, redondear2 } from '../../utils/money';
import { normalizarNif } from '../../utils/nif';
import { isValidIban } from '../../utils/validateIban';
import type { AnalyzeResult, DocumentField } from './azure-di.client';
import { leerQrDeCodigos } from './verifactu-qr';
import { lecturaVacia, UMBRAL_OK, type Campo, type DireccionLeida, type Lector, type LecturaHecha, type LecturaNormalizada, type LineaLeida, type TramoLeido } from './tipos';

export { UMBRAL_OK, UMBRAL_BAJO } from './tipos';

export const TIPOS_IVA = [0, 4, 5, 10, 21];
/** Recargo de equivalencia y el IVA con el que va (1,75 tabaco y 0,26 sin pareja fija). */
export const PAREJA_RECARGO: Record<string, number | null> = { '5.2': 21, '1.4': 10, '0.5': 4, '0.62': 5, '1.75': null, '0.26': null };
export const TIPOS_RETENCION = [1, 2, 7, 15, 19];

export const MOTIVO_BASE_DUDOSA = 'No se ha podido saber la base de este tipo con seguridad: compruébala.';
export const MOTIVO_BASE_CALCULADA = 'Base calculada a partir de la cuota: compruébala.';
/** Base exenta de una factura con otros tipos: lo que queda del subtotal tras las demas bases. */
export const MOTIVO_BASE_EXENTA_RESTO = 'Base exenta calculada restando las demás bases al subtotal: compruébala.';
export const MOTIVO_RETENCION_CALCULADA = 'Retención calculada a partir del total a pagar: compruébala.';
export const AVISO_VARIAS_FACTURAS = 'El archivo parece tener varias facturas; solo se ha leído la primera.';
export const MOTIVO_A_PAGAR_SIN_TOTAL = 'No se ha leído el total a pagar: se ha calculado restando la retención al total de la factura. Compruébalo.';
/** Sin ningun total impreso ni QR que lo confirme: el total sale de sumar lo leido, asi que siempre cuadra y no prueba nada. */
export const MOTIVO_TOTAL_SUMADO = 'No se ha leído el total de la factura: se ha calculado sumando las bases y el IVA. Compruébalo con el documento.';
export const MOTIVO_TOTAL_SUMADO_CON_RETENCION =
  'No se ha leído el total de la factura: se ha calculado sumando las bases y el IVA y restando la retención. Compruébalo con el documento.';
export const MOTIVO_A_PAGAR_DEL_TOTAL = 'No se ha leído el total a pagar: se ha tomado el total de la factura. Compruébalo con el documento.';
/** Lo mismo en el lector de ventas, donde ese dato se llama «Total a cobrar». */
export const MOTIVO_A_COBRAR_SIN_TOTAL = 'No se ha leído el total a cobrar: se ha calculado restando la retención al total de la factura. Compruébalo.';
export const MOTIVO_A_COBRAR_DEL_TOTAL = 'No se ha leído el total a cobrar: se ha tomado el total de la factura. Compruébalo con el documento.';

// ---------------------------------------------------------------------------
// Lectura de un DocumentField
// ---------------------------------------------------------------------------

function campo<T>(f: DocumentField | undefined, valor: T | null): Campo<T> {
  const c: Campo<T> = { valor, confianza: typeof f?.confidence === 'number' ? f.confidence : null, fuente: 'azure' };
  const pagina = f?.boundingRegions?.[0]?.pageNumber;
  if (valor !== null && typeof pagina === 'number') c.pagina = pagina;
  return c;
}

const texto = (f: DocumentField | undefined): string | null => {
  const s = (f?.valueString ?? f?.content ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
};
const fecha = (f: DocumentField | undefined): string | null => (f?.valueDate && /^\d{4}-\d{2}-\d{2}$/.test(f.valueDate) ? f.valueDate : null);
const importe = (f: DocumentField | undefined): number | null => {
  const n = f?.valueCurrency?.amount ?? f?.valueNumber;
  return typeof n === 'number' && Number.isFinite(n) ? redondear2(n) : null;
};
const numero = (f: DocumentField | undefined): number | null => {
  const n = f?.valueNumber ?? f?.valueInteger;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** NIF: un NIF-IVA de otro pais de la UE se deja con su prefijo; el resto, normalizado. */
export function nifLeido(v: string | null): string | null {
  if (!v) return null;
  const ue = prefijoNifIvaUe(v);
  const r = ue && ue.pais !== 'ES' ? limpiarNif(v) : normalizarNif(v);
  return r || null;
}

/** "21%", "21 %", "21,00 %", "IVA 10%" o "21" -> 21. */
export function leerTipo(v: string | null): number | null {
  if (!v) return null;
  const m = /(\d{1,2}(?:[.,]\d{1,2})?)\s*%/.exec(v) ?? /^\s*(\d{1,2}(?:[.,]\d{1,2})?)\s*$/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : null;
}

const esRecargo = (tipo: number) => String(tipo) in PAREJA_RECARGO && !TIPOS_IVA.includes(tipo);

function minConfianza(...fs: Array<DocumentField | undefined>): number | null {
  const cs = fs.map((f) => f?.confidence).filter((c): c is number => typeof c === 'number');
  return cs.length ? Math.min(...cs) : null;
}

function direccion(f: DocumentField | undefined): Campo<DireccionLeida> {
  const a = f?.valueAddress;
  if (!a) return campo<DireccionLeida>(f, null);
  const calle = a.streetAddress ?? [a.road, a.houseNumber].filter(Boolean).join(' ');
  const d: DireccionLeida = {};
  if (calle) d.calle = calle;
  if (a.postalCode) d.cp = a.postalCode;
  if (a.city) d.municipio = a.city;
  if (a.state) d.provincia = a.state;
  if (a.countryRegion) d.pais = a.countryRegion;
  return campo(f, Object.keys(d).length ? d : null);
}

// ---------------------------------------------------------------------------
// Desglose por tipo
// ---------------------------------------------------------------------------

interface DetalleImpuesto {
  tipo: number;
  cuota: Campo<number>;
  neto: Campo<number> | null;
}

/** Tramos de IVA a partir de TaxDetails, Items y SubTotal (seccion 6 de la especificacion). */
function construirDesglose(f: Record<string, DocumentField>, lineas: LineaLeida[]): TramoLeido[] {
  const detalles: DetalleImpuesto[] = [];
  for (const d of f.TaxDetails?.valueArray ?? []) {
    const o = d.valueObject ?? {};
    const tipo = leerTipo(texto(o.Rate));
    const cuota = importe(o.Amount);
    if (tipo === null || cuota === null) continue;
    const neto = importe(o.NetAmount);
    detalles.push({ tipo, cuota: campo(o.Amount, cuota), neto: neto !== null ? campo(o.NetAmount, neto) : null });
  }

  const subTotal = importe(f.SubTotal);
  const tramos: TramoLeido[] = [];

  if (detalles.length === 0) {
    // Sin TaxDetails: un solo tramo con el tipo valido mas cercano a TotalTax / SubTotal.
    const totalTax = importe(f.TotalTax);
    if (subTotal === null || totalTax === null) return [];
    const aprox = subTotal ? (totalTax / subTotal) * 100 : 0;
    const tipo = TIPOS_IVA.reduce((a, b) => (Math.abs(b - aprox) < Math.abs(a - aprox) ? b : a), 21);
    return [
      {
        tipoIva: subTotal && totalTax ? tipo : 0,
        base: { ...campo(f.SubTotal, subTotal), fuente: 'calculado', motivo: MOTIVO_BASE_CALCULADA },
        cuota: { ...campo(f.TotalTax, totalTax), fuente: 'calculado', motivo: MOTIVO_BASE_CALCULADA },
        tipoRecargo: null,
        cuotaRecargo: null,
      },
    ];
  }

  const ivas = detalles.filter((d) => !esRecargo(d.tipo));
  const recargos = detalles.filter((d) => esRecargo(d.tipo));

  // 1) Bases: de NetAmount, de las lineas con ese tipo o de la cuota.
  for (const d of ivas) {
    const tramo: TramoLeido = { tipoIva: d.tipo, base: { valor: null, confianza: null, fuente: 'calculado' }, cuota: d.cuota, tipoRecargo: null, cuotaRecargo: null };
    const cuota = d.cuota.valor ?? 0;
    const delTipo = lineas.filter((l) => l.tipoIva === d.tipo && l.importe !== null);
    const sumaLineas = redondear2(delTipo.reduce((s, l) => s + (l.importe ?? 0), 0));
    const tolerancia = Math.max(delTipo.length, 1);
    if (d.neto) {
      tramo.base = d.neto;
    } else if (delTipo.length && Math.abs(aCentimos((sumaLineas * d.tipo) / 100) - aCentimos(cuota)) <= tolerancia) {
      const confs = delTipo.map((l) => l.confianza).filter((c): c is number => c !== null);
      tramo.base = { valor: sumaLineas, confianza: confs.length ? Math.min(...confs) : null, fuente: 'azure' };
    } else if (d.tipo > 0) {
      const base = redondear2((cuota * 100) / d.tipo);
      tramo.base = { valor: base, confianza: null, fuente: 'calculado', motivo: MOTIVO_BASE_CALCULADA };
    }
    tramos.push(tramo);
  }

  // 2) Con un solo tramo con IVA, la base es el SubTotal si cuadra con la cuota.
  const conIva = tramos.filter((t) => t.tipoIva > 0);
  if (tramos.length === 1 && conIva.length === 1 && subTotal !== null && tramos[0].base.fuente === 'calculado') {
    const t = tramos[0];
    if (Math.abs(aCentimos((subTotal * t.tipoIva) / 100) - aCentimos(t.cuota.valor ?? 0)) <= 1) t.base = campo(f.SubTotal, subTotal);
  }

  // 3) Varias bases calculadas: tienen que sumar el SubTotal. Si no, son dudosas.
  const calculadas = tramos.filter((t) => t.base.fuente === 'calculado' && t.tipoIva > 0);
  if (calculadas.length) {
    // Con un tramo al 0 % su base sale de restar las demas al SubTotal: las calculadas no se pueden contrastar.
    const hayCero = tramos.some((t) => t.tipoIva === 0);
    const suma = tramos.reduce((s, t) => s + (t.base.valor ?? 0), 0);
    if (hayCero || subTotal === null || aCentimos(suma) !== aCentimos(subTotal)) {
      for (const t of calculadas) t.base.motivo = MOTIVO_BASE_DUDOSA;
    }
  }

  // 4) Tipo 0 %: la base es lo que falta hasta el SubTotal. Si es el unico tramo,
  //    es el propio SubTotal leido (con su confianza, sin motivo); con otros tramos,
  //    sale de restarlos y lo dice (no se calcula «a partir de la cuota»: no lleva).
  for (const t of tramos.filter((x) => x.tipoIva === 0 && x.base.valor === null)) {
    const demas = tramos.filter((x) => x !== t);
    if (!demas.length && subTotal !== null && subTotal > 0) {
      t.base = campo(f.SubTotal, subTotal);
      continue;
    }
    const otras = demas.reduce((s, x) => s + (x.base.valor ?? 0), 0);
    const resto = subTotal !== null ? redondear2(subTotal - otras) : null;
    t.base = resto !== null && resto > 0 ? { valor: resto, confianza: null, fuente: 'calculado', motivo: MOTIVO_BASE_EXENTA_RESTO } : { valor: null, confianza: null, fuente: 'calculado', motivo: MOTIVO_BASE_DUDOSA };
  }

  // 5) Recargo de equivalencia: con su IVA.
  for (const r of recargos) {
    const pareja = PAREJA_RECARGO[String(r.tipo)];
    const tramo = (pareja !== null ? tramos.find((t) => t.tipoIva === pareja) : undefined) ?? (tramos.length === 1 ? tramos[0] : tramos.find((t) => t.tipoIva === 21));
    if (!tramo) continue;
    tramo.tipoRecargo = r.tipo;
    tramo.cuotaRecargo = pareja === null || pareja !== tramo.tipoIva ? { ...r.cuota, motivo: 'El recargo no tiene un IVA claro con el que ir: compruébalo.' } : r.cuota;
  }

  return tramos;
}

// ---------------------------------------------------------------------------
// Mapeo completo
// ---------------------------------------------------------------------------

/** Paginas de un PDF, contadas en local de forma aproximada. null si no es un PDF. */
export function contarPaginasPdf(buffer: Buffer): number | null {
  if (buffer.subarray(0, 4).toString('latin1') !== '%PDF') return null;
  const n = buffer.toString('latin1').match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
  return n || null;
}

export type ResultadoMapeo = LecturaHecha | { tipo: 'fallo'; codigo: 'AZURE_SIN_FACTURA'; reintentable: false };

export function mapearFacturaAzure(ar: AnalyzeResult, opciones: { paginasArchivo?: number | null } = {}): ResultadoMapeo {
  const documento = ar.documents?.[0];
  if (!documento?.fields || Object.keys(documento.fields).length === 0) return { tipo: 'fallo', codigo: 'AZURE_SIN_FACTURA', reintentable: false };
  const f = documento.fields;
  const l: LecturaNormalizada = lecturaVacia('azure');

  l.emisor.nombre = campo(f.VendorName ?? f.VendorAddressRecipient, texto(f.VendorName ?? f.VendorAddressRecipient));
  l.emisor.nif = campo(f.VendorTaxId, nifLeido(texto(f.VendorTaxId)));
  l.emisor.direccion = direccion(f.VendorAddress);
  l.receptor.nombre = campo(f.CustomerName ?? f.CustomerAddressRecipient, texto(f.CustomerName ?? f.CustomerAddressRecipient));
  l.receptor.nif = campo(f.CustomerTaxId, nifLeido(texto(f.CustomerTaxId)));
  // La del cliente; si no la hay, la de facturacion (BillingAddress).
  l.receptor.direccion = direccion([f.CustomerAddress, f.BillingAddress].find((x) => x?.valueAddress) ?? f.CustomerAddress);
  l.numero = campo(f.InvoiceId, texto(f.InvoiceId));
  l.fechaEmision = campo(f.InvoiceDate, fecha(f.InvoiceDate));
  l.fechaVencimiento = campo(f.DueDate, fecha(f.DueDate));

  // Moneda: el codigo de los totales; si no, el simbolo.
  const conMoneda = [f.InvoiceTotal, f.SubTotal, f.AmountDue].find((x) => x?.valueCurrency?.currencyCode);
  if (conMoneda) {
    l.moneda = campo(conMoneda, String(conMoneda.valueCurrency?.currencyCode).toUpperCase());
  } else {
    const simbolo = [f.InvoiceTotal, f.SubTotal, f.AmountDue].map((x) => x?.valueCurrency?.currencySymbol).find(Boolean);
    const moneda = simbolo === '$' ? 'USD' : 'EUR';
    l.moneda = { valor: moneda, confianza: null, fuente: 'calculado', motivo: simbolo === '€' ? undefined : 'No se ve bien la moneda: compruébala.' };
    if (!l.moneda.motivo) delete l.moneda.motivo;
  }

  // Lineas.
  l.lineas = (f.Items?.valueArray ?? []).map((it) => {
    const o = it.valueObject ?? {};
    return {
      descripcion: texto(o.Description),
      cantidad: numero(o.Quantity),
      precioUnitario: importe(o.UnitPrice),
      importe: importe(o.Amount),
      tipoIva: leerTipo(texto(o.TaxRate)),
      confianza: minConfianza(o.Description, o.Quantity, o.UnitPrice, o.Amount, o.TaxRate),
    };
  });
  const primeraConDescripcion = (f.Items?.valueArray ?? []).find((it) => texto(it.valueObject?.Description));
  l.concepto = campo(primeraConDescripcion?.valueObject?.Description, texto(primeraConDescripcion?.valueObject?.Description));

  // Desglose y totales.
  l.desglose = construirDesglose(f, l.lineas);
  const subTotal = importe(f.SubTotal);
  const totalTax = importe(f.TotalTax);
  const invoiceTotal = importe(f.InvoiceTotal);
  const amountDue = importe(f.AmountDue);
  const recargo = redondear2(l.desglose.reduce((s, t) => s + (t.cuotaRecargo?.valor ?? 0), 0));
  const sumaBases = redondear2(l.desglose.reduce((s, t) => s + (t.base.valor ?? 0), 0));
  const sumaIva = redondear2(l.desglose.reduce((s, t) => s + (t.cuota.valor ?? 0), 0));

  l.totales.base = subTotal !== null ? campo(f.SubTotal, subTotal) : { valor: l.desglose.length ? sumaBases : null, confianza: null, fuente: 'calculado' };
  l.totales.cuotaIva =
    totalTax !== null ? { ...campo(f.TotalTax, redondear2(totalTax - recargo)), ...(recargo ? { fuente: 'calculado' as const } : {}) } : { valor: l.desglose.length ? sumaIva : null, confianza: null, fuente: 'calculado' };
  l.totales.cuotaRecargo = { valor: recargo, confianza: null, fuente: 'calculado' };
  l.totales.totalFactura =
    invoiceTotal !== null ? campo(f.InvoiceTotal, invoiceTotal) : { valor: l.desglose.length ? redondear2(sumaBases + sumaIva + recargo) : null, confianza: null, fuente: 'calculado' };
  l.totales.totalAPagar = amountDue !== null ? campo(f.AmountDue, amountDue) : { ...campo(f.InvoiceTotal, invoiceTotal), fuente: 'calculado' };

  // Retencion: Azure no la da. Se propone si la diferencia es un % habitual de la base.
  if (amountDue !== null && invoiceTotal !== null && subTotal !== null && amountDue < invoiceTotal) {
    const diferencia = redondear2(invoiceTotal - amountDue);
    const tipo = TIPOS_RETENCION.find((p) => aCentimos((subTotal * p) / 100) === aCentimos(diferencia));
    if (tipo !== undefined) {
      l.retencion = {
        tipo: { valor: tipo, confianza: null, fuente: 'calculado', motivo: MOTIVO_RETENCION_CALCULADA },
        importe: { valor: diferencia, confianza: null, fuente: 'calculado', motivo: MOTIVO_RETENCION_CALCULADA },
      };
      l.totales.retencion = { valor: diferencia, confianza: null, fuente: 'calculado', motivo: MOTIVO_RETENCION_CALCULADA };
    }
  }

  // Senales informativas (V22).
  const descuento = importe(f.TotalDiscount);
  const saldo = importe(f.PreviousUnpaidBalance);
  l.senales = {};
  if (descuento && descuento > 0) l.senales.descuento = descuento;
  if (saldo && saldo > 0) l.senales.saldoAnterior = saldo;

  // Tipo de documento: sin cliente, simplificada (lo demas lo decide Claude).
  if (!texto(f.CustomerTaxId) && !texto(f.CustomerName)) {
    l.tipoDocumento = { valor: 'simplificada', confianza: null, fuente: 'calculado', motivo: 'No aparece el cliente: parece una factura simplificada.' };
  }

  // IBAN, sin espacios y comprobado.
  const pago = f.PaymentDetails?.valueArray?.[0]?.valueObject;
  const ibanTexto = texto(pago?.IBAN)?.replace(/\s+/g, '').toUpperCase() ?? null;
  l.iban = campo(pago?.IBAN, ibanTexto);
  if (ibanTexto && !isValidIban(ibanTexto)) l.iban.motivo = 'El IBAN leído no es válido: compruébalo.';

  // Varias facturas en el archivo: solo la primera, y lo principal a revisar.
  if ((ar.documents?.length ?? 0) > 1) {
    l.avisos.push(AVISO_VARIAS_FACTURAS);
    l.senales.variasFacturas = true;
    for (const c of [l.emisor.nif, l.numero, l.fechaEmision, l.totales.totalFactura, l.totales.totalAPagar]) c.motivo = AVISO_VARIAS_FACTURAS;
  }

  l.paginas = { archivo: opciones.paginasArchivo ?? null, leidas: ar.pages?.length ?? null };

  return {
    tipo: 'hecho',
    lectura: l,
    texto: ar.content ?? null,
    qr: leerQrDeCodigos((ar.pages ?? []).flatMap((p) => p.barcodes ?? [])),
  };
}

/** true si el QR VERI*FACTU confirma el total de la factura (se ha cotejado con el importe del QR). */
export const totalConfirmadoPorQr = (l: LecturaNormalizada): boolean => l.totales.totalFactura.fuente === 'qr' && l.totales.totalFactura.confianza === 1;

/**
 * Sin total a pagar leido (ni InvoiceTotal ni AmountDue, y la IA tampoco lo da),
 * se toma el total de la factura (menos la retencion, si la lleva). Se llama al
 * final, cuando ya se sabe si hay retencion.
 *
 * Solo queda sin revisar si el QR confirma ese total y no hay retencion. Si no,
 * va a "revisar" con su motivo: un total sumado con las bases leidas siempre
 * cuadra con ellas (V01), asi que no se ha cotejado con nada del documento. Si
 * ya traia un motivo (p. ej. que no se pudo completar con la IA), lo conserva.
 */
export function completarTotalAPagar(l: LecturaNormalizada, lector: Lector = 'GASTO'): void {
  const total = l.totales.totalFactura.valor;
  if (l.totales.totalAPagar.valor !== null || total === null) return;
  const retencion = Math.max(l.retencion?.importe.valor ?? l.totales.retencion.valor ?? 0, 0);
  const sumado = l.totales.totalFactura.fuente === 'calculado';
  // En ventas el dato se llama «Total a cobrar»: el motivo habla de el con ese nombre.
  const sinTotal = lector === 'VENTA' ? MOTIVO_A_COBRAR_SIN_TOTAL : MOTIVO_A_PAGAR_SIN_TOTAL;
  const delTotal = lector === 'VENTA' ? MOTIVO_A_COBRAR_DEL_TOTAL : MOTIVO_A_PAGAR_DEL_TOTAL;
  let propio: string | undefined;
  if (totalConfirmadoPorQr(l)) propio = retencion > 0 ? sinTotal : undefined;
  else if (sumado) propio = retencion > 0 ? MOTIVO_TOTAL_SUMADO_CON_RETENCION : MOTIVO_TOTAL_SUMADO;
  else propio = retencion > 0 ? sinTotal : delTotal;
  const motivo = l.totales.totalAPagar.motivo ?? propio;
  l.totales.totalAPagar = { valor: redondear2(total - retencion), confianza: null, fuente: 'calculado', ...(motivo ? { motivo } : {}) };
}

/**
 * Confianza de la lectura (0-1): la minima de los datos clave. Un dato que
 * falta cuenta como 0; uno confirmado por el QR, como 1. null si ninguno la da
 * (lectura de Claude).
 */
export function confianzaLectura(l: LecturaNormalizada, lector: Lector): number | null {
  const clave = [lector === 'VENTA' ? l.receptor.nif : l.emisor.nif, l.numero, l.fechaEmision, l.totales.totalAPagar];
  const valores: number[] = [];
  for (const c of clave) {
    if (c.fuente === 'qr' && c.confianza === 1) valores.push(1);
    else if (c.valor === null && c.fuente === 'azure') valores.push(0);
    else if (typeof c.confianza === 'number') valores.push(c.confianza);
  }
  return valores.length ? Math.min(...valores) : null;
}

/** true si el dato clave se ha leido con poca seguridad (y el QR no lo confirma). */
export const confianzaBaja = (c: Campo<unknown>): boolean => !(c.fuente === 'qr' && c.confianza === 1) && (c.valor === null || (typeof c.confianza === 'number' && c.confianza < UMBRAL_OK));
