/**
 * Adaptadores de salida: de la lectura normalizada y validada a las formas de
 * hoy, para que las pantallas y los "confirmar" actuales sigan funcionando.
 *
 *  - aGastoExtraido: el GastoExtraido del lector de gastos.
 *  - aInvoiceExtraction: el InvoiceExtraction que guarda IncomeReaderDocument
 *    y que usa /ingresos-extractor/confirmar (validation.errors bloquea).
 */
import { tipoGastoDeCuenta } from '../../domain/factura-gasto.model';
import { redondear2 } from '../../utils/money';
import { AVISO_NO_FACTURA, sugerirCuentaParaGasto, type GastoExtraido, type TipoDocumentoGasto } from '../gastos-extractor.service';
import type { InvoiceExtraction } from '../invoice-extractor.service';
import type { LecturaNormalizada, ResultadoValidacion } from './tipos';

const sumar = (xs: Array<number | null | undefined>) => redondear2(xs.reduce<number>((s, x) => s + (x ?? 0), 0));

/** Tipo de IVA de la mayor base (como la cabecera de las facturas de gasto). */
function tipoPrincipal(l: LecturaNormalizada): number | null {
  if (!l.desglose.length) return null;
  return [...l.desglose].sort((a, b) => (b.base.valor ?? 0) - (a.base.valor ?? 0))[0].tipoIva;
}

export function aGastoExtraido(l: LecturaNormalizada, validaciones: ResultadoValidacion[], confianza: number | null): GastoExtraido {
  const tipoLeido = l.tipoDocumento.valor;
  const tipoDocumento: TipoDocumentoGasto = tipoLeido === 'nomina' || tipoLeido === 'seguros_sociales' ? tipoLeido : 'factura';
  const cuenta = tipoDocumento === 'factura' ? sugerirCuentaParaGasto(l.concepto.valor) : null;
  let errores = validaciones.filter((v) => v.nivel !== 'ok').map((v) => v.mensaje);
  // Como hoy: el aviso de "no es una factura" va el primero.
  if (tipoDocumento !== 'factura') {
    const aviso = AVISO_NO_FACTURA[tipoDocumento];
    errores = [aviso, ...errores.filter((e) => e !== aviso)];
  }
  const retencion = l.retencion?.importe.valor ?? l.totales.retencion.valor ?? 0;
  return {
    numeroFactura: l.numero.valor,
    proveedor: l.emisor.nombre.valor,
    nifProveedor: l.emisor.nif.valor,
    fecha: l.fechaEmision.valor,
    conceptoGasto: l.concepto.valor,
    base: l.desglose.length ? sumar(l.desglose.map((t) => t.base.valor)) : (l.totales.base.valor ?? 0),
    iva: l.desglose.length ? sumar(l.desglose.map((t) => t.cuota.valor)) : (l.totales.cuotaIva.valor ?? 0),
    total: l.totales.totalAPagar.valor ?? 0,
    tipoIva: tipoPrincipal(l),
    tipoRetencion: retencion ? (l.retencion?.tipo.valor ?? null) : null,
    retencion: redondear2(retencion),
    moneda: l.moneda.valor,
    cuentaContableBase: cuenta?.codigo ?? null,
    cuentaContableNombre: cuenta?.nombre ?? null,
    tipoGastoSugerido: tipoGastoDeCuenta(cuenta?.codigo),
    confianza: confianza ?? 0,
    errores: [...new Set(errores)],
    tipoDocumento,
  };
}

export interface TramoGasto {
  tipoIva: number;
  base: number;
  cuota: number;
  /** Texto de la linea del formulario: las partidas de ese tipo ("Tóner", "Libros y revistas") o uno neutro ("Base al 10 %", "Base exenta"). */
  descripcion: string;
}

/** Largo maximo de la descripcion de un tramo (la linea admite 500). */
const MAX_DESCRIPCION_TRAMO = 150;

/** 21 -> "21 %", 5.2 -> "5,2 %". */
const porcentaje = (n: number) => `${String(Math.round(n * 100) / 100).replace('.', ',')} %`;

/** Texto neutro de un tramo sin partidas: "Base al 10 %"; al 0 %, "Base exenta" (no "Base al 0 %"). */
export function descripcionNeutraTramo(tipoIva: number): string {
  return tipoIva === 0 ? 'Base exenta' : `Base al ${porcentaje(tipoIva)}`;
}

