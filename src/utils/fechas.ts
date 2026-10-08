/**
 * Fecha de hoy en hora peninsular (Europe/Madrid), como AAAA-MM-DD.
 *
 * `new Date().toISOString()` da el día en UTC: entre las 00:00 y las 02:00 en
 * verano (01:00 en invierno) devuelve todavía el día anterior, y en Vercel el
 * servidor va en UTC. El formato 'en-CA' ya sale como AAAA-MM-DD.
 */
const FORMATO_MADRID = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function hoyEspana(ahora: Date = new Date()): string {
  return FORMATO_MADRID.format(ahora);
}

/**
 * Dias de plazo de una factura cuando no se indica el vencimiento: los mismos en
 * el servidor (API, lector, gastos) y en la pantalla de nueva factura. Antes el
 * servidor ponia 15 y la pantalla 30, y las facturas de la API vencian antes.
 */
export const DIAS_VENCIMIENTO_POR_DEFECTO = 30;

/** Suma dias a una fecha AAAA-MM-DD (en UTC, sin saltos por el cambio de hora). */
export function sumarDiasISO(fecha: string, dias: number): string {
  const d = new Date(`${fecha.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Vencimiento por defecto de una factura emitida en `fechaEmision`. */
export function vencimientoPorDefecto(fechaEmision: string): string {
  return sumarDiasISO(fechaEmision, DIAS_VENCIMIENTO_POR_DEFECTO);
}

/** Año en curso en hora peninsular. */
export function anioEspana(ahora: Date = new Date()): number {
  return Number(hoyEspana(ahora).slice(0, 4));
}
