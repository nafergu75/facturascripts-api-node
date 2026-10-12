/**
 * Último día real de un plazo de la AEAT.
 *
 * Si el último día de presentación cae en sábado, domingo o fiesta nacional,
 * el plazo acaba el siguiente día hábil (art. 30.5 de la Ley 39/2015, al que
 * remite la Ley General Tributaria). Por eso el 390 de 2026, que vence el
 * sábado 30-1-2027, se presenta hasta el lunes 1-2-2027.
 *
 * Solo se cuentan las fiestas nacionales comunes a toda España, entre ellas el
 * Viernes Santo, que se mueve cada año con la Pascua. Las fiestas autonómicas
 * y locales no entran: dependen del domicilio y la AEAT no siempre las aplica.
 *
 * Funciones puras, con fechas AAAA-MM-DD y cálculos en UTC (sin cambio de hora).
 */
import { pascua } from './divisas';

const iso = (d: Date): string => d.toISOString().slice(0, 10);

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return iso(d);
}

/** Fiestas nacionales fijas (día-mes), iguales en todas las comunidades. */
const FIJAS = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];

const cache = new Map<number, Set<string>>();

/** Fiestas nacionales de un año (AAAA-MM-DD): las fijas y el Viernes Santo. */
export function festivosNacionales(anio: number): Set<string> {
  let dias = cache.get(anio);
  if (!dias) {
    dias = new Set([...FIJAS.map((md) => `${anio}-${md}`), sumarDias(pascua(anio), -2)]);
    cache.set(anio, dias);
  }
  return dias;
}

/** ¿Se puede presentar ese día? No es sábado, domingo ni fiesta nacional. */
export function esDiaHabilAeat(fecha: string): boolean {
  const d = new Date(`${fecha.slice(0, 10)}T00:00:00Z`);
  const dia = d.getUTCDay();
  if (dia === 0 || dia === 6) return false;
  return !festivosNacionales(d.getUTCFullYear()).has(fecha.slice(0, 10));
}

/**
 * Último día real del plazo: la fecha que dice la norma o, si ese día no es
 * hábil, el siguiente que lo sea.
 */
export function plazoAeat(fecha: string): string {
  let f = fecha.slice(0, 10);
  // Nunca hay más de cuatro días seguidos sin hábil (p. ej. jueves festivo,
  // Viernes Santo, sábado y domingo): el tope solo evita un bucle sin fin.
  for (let i = 0; i < 10 && !esDiaHabilAeat(f); i++) f = sumarDias(f, 1);
  return f;
}

/** Último día de febrero de un año (29 en los bisiestos). */
export function ultimoDiaFebrero(anio: number): string {
  return `${anio}-02-${String(new Date(Date.UTC(anio, 2, 0)).getUTCDate()).padStart(2, '0')}`;
}
