/**
 * Importes de una factura de venta en su moneda (documento) y en la moneda de
 * cuenta de la empresa. Puro: sin BD.
 *
 * 1. Lado DOCUMENTO: el calculo de siempre (redondeo al centimo por linea; la
 *    cabecera es la suma de las lineas y total = base + IVA - retencion).
 * 2. Lado CUENTA:
 *    - misma moneda (tipo 1): copia literal del documento, sin dividir ni
 *      redondear nada (EUR -> EUR igual bit a bit);
 *    - otra moneda: `convertirLineas` convierte la BASE de cada tipo de IVA y
 *      calcula la cuota sobre la base ya convertida (art. 79.Once LIVA), y
 *      reparte los centimos entre las lineas. Nunca se divide el total.
 */
import { redondear2, redondear4 } from '../utils/money';

export interface LineaEntrada {
  descripcion: string;
  cantidad: number;
  /** En la moneda del documento. */
  precioUnitario: number;
  descuentoPorcentaje?: number;
  tipoIva?: number;
  tipoRetencion?: number;
  productoServicioId?: string;
}

/** Importes de una linea en una moneda. */
export interface ImportesLinea {
  precioUnitario: number;
  baseLine: number;
  descuentoImporte: number;
  ivaImporte: number;
  retencionImporte: number;
}

export interface Totales {
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
}

export interface LineaCalculada {
  descripcion: string;
  cantidad: number;
  descuentoPorcentaje: number;
  tipoIva: number;
  tipoRetencion: number;
  productoServicioId?: string;
  doc: ImportesLinea;
  cuenta: ImportesLinea;
}

export interface ImportesFactura {
  doc: Totales;
  cuenta: Totales;
  lineas: LineaCalculada[];
}

/** El redondeo de siempre del calculo de facturas (no tocar: las cifras en EUR no cambian). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const cent = (n: number): number => Math.round(n * 100);
const sinCeroNegativo = (n: number): number => (n === 0 ? 0 : n);

/**
 * Lado documento: el calculo de siempre (antes calcularTotales de
 * income-invoices.service.ts), sin cambios.
 */
export function calcularLineasDoc(lineas: LineaEntrada[]): {
  totales: Totales;
  lineas: Array<Omit<LineaCalculada, 'doc' | 'cuenta'> & { importes: ImportesLinea }>;
} {
  let baseTotal = 0;
  let ivaTotal = 0;
  let retencionTotal = 0;

  const out = lineas.map((l) => {
    const tipoIva = l.tipoIva ?? 21;
    const tipoRetencion = l.tipoRetencion ?? 0;
    const descuentoPorcentaje = l.descuentoPorcentaje ?? 0;

    const pvpSinDescuento = round2(l.cantidad * l.precioUnitario);
    const descuentoImporte = round2((pvpSinDescuento * descuentoPorcentaje) / 100);
    const baseLine = round2(pvpSinDescuento - descuentoImporte);
    const ivaImporte = round2((baseLine * tipoIva) / 100);
    const retencionImporte = round2((baseLine * tipoRetencion) / 100);

    baseTotal = round2(baseTotal + baseLine);
    ivaTotal = round2(ivaTotal + ivaImporte);
    retencionTotal = round2(retencionTotal + retencionImporte);

    return {
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      descuentoPorcentaje,
      tipoIva,
      tipoRetencion,
      productoServicioId: l.productoServicioId,
      importes: { precioUnitario: l.precioUnitario, baseLine, descuentoImporte, ivaImporte, retencionImporte },
    };
  });

  return {
    totales: { baseTotal, ivaTotal, retencionTotal, totalFactura: round2(baseTotal + ivaTotal - retencionTotal) },
    lineas: out,
  };
}

/**
 * Reparte `objetivo` (al centimo) entre las lineas en proporcion a sus
 * importes `brutos` (sin redondear): redondea cada uno y ajusta la diferencia
 * centimo a centimo. Si sobran centimos, se quitan a las lineas mas redondeadas
 * hacia arriba; si faltan, se dan a las mas redondeadas hacia abajo. En empate,
 * la de menor indice. Determinista y valido con signos mezclados.
 */
