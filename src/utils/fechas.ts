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

/** Año en curso en hora peninsular. */
export function anioEspana(ahora: Date = new Date()): number {
  return Number(hoyEspana(ahora).slice(0, 4));
}
