/**
 * Plantilla B (ceramica y materiales de construccion), como la factura
 * NZ013_2026: datos de cada linea y totales del pie. Puro: sin BD.
 *
 * Cada linea lleva palets, cajas, m2, piezas, formato, calidad, peso y la
 * unidad de su precio: el importe es la cantidad de esa unidad por el precio
 * (5,04 m2 × 12,25 = 61,74; 20 piezas × 26,50 = 530,00). `cantidad` es esa
 * cantidad: los m2 (M2), las piezas (PIEZA) o las unidades (UNIDAD, que en el
 * PDF salen en la columna de piezas de su linea, pero no suman en el total de
 * piezas del pie: 12 sacos de cemento o 1 transporte no son piezas).
 *
 * El cargo de palets de madera («PALETS DE MADERA TRATADA», 1 × 9,00) es una
 * linea mas, marcada con cargoPalets, con su cuenta de ingresos y su IVA: suma
 * en la base como cualquier otra, pero en el PDF va en el pie y no en la tabla,
 * y no cuenta en los totales de palets, cajas, m2, piezas ni peso.
 */

export const UNIDADES_PRECIO = ['M2', 'PIEZA', 'UNIDAD'] as const;
export type UnidadPrecio = (typeof UNIDADES_PRECIO)[number];

export const esUnidadPrecio = (v: unknown): v is UnidadPrecio => typeof v === 'string' && (UNIDADES_PRECIO as readonly string[]).includes(v);

/** Nombre de la unidad del precio para los textos («por m²», «por pieza», «por unidad»). */
export const NOMBRE_UNIDAD_PRECIO: Record<UnidadPrecio, string> = { M2: 'm²', PIEZA: 'pieza', UNIDAD: 'unidad' };

/** Largo maximo del formato (23,3x120), de la calidad y de la obra. */
export const FORMATO_MAX = 40;
export const CALIDAD_MAX = 10;
export const OBRA_MAX = 200;
/** Texto por defecto del cargo de palets. */
export const TEXTO_CARGO_PALETS = 'PALETS DE MADERA TRATADA';

/** Datos de ceramica de una linea (plantilla B). */
export interface DatosCeramicaLinea {
  palets?: number | null;
  cajas?: number | null;
  metros2?: number | null;
  piezas?: number | null;
  formato?: string | null;
  calidad?: string | null;
  pesoKg?: number | null;
  unidadPrecio?: UnidadPrecio | null;
  /** Cargo de palets de madera: va en el pie del PDF. */
  cargoPalets?: boolean;
}

/** Campos numericos de la linea que cambian de signo con la cantidad. */
export const CAMPOS_MEDIDA = ['palets', 'cajas', 'metros2', 'piezas', 'pesoKg'] as const;

/** Los datos de ceramica de una linea que vienen definidos (sin claves undefined). */
export function datosCeramica(l: DatosCeramicaLinea): DatosCeramicaLinea {
  const out: DatosCeramicaLinea = {};
  for (const k of CAMPOS_MEDIDA) if (l[k] !== undefined) out[k] = l[k];
  if (l.formato !== undefined) out.formato = l.formato;
  if (l.calidad !== undefined) out.calidad = l.calidad;
  if (l.unidadPrecio !== undefined) out.unidadPrecio = l.unidadPrecio;
  if (l.cargoPalets !== undefined) out.cargoPalets = l.cargoPalets;
  return out;
}

/** La linea lleva algun dato de ceramica (una medida, formato, calidad, unidad del precio o el cargo de palets). */
export function lineaConCeramica(l: DatosCeramicaLinea): boolean {
  return (
    CAMPOS_MEDIDA.some((k) => l[k] !== undefined && l[k] !== null) ||
    !!l.formato ||
    !!l.calidad ||
    (l.unidadPrecio !== undefined && l.unidadPrecio !== null) ||
    l.cargoPalets === true
  );
}

const sinCeroNegativo = (n: number): number => (n === 0 ? 0 : n);

/** n con 3 decimales como mucho (redondeo simetrico: -0,0005 da -0,001). */
export function redondear3(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const abs = Math.round(Number((Math.abs(n) * 1000).toPrecision(15)));
  return sinCeroNegativo(((n < 0 ? -1 : 1) * abs) / 1000);
}

/** Las medidas de una linea con el signo cambiado (rectificativa total). */
export function negarMedidas(l: DatosCeramicaLinea): DatosCeramicaLinea {
  const out: DatosCeramicaLinea = {};
  for (const k of CAMPOS_MEDIDA) {
    const v = l[k];
    if (v !== undefined) out[k] = v === null ? null : sinCeroNegativo(-Number(v));
  }
  return out;
}

/** Totales del pie de la plantilla B. */
export interface ResumenCeramica {
  /** Suma de las lineas de la tabla (sin el cargo de palets; las piezas, sin las de las lineas cobradas por unidad). */
  palets: number;
  cajas: number;
  metros2: number;
  piezas: number;
  /** Suma de los pesos escritos en las lineas (kg); el peso neto y el bruto de la factura van aparte, a mano. */
  pesoKg: number;
  /** Cargo de palets de madera: cantidad y base (en la moneda de la factura). */
  cargoPalets: { cantidad: number; importe: number };
}

const milesimas = (v: number | null | undefined) => Math.round(Number((Number(v ?? 0) * 1000).toPrecision(15)));
const centimos = (v: number | null | undefined) => Math.round(Number((Number(v ?? 0) * 100).toPrecision(15)));

/**
 * Totales del pie: palets, cajas, m2, piezas y peso de las lineas de la tabla
 * (en enteros: m2, piezas y peso en milesimas), y el cargo de palets aparte.
 * Las piezas de una linea cobrada por unidad (UNIDAD) son sus unidades, no
 * piezas: no suman en el total de piezas.
 */
export function resumenCeramica(lineas: Array<DatosCeramicaLinea & { cantidad: number; baseLine?: number | null }>): ResumenCeramica {
  let palets = 0;
  let cajas = 0;
  let m2 = 0;
  let piezas = 0;
  let peso = 0;
  let cargoCantidad = 0;
  let cargoImporte = 0;
  for (const l of lineas) {
    if (l.cargoPalets) {
      cargoCantidad += milesimas(l.cantidad);
      cargoImporte += centimos(l.baseLine);
      continue;
    }
    palets += Number(l.palets ?? 0);
    cajas += Number(l.cajas ?? 0);
    m2 += milesimas(l.metros2);
    if (l.unidadPrecio !== 'UNIDAD') piezas += milesimas(l.piezas);
    peso += milesimas(l.pesoKg);
  }
  return {
    palets: sinCeroNegativo(palets),
    cajas: sinCeroNegativo(cajas),
    metros2: sinCeroNegativo(m2 / 1000),
    piezas: sinCeroNegativo(piezas / 1000),
    pesoKg: sinCeroNegativo(peso / 1000),
    cargoPalets: { cantidad: sinCeroNegativo(cargoCantidad / 1000), importe: sinCeroNegativo(cargoImporte / 100) },
  };
}