export function repartirCentimos(objetivo: number, brutos: number[]): number[] {
  if (brutos.length === 0) return [];
  const centimos = brutos.map((b) => cent(redondear2(b)));
  let d = cent(redondear2(objetivo)) - centimos.reduce((a, c) => a + c, 0);
  if (d !== 0) {
    // Cuanto se ha redondeado cada linea hacia arriba (si sobra) o hacia abajo (si falta).
    const clave = brutos.map((b, i) => (d < 0 ? centimos[i] / 100 - b : b - centimos[i] / 100));
    const orden = brutos.map((_, i) => i).sort((a, b) => clave[b] - clave[a] || a - b);
    const paso = d < 0 ? -1 : 1;
    for (let k = 0; d !== 0; k++) {
      centimos[orden[k % orden.length]] += paso;
      d -= paso;
    }
  }
  return centimos.map((c) => sinCeroNegativo(c / 100));
}

/** Suma al centimo (en enteros, sin arrastrar error de coma flotante). */
const sumar = (valores: number[]): number => sinCeroNegativo(valores.reduce((a, v) => a + cent(v), 0) / 100);

/** Indices de las lineas agrupados por una clave (tipo de IVA o de retencion). */
function agrupar<T>(lineas: T[], clave: (l: T) => number): Map<number, number[]> {
  const grupos = new Map<number, number[]>();
  lineas.forEach((l, i) => {
    const k = clave(l);
    grupos.set(k, [...(grupos.get(k) ?? []), i]);
  });
  return grupos;
}

/**
 * Convierte a la moneda de cuenta las lineas ya calculadas en la del
 * documento. `tipoCambio` = unidades del documento por 1 de cuenta (≠ 1).
 *
 *  a) Por tipo de IVA t: B_t = redondear2(Σ base_doc / tc), repartida entre las
 *     lineas del grupo en proporcion a base_doc / tc.
 *  b) C_t = redondear2(B_t × t / 100), la cuota sobre la base ya convertida,
 *     repartida en proporcion a base_i × t / 100.
 *  c) Por tipo de retencion rt: R_rt = redondear2(Σ base_i × rt / 100), igual.
 *  d) Descuento y precio unitario: solo informativos.
 */
export function convertirLineas(
  lineasDoc: Array<{ tipoIva: number; tipoRetencion: number; importes: ImportesLinea }>,
  tipoCambio: number,
): ImportesLinea[] {
  if (!(tipoCambio > 0)) throw new Error(`Tipo de cambio no válido: ${tipoCambio}`);
  const n = lineasDoc.length;
  const base = new Array<number>(n).fill(0);
  const iva = new Array<number>(n).fill(0);
  const ret = new Array<number>(n).fill(0);

  for (const [t, idx] of agrupar(lineasDoc, (l) => l.tipoIva)) {
    const sumaDoc = sumar(idx.map((i) => lineasDoc[i].importes.baseLine));
    const bases = repartirCentimos(
      redondear2(sumaDoc / tipoCambio),
      idx.map((i) => lineasDoc[i].importes.baseLine / tipoCambio),
    );
    idx.forEach((i, k) => (base[i] = bases[k]));
    const bT = sumar(bases);
    const cuotas = repartirCentimos(
      redondear2((bT * t) / 100),
      idx.map((i) => (base[i] * t) / 100),
    );
    idx.forEach((i, k) => (iva[i] = cuotas[k]));
  }

  for (const [rt, idx] of agrupar(lineasDoc, (l) => l.tipoRetencion)) {
    const brutos = idx.map((i) => (base[i] * rt) / 100);
    const objetivo = redondear2((sumar(idx.map((i) => base[i])) * rt) / 100);
    const retenciones = repartirCentimos(objetivo, brutos);
    idx.forEach((i, k) => (ret[i] = retenciones[k]));
  }

  return lineasDoc.map((l, i) => ({
    precioUnitario: redondear4(l.importes.precioUnitario / tipoCambio),
    baseLine: base[i],
    descuentoImporte: redondear2(l.importes.descuentoImporte / tipoCambio),
    ivaImporte: iva[i],
    retencionImporte: ret[i],
  }));
}

