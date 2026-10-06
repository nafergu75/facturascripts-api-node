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
