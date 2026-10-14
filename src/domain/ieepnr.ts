/**
 * IEEPNR: impuesto especial sobre los envases de plastico no reutilizables
 * (Ley 7/2022, arts. 67 a 83). Puro: sin BD.
 *
 * La empresa que lo repercute (sin ser contribuyente) lo cobra en la factura
 * por los kg de plastico no reciclado de cada linea, a un tipo por kg (0,45 €).
 * Forma parte de la base imponible del IVA (art. 78.Dos.4.º LIVA): va DENTRO de
 * baseLine y se guarda aparte (ieepnrImporte) para ensenarlo.
 *
 * Todo en enteros: kg en milesimas, tipo en diezmilesimas y euros en centimos.
 * Con coma flotante, 25,333 × 0,45 da 11,39985 o 11,3998499... segun el orden
 * de las operaciones, y el centimo bailaria.
 */
import { aCentimos } from '../utils/money';

/** Tipo de la Ley 7/2022: 0,45 € por kg de plastico no reciclado. */
export const IEEPNR_POR_KG_DEFECTO = 0.45;

/** n con `decimales` cifras como entero (redondeo simetrico, sin el error binario). */
function aEntero(n: number, decimales: number): bigint {
  if (!Number.isFinite(n)) return BigInt(0);
  const abs = Math.round(Number((Math.abs(n) * 10 ** decimales).toPrecision(15)));
  return BigInt(n < 0 ? -abs : abs);
}

/** Division entera redondeando hacia abajo (BigInt trunca hacia el cero). */
function divSuelo(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== BigInt(0) && (a < BigInt(0)) !== (b < BigInt(0)) ? q - BigInt(1) : q;
}

const sinCeroNegativo = (n: number): number => (n === 0 ? 0 : n);

/** Kg con 3 decimales como mucho (redondeo simetrico: -0,0005 da -0,001). */
export function redondearKg(kg: number): number {
  return sinCeroNegativo(Number(aEntero(kg, 3)) / 1000);
}

/**
 * IEEPNR de una linea: kg × tipo, redondeado al centimo con la mitad hacia
 * arriba (46,39005 da 46,39; 0,005 da 0,01). Con `simetrico` (rectificativas),
 * el negativo se redondea como su valor absoluto (-0,005 da -0,01), para que
 * la rectificativa deje la original a cero. Sin kg o sin tipo, 0.
 */
export function calcularIeepnr(kg: number | null | undefined, tipo: number | null | undefined, { simetrico = false }: { simetrico?: boolean } = {}): number {
  if (!kg || !tipo) return 0;
  // milesimas de kg × diezmilesimas de euro = diezmillonesimas de euro (1e-7).
  const producto = aEntero(kg, 3) * aEntero(tipo, 4);
  const paso = BigInt(100000); // 1e-7 -> centimos
  const mitad = BigInt(50000);
  const centimos =
    simetrico && producto < BigInt(0)
      ? -divSuelo(-producto + mitad, paso)
      : divSuelo(producto + mitad, paso);
  return sinCeroNegativo(Number(centimos) / 100);
}

/** Lo que pide el resumen de una linea con envases. */
export interface LineaEnvases {
  cantidad: number;
  packs?: number | null;
  kgPlastico?: number | null;
  ieepnrImporte?: number | null;
}

export interface ResumenEnvases {
  /** Kg de plastico no reciclado de la factura (3 decimales). */
  kgPlastico: number;
  packs: number;
  /** Unidades: la suma de las cantidades. */
  uds: number;
  /** IEEPNR repercutido, en euros. */
  ieepnr: number;
}

/** Totales de envases de una factura, sumados en milesimas y en centimos. */
export function resumenEnvases(lineas: LineaEnvases[]): ResumenEnvases {
  let kg = BigInt(0);
  let uds = BigInt(0);
  let packs = 0;
  let ieepnr = 0;
  for (const l of lineas) {
    kg += aEntero(Number(l.kgPlastico ?? 0), 3);
    uds += aEntero(Number(l.cantidad ?? 0), 3);
    packs += Math.trunc(Number(l.packs ?? 0));
    ieepnr += aCentimos(Number(l.ieepnrImporte ?? 0));
  }
  return {
    kgPlastico: sinCeroNegativo(Number(kg) / 1000),
    packs: sinCeroNegativo(packs),
    uds: sinCeroNegativo(Number(uds) / 1000),
    ieepnr: sinCeroNegativo(ieepnr / 100),
  };
}

/**
 * Base de la venta por cuenta de ingresos para el asiento.
 *  - Sin `cuentaIeepnr` (la empresa no es contribuyente): cada linea a su cuenta
 *    (sin ella, la generica) por su baseLine entera, IEEPNR incluido. Es lo de
 *    siempre: baseLine ya lleva el IEEPNR.
 *  - Con `cuentaIeepnr`: la linea va a su cuenta por baseLine - IEEPNR y el
 *    IEEPNR de todas las lineas a esa cuenta.
 * Sumado en centimos; las cuentas en el orden en que aparecen. La cuenta del
 * IEEPNR no sale si no hay IEEPNR.
 */
export function repartoIngresos(
  lineas: Array<{ cuenta: string | null | undefined; baseLine: number; ieepnrImporte?: number | null }>,
  cuentaIeepnr: string | null | undefined,
  generica = '700',
): Array<{ cuenta: string; base: number }> {
  const mapa = new Map<string, number>();
  let ieepnr = 0;
  const separar = !!cuentaIeepnr && cuentaIeepnr.trim() !== '';
  for (const l of lineas) {
    const cuenta = (l.cuenta ?? '').trim() || generica;
    const deIeepnr = separar ? aCentimos(Number(l.ieepnrImporte ?? 0)) : 0;
    mapa.set(cuenta, (mapa.get(cuenta) ?? 0) + aCentimos(Number(l.baseLine)) - deIeepnr);
    ieepnr += deIeepnr;
  }
  if (separar && ieepnr !== 0) {
    const c = cuentaIeepnr!.trim();
    mapa.set(c, (mapa.get(c) ?? 0) + ieepnr);
  }
  return [...mapa].map(([cuenta, centimos]) => ({ cuenta, base: sinCeroNegativo(centimos / 100) }));
}