/** Cabecera = suma de las lineas; total = base + IVA - retencion. */
export function totalesDeLineas(lineas: ImportesLinea[]): Totales {
  const baseTotal = sumar(lineas.map((l) => l.baseLine));
  const ivaTotal = sumar(lineas.map((l) => l.ivaImporte));
  const retencionTotal = sumar(lineas.map((l) => l.retencionImporte));
  return { baseTotal, ivaTotal, retencionTotal, totalFactura: sumar([baseTotal, ivaTotal, -retencionTotal]) };
}

const CEROS: ImportesLinea = { precioUnitario: 0, baseLine: 0, descuentoImporte: 0, ivaImporte: 0, retencionImporte: 0 };

/**
 * Importes completos de una factura.
 *  - `mismaMoneda`: la cuenta es copia literal del documento.
 *  - `tipoCambio` null (tipo PENDIENTE, solo en borradores y proformas): la
 *    moneda de cuenta queda a 0 hasta que haya tipo; nada lee esos importes
 *    como si fueran de cuenta mientras no se emita.
 */
export function calcularImportesFactura(
  lineas: LineaEntrada[],
  { tipoCambio, mismaMoneda }: { tipoCambio: number | null; mismaMoneda: boolean },
): ImportesFactura {
  const { totales: doc, lineas: lineasDoc } = calcularLineasDoc(lineas);
  let cuentaLineas: ImportesLinea[];
  if (mismaMoneda) cuentaLineas = lineasDoc.map((l) => ({ ...l.importes }));
  else if (tipoCambio === null) cuentaLineas = lineasDoc.map(() => ({ ...CEROS }));
  else cuentaLineas = convertirLineas(lineasDoc, tipoCambio);

  return {
    doc,
    cuenta: mismaMoneda ? { ...doc } : totalesDeLineas(cuentaLineas),
    lineas: lineasDoc.map((l, i) => {
      const { importes, ...resto } = l;
      return { ...resto, doc: importes, cuenta: cuentaLineas[i] };
    }),
  };
}

const negar = (n: number): number => sinCeroNegativo(-n);
const negarImportes = (i: ImportesLinea): ImportesLinea => ({
  precioUnitario: i.precioUnitario,
  baseLine: negar(i.baseLine),
  descuentoImporte: negar(i.descuentoImporte),
  ivaImporte: negar(i.ivaImporte),
  retencionImporte: negar(i.retencionImporte),
});
const negarTotales = (t: Totales): Totales => ({
  baseTotal: negar(t.baseTotal),
  ivaTotal: negar(t.ivaTotal),
  retencionTotal: negar(t.retencionTotal),
  totalFactura: negar(t.totalFactura),
});

/**
 * Rectificativa TOTAL: copia de la original con el signo cambiado en TODOS los
 * importes (documento y cuenta) y en la cabecera, sin recalcular. Asi original
 * + rectificativa = 0 exacto en 430, 700, 477, libro de IVA y 303, en las dos
 * monedas. El precio unitario se conserva y la cantidad cambia de signo.
 */
export function lineasEspejo(original: { doc: Totales; cuenta: Totales; lineas: LineaCalculada[] }): ImportesFactura {
  return {
    doc: negarTotales(original.doc),
    cuenta: negarTotales(original.cuenta),
    lineas: original.lineas.map((l) => ({
      ...l,
      cantidad: negar(l.cantidad),
      doc: negarImportes(l.doc),
      cuenta: negarImportes(l.cuenta),
    })),
  };
}
