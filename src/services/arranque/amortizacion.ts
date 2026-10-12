/**
 * Calculo de la amortizacion lineal de un elemento de inmovilizado, mes a mes.
 *
 *  - Cuota anual = (coste - valor residual) x coeficiente / 100.
 *  - La del mes sale por dias: cuota anual x dias que amortiza en el mes / dias
 *    del año (365 o 366). Para que los doce meses sumen justo la cuota anual,
 *    la del mes es lo acumulado en el año hasta su ultimo dia menos lo
 *    acumulado hasta el mes anterior (cada uno redondeado a centimos).
 *  - Empieza el dia de inicio de la amortizacion (el 1-1-2027 en los bienes
 *    traidos de la gestoria, que ya llevan la amortizacion acumulada a
 *    31-12-2026) y acaba el dia de la baja.
 *  - Nunca pasa de coste - valor residual - amortizacion ya hecha.
 *
 * Funciones puras: sin base de datos.
 */
import { aCentimos } from '../../utils/money';

export interface ActivoParaAmortizar {
  coste: number;
  valorResidual: number;
  /** Amortizacion acumulada al empezar en la app (la de la gestoria a 31-12-2026). */
  amortAcumuladaInicial: number;
  /** Porcentaje anual (10 = 10 %). */
  coeficiente: number;
  /** AAAA-MM-DD */
  fechaInicioAmortizacion: string;
  /** AAAA-MM-DD; sin baja, null. */
  fechaBaja?: string | null;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Dias de un año (366 en los bisiestos). */
export const diasDelAnio = (anio: number) => (new Date(Date.UTC(anio, 1, 29)).getUTCMonth() === 1 ? 366 : 365);

/** Ultimo dia (numero) de un mes. */
const ultimoDia = (anio: number, mes: number) => new Date(Date.UTC(anio, mes, 0)).getUTCDate();

/** Dias entre dos fechas AAAA-MM-DD, las dos incluidas (0 si la segunda es anterior). */
function diasEntre(desde: string, hasta: string): number {
  const a = Date.UTC(Number(desde.slice(0, 4)), Number(desde.slice(5, 7)) - 1, Number(desde.slice(8, 10)));
  const b = Date.UTC(Number(hasta.slice(0, 4)), Number(hasta.slice(5, 7)) - 1, Number(hasta.slice(8, 10)));
  return b < a ? 0 : Math.round((b - a) / 86_400_000) + 1;
}

const max = (a: string, b: string) => (a > b ? a : b);
const min = (a: string, b: string) => (a < b ? a : b);

/** Periodo AAAA-MM valido. */
export const esPeriodo = (p: unknown): p is string => typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p);

/** Cuota anual del bien. */
export const cuotaAnual = (a: ActivoParaAmortizar) => r2(((a.coste - a.valorResidual) * a.coeficiente) / 100);

/** Lo que queda por amortizar despues de `dotado` (sin contar la acumulada inicial). */
export const pendienteDeAmortizar = (a: ActivoParaAmortizar, dotado: number) => Math.max(0, r2(a.coste - a.valorResidual - a.amortAcumuladaInicial - dotado));

/** Amortizacion del año `anio` desde su inicio (o el del bien) hasta `hasta` (incluido), sin tope. */
function acumuladoEnAnio(a: ActivoParaAmortizar, anio: number, hasta: string): number {
  const desde = max(`${anio}-01-01`, a.fechaInicioAmortizacion);
  const fin = a.fechaBaja ? min(hasta, a.fechaBaja) : hasta;
  const dias = diasEntre(desde, fin);
  return dias ? r2((cuotaAnual(a) * dias) / diasDelAnio(anio)) : 0;
}

/**
 * Cuota de un mes (AAAA-MM) con lo ya dotado antes en la app (`dotadoAntes`):
 * nunca pasa de lo que queda por amortizar. 0 antes del inicio o despues de la baja.
 */
export function cuotaDelMes(a: ActivoParaAmortizar, periodo: string, dotadoAntes = 0): number {
  if (!esPeriodo(periodo)) throw new Error(`Periodo no valido: ${periodo}`);
  if (a.coeficiente <= 0 || a.coste <= 0) return 0;
  const anio = Number(periodo.slice(0, 4));
  const mes = Number(periodo.slice(5, 7));
  const finMes = `${periodo}-${String(ultimoDia(anio, mes)).padStart(2, '0')}`;
  const finAnterior = mes === 1 ? null : `${anio}-${String(mes - 1).padStart(2, '0')}-${String(ultimoDia(anio, mes - 1)).padStart(2, '0')}`;
  const cuota = r2(acumuladoEnAnio(a, anio, finMes) - (finAnterior ? acumuladoEnAnio(a, anio, finAnterior) : 0));
  const tope = pendienteDeAmortizar(a, dotadoAntes);
  return aCentimos(cuota) > aCentimos(tope) ? tope : Math.max(0, cuota);
}

/** Meses de `desde` a `hasta` (AAAA-MM, los dos incluidos). */
export function mesesEntre(desde: string, hasta: string): string[] {
  const out: string[] = [];
  let anio = Number(desde.slice(0, 4));
  let mes = Number(desde.slice(5, 7));
  const fin = Number(hasta.slice(0, 4)) * 12 + Number(hasta.slice(5, 7));
  while (anio * 12 + mes <= fin) {
    out.push(`${anio}-${String(mes).padStart(2, '0')}`);
    mes++;
    if (mes > 12) {
      mes = 1;
      anio++;
    }
  }
  return out;
}

/** Primer mes en el que el bien amortiza (AAAA-MM). */
export const primerMes = (a: ActivoParaAmortizar) => a.fechaInicioAmortizacion.slice(0, 7);

/** Valor neto contable: coste menos la amortizacion acumulada inicial y lo dotado. */
export const valorNeto = (a: ActivoParaAmortizar, dotado: number) => r2(a.coste - a.amortAcumuladaInicial - dotado);
