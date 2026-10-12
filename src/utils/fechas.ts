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

const FORMATO_HUSO_MADRID = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

/**
 * Instante con la fecha, la hora y el huso de Madrid: AAAA-MM-DDThh:mm:ss+01:00
 * en invierno y +02:00 en verano. Es el formato de FechaHoraHusoGenRegistro de
 * VERI*FACTU (spec verifactu, 3.6). Nunca toISOString(): da la hora en UTC.
 */
export function formatearHusoMadrid(instante: Date): string {
  const p: Record<string, string> = {};
  for (const parte of FORMATO_HUSO_MADRID.formatToParts(instante)) p[parte.type] = parte.value;
  // longOffset da «GMT+01:00» o «GMT+02:00» (solo «GMT» con desfase cero, que en Madrid no se da).
  const huso = p.timeZoneName.replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${huso}`;
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

/**
 * Día `dia` del mes que queda `meses` meses antes del de `hoy` (AAAA-MM-DD,
 * hora de Madrid por defecto). Si ese mes no tiene ese día, el último del mes.
 * Sirve para los datos de prueba: así no se quedan fijos en un año.
 */
export function fechaHaceMeses(meses: number, dia: number, hoy: string = hoyEspana()): string {
  const total = Number(hoy.slice(0, 4)) * 12 + Number(hoy.slice(5, 7)) - 1 - meses;
  const anio = Math.floor(total / 12);
  const mes = (total % 12) + 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  return `${anio}-${String(mes).padStart(2, '0')}-${String(Math.min(dia, ultimo)).padStart(2, '0')}`;
}

/** Fecha AAAA-MM-DD como la lee la persona: DD/MM/AAAA. Lo que no tiene ese formato se devuelve tal cual. */
export function fechaTexto(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso ?? '');
}
