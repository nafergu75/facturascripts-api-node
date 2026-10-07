/**
 * Plazos generales de presentación de la AEAT para una pyme con ejercicio
 * natural. Es la única tabla de plazos de Carmen; coincide con
 * fechaVencimientoModelo (impuestosModulo) en los modelos que comparten y añade
 * 130, 180, 190 y 202. El 347 vence el último día de febrero (29 en bisiesto).
 *
 * Son los plazos ordinarios: si el último día cae en sábado, domingo o festivo,
 * pasa al siguiente día hábil, y eso no se calcula aquí. Por eso las respuestas
 * llevan siempre el aviso AVISO_FESTIVOS.
 *
 * Diferencia conocida con frontend/web/lib/aeatCalendar.ts: allí el 4T del 111
 * y del 115 vence el 30 de enero; el plazo correcto es el 20 de enero.
 */
import { fechaES } from '../plantillas';

export const AVISO_FESTIVOS =
  'Si el último día cae en festivo o fin de semana, pasa al siguiente día hábil; confírmalo en el calendario de la AEAT.';

export const FUENTE_CALENDARIO = {
  titulo: 'Calendario del contribuyente (AEAT)',
  url: 'https://sede.agenciatributaria.gob.es/Sede/calendario-contribuyente.html',
  verificadaEl: '2026-10-07',
};

export interface Plazo {
  modelo: string;
  nombre: string;
  /** '1T'..'4T', '1P'..'3P' (pagos fraccionados del 202) o '0A' (anual). */
  periodo: string;
  ejercicio: number;
  /** Último día de presentación (AAAA-MM-DD). */
  fecha: string;
  /** Pantalla de la app donde se prepara, si existe. */
  href?: string;
  nota?: string;
}

export const NOMBRES_MODELO: Record<string, string> = {
  '303': 'IVA trimestral',
  '111': 'retenciones de trabajo y profesionales',
  '115': 'retenciones de alquileres',
  '130': 'pago fraccionado del IRPF (autónomos en estimación directa)',
  '349': 'operaciones intracomunitarias',
  '390': 'resumen anual del IVA',
  '190': 'resumen anual de retenciones de trabajo y profesionales',
  '180': 'resumen anual de retenciones de alquileres',
  '347': 'operaciones con terceros',
  '200': 'Impuesto sobre Sociedades',
  '202': 'pago fraccionado del Impuesto sobre Sociedades',
};

const HREF: Record<string, string> = {
  '303': '/dashboard/fiscal/modelo-303',
  '111': '/dashboard/fiscal/modelo-111',
  '115': '/dashboard/fiscal/modelo-115',
  '390': '/dashboard/fiscal/modelo-390',
  '190': '/dashboard/fiscal/modelo-190',
  '347': '/dashboard/fiscal/modelo-347',
  '200': '/dashboard/fiscal/modelo-200',
};

const NOTAS: Record<string, string> = {
  '303': 'Plazo de quien lo presenta cada trimestre. Las empresas grandes y las inscritas en el SII o en el REDEME lo presentan cada mes.',
  '349': 'Plazo de quien lo presenta cada trimestre. Si las entregas intracomunitarias pasan de 50.000 € en el trimestre o en alguno de los cuatro anteriores, se presenta cada mes.',
  '130': 'Solo autónomos en estimación directa. No están obligados los profesionales que el año anterior tuvieron retención en al menos el 70 % de sus ingresos.',
};

const ultimoDiaFebrero = (anio: number) => (new Date(Date.UTC(anio, 2, 0)).getUTCDate() === 29 ? `${anio}-02-29` : `${anio}-02-28`);

