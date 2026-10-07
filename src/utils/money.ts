/**
 * Importes en euros guardados como Float. Para comparar o cuadrar, se pasan a
 * centimos enteros: con Float, 0.1 + 0.2 !== 0.3 y una tolerancia tipo
 * `<= 0.01` acepta o rechaza el mismo centimo segun los decimales arrastrados.
 */

/** Euros -> centimos enteros, redondeando al centimo mas cercano (mitad lejos de cero). */
export function aCentimos(euros: number): number {
  const signo = euros < 0 ? -1 : 1;
  return signo * Math.round(Math.abs(euros) * 100 + Number.EPSILON * 100);
}

/** true si debe y haber son iguales al centimo. Un asiento solo es valido asi. */
export function cuadraEnCentimos(debe: number, haber: number): boolean {
  return aCentimos(debe) === aCentimos(haber);
}

/**
 * Redondeo SIMETRICO a `decimales` (mitad lejos de cero): redondear(-1.005, 2)
 * es -1.01, igual que 1.005 da 1.01. Antes de redondear se corrige el error de
 * representacion binaria con 15 cifras significativas (1.005 * 100 da
 * 100.49999999999999 en coma flotante).
 *
 * Es el redondeo de la conversion de divisas. El calculo de las facturas en su
 * propia moneda conserva el redondeo de siempre (ver domain/importesFactura.ts).
 */
function redondearSimetrico(n: number, decimales: number): number {
  if (!Number.isFinite(n)) return n;
  const factor = 10 ** decimales;
  const escalado = Number((Math.abs(n) * factor).toPrecision(15));
  const r = Math.round(escalado) / factor;
  return n < 0 && r !== 0 ? -r : r;
}

/** Redondeo simetrico al centimo. */
export const redondear2 = (n: number): number => redondearSimetrico(n, 2);
/** Redondeo simetrico a 4 decimales (precios unitarios). */
export const redondear4 = (n: number): number => redondearSimetrico(n, 4);
/** Redondeo simetrico a 8 decimales (tipos de cambio). */
export const redondear8 = (n: number): number => redondearSimetrico(n, 8);