/** "Revistas" -> "revistas" para ir detras de "y"; "PVC" o "A3" se quedan como estan. */
const enMinuscula = (t: string) => (/^\p{Lu}\p{Ll}/u.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** "Libros", "Libros y revistas", "Folletos, carteles y sobres" o "Folletos, carteles y 3 partidas más". */
function unirPartidas(partidas: string[]): string {
  if (partidas.length === 1) return partidas[0];
  const [primera, ...resto] = partidas;
  const siguientes = resto.map(enMinuscula);
  const lista = partidas.length > 3 ? [primera, siguientes[0], `${partidas.length - 2} partidas más`] : [primera, ...siguientes];
  return `${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
}

/** Descripcion de un tramo con las partidas de su tipo de IVA (todas, si solo hay un tipo). */
function descripcionTramo(l: LecturaNormalizada, tipoIva: number): string {
  const unSoloTipo = l.desglose.length === 1;
  const vistas = new Set<string>();
  const partidas: string[] = [];
  for (const linea of l.lineas) {
    const d = linea.descripcion?.replace(/\s+/g, ' ').trim();
    if (!d) continue;
    if (!unSoloTipo && (linea.tipoIva === null || Math.round(linea.tipoIva * 100) !== Math.round(tipoIva * 100))) continue;
    const clave = d.toLowerCase();
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    partidas.push(d);
  }
  if (!partidas.length) return descripcionNeutraTramo(tipoIva);
  const texto = unirPartidas(partidas);
  return texto.length > MAX_DESCRIPCION_TRAMO ? `${texto.slice(0, MAX_DESCRIPCION_TRAMO - 1).trimEnd()}…` : texto;
}

/** Un tramo por tipo de IVA, para que el formulario ponga una linea por tipo en vez de juntarlos. */
export function tramosGasto(l: LecturaNormalizada): TramoGasto[] {
  return l.desglose
    .filter((t) => t.base.valor !== null)
    .map((t) => ({ tipoIva: t.tipoIva, base: redondear2(t.base.valor ?? 0), cuota: redondear2(t.cuota.valor ?? 0), descripcion: descripcionTramo(l, t.tipoIva) }));
}

export function aInvoiceExtraction(
  l: LecturaNormalizada,
  validaciones: ResultadoValidacion[],
  opciones: { confianza: number | null; nombreArchivo: string | null; mime: string | null },
): InvoiceExtraction {
  const bases = l.desglose.map((t) => ({ tax_rate: t.tipoIva, base_amount: redondear2(t.base.valor ?? 0), tax_amount: redondear2(t.cuota.valor ?? 0) }));
  const ret = l.retencion?.importe.valor ?? 0;
  const withholdings = ret ? [{ type: 'IRPF', rate: l.retencion?.tipo.valor ?? 0, amount: redondear2(ret) }] : [];
  const subtotal = sumar(bases.map((b) => b.base_amount));
  const tax_total = sumar(bases.map((b) => b.tax_amount));
  const recargo = sumar(l.desglose.map((t) => t.cuotaRecargo?.valor));
  const total_gross = redondear2(subtotal + tax_total + recargo);
  const tipo = l.tipoDocumento.valor;
  const errores = validaciones.filter((v) => v.nivel === 'error');

  return {
    document_type: tipo === 'rectificativa' ? 'credit_note' : tipo === 'simplificada' || tipo === 'ticket' ? 'ticket' : 'invoice',
    direction: 'income',
    confidence: opciones.confianza ?? 0,
    vendor: { name: l.emisor.nombre.valor, tax_id: l.emisor.nif.valor, address: l.emisor.direccion.valor?.calle ?? null, country: 'ES' },
    customer: { name: l.receptor.nombre.valor, tax_id: l.receptor.nif.valor, address: null, country: 'ES' },
    invoice: {
      number: l.numero.valor,
      series: null,
      issue_date: l.fechaEmision.valor,
      due_date: l.fechaVencimiento.valor,
      original_number: l.rectificativa?.numeroRectificada.valor ?? null,
    },
    amounts: {
      currency: 'EUR',
      bases,
      withholdings,
      subtotal,
      tax_total,
      withholding_total: redondear2(ret),
      total_gross,
      total_net: l.totales.totalAPagar.valor ?? redondear2(total_gross - ret),
    },
    payment: { method: null, terms: null, iban: l.iban.valor },
    lines: l.desglose.map((t, i) => ({
      description: i === 0 ? l.concepto.valor : `Item ${i + 1}`,
      quantity: 1,
      unit_price: redondear2(t.base.valor ?? 0),
      line_total: redondear2(t.base.valor ?? 0),
      tax_rate: t.tipoIva,
    })),
    raw_text: null,
    meta: { source_file_name: opciones.nombreArchivo, source_mime_type: opciones.mime, pages: l.paginas.leidas ?? 1 },
    validation: {
      checks: {
        total_matches_bases_and_taxes: !errores.some((v) => v.codigo === 'CUADRE'),
        tax_id_vendor_valid: !errores.some((v) => v.codigo === 'NIF_EMISOR'),
        tax_id_customer_valid: !errores.some((v) => v.codigo === 'NIF_RECEPTOR'),
        withholding_consistent: !validaciones.some((v) => v.codigo === 'IRPF'),
      },
      // Solo los de nivel error: /ingresos-extractor/confirmar bloquea con ellos, como hoy.
      errors: [...new Set(errores.map((v) => v.mensaje))],
    },
  };
}