/** Plazos de los modelos de un ejercicio (los anuales y el 4T se presentan al año siguiente). */
export function plazosDelEjercicio(ejercicio: number): Plazo[] {
  const sig = ejercicio + 1;
  const plazos: Plazo[] = [];
  const trimestrales: Array<[string, string]> = [
    ['303', `${sig}-01-30`],
    ['111', `${sig}-01-20`],
    ['115', `${sig}-01-20`],
    ['130', `${sig}-01-30`],
    ['349', `${sig}-01-30`],
  ];
  for (const [modelo, cuartoT] of trimestrales) {
    const fechas = [`${ejercicio}-04-20`, `${ejercicio}-07-20`, `${ejercicio}-10-20`, cuartoT];
    fechas.forEach((fecha, i) => plazos.push(crear(modelo, `${i + 1}T`, ejercicio, fecha)));
  }
  plazos.push(
    crear('390', '0A', ejercicio, `${sig}-01-30`),
    crear('190', '0A', ejercicio, `${sig}-01-31`),
    crear('180', '0A', ejercicio, `${sig}-01-31`),
    crear('347', '0A', ejercicio, ultimoDiaFebrero(sig)),
    // Ejercicio natural: los 25 días siguientes a los seis meses del cierre.
    crear('200', '0A', ejercicio, `${sig}-07-25`),
    crear('202', '1P', ejercicio, `${ejercicio}-04-20`),
    crear('202', '2P', ejercicio, `${ejercicio}-10-20`),
    crear('202', '3P', ejercicio, `${ejercicio}-12-20`),
  );
  return plazos;
}

function crear(modelo: string, periodo: string, ejercicio: number, fecha: string): Plazo {
  return {
    modelo,
    nombre: NOMBRES_MODELO[modelo],
    periodo,
    ejercicio,
    fecha,
    ...(HREF[modelo] ? { href: HREF[modelo] } : {}),
    ...(NOTAS[modelo] ? { nota: NOTAS[modelo] } : {}),
  };
}

/** «el 3T de 2026», «el ejercicio 2025», «el 2.º pago de 2026». */
export function etiquetaPeriodo(p: Plazo): string {
  if (p.periodo === '0A') return `el ejercicio ${p.ejercicio}`;
  if (p.periodo.endsWith('P')) return `el ${p.periodo[0]}.º pago de ${p.ejercicio}`;
  return `el ${p.periodo} de ${p.ejercicio}`;
}

/** Próximos plazos desde hoy (incluido), de uno o de todos los modelos. */
export function proximosPlazos(hoy: string, n = 5, modelo?: string): Plazo[] {
  const anio = Number(hoy.slice(0, 4));
  return [...plazosDelEjercicio(anio - 1), ...plazosDelEjercicio(anio)]
    .filter((p) => p.fecha >= hoy && (!modelo || p.modelo === modelo))
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.modelo.localeCompare(b.modelo))
    .slice(0, n);
}

/** Días entre hoy y una fecha (AAAA-MM-DD). */
export function diasHasta(hoy: string, fecha: string): number {
  return Math.round((Date.parse(`${fecha}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
}

/** Frase con el próximo plazo de un modelo: «El 303 del 3T de 2026 se presenta hasta el 20/10/2026 (quedan 13 días).» */
export function frasePlazo(p: Plazo, hoy: string): string {
  const dias = diasHasta(hoy, p.fecha);
  const cuanto = dias === 0 ? 'vence hoy' : dias === 1 ? 'queda 1 día' : `quedan ${dias} días`;
  return `El modelo ${p.modelo} (${p.nombre}) de ${etiquetaPeriodo(p).replace(/^el /, '')} se presenta hasta el ${fechaES(p.fecha)} (${cuanto}).`;
}

/** ¿Es una pregunta de plazos? («¿cuándo vence el 303?», «plazo del 111», «hasta cuándo tengo para el IVA»). */
export function esPreguntaDeCalendario(texto: string): boolean {
  return /\b(cuando (?:vence|se presenta|hay que presentar|tengo que presentar|toca|se paga|termina|acaba)|hasta cuando|plazo|plazos|fecha limite|ultimo dia|vencimiento|vence|calendario fiscal|calendario)\b/.test(texto);
}

/** Modelo al que se refiere una pregunta de plazos por su nombre («el IVA» → 303). */
export function modeloPorNombre(texto: string): string | null {
  if (/\b(resumen anual del iva|iva anual)\b/.test(texto)) return '390';
  if (/\b(operaciones con terceros)\b/.test(texto)) return '347';
  if (/\b(intracomunitari\w*)\b/.test(texto)) return '349';
  if (/\b(pago fraccionado de(l)? (impuesto de )?sociedades)\b/.test(texto)) return '202';
  if (/\b(impuesto (de|sobre) sociedades|sociedades)\b/.test(texto)) return '200';
  if (/\b(alquiler\w*|arrendamiento\w*)\b/.test(texto)) return '115';
  if (/\b(pago fraccionado|estimacion directa)\b/.test(texto)) return '130';
  if (/\b(retenciones|irpf)\b/.test(texto)) return '111';
  if (/\b(iva)\b/.test(texto)) return '303';
  return null;
}
