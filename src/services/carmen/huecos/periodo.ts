/**
 * Hueco «periodo»: entiende «este mes», «el trimestre pasado», «septiembre»,
 * «el 4T», «del 15/12 al 15/01», «en lo que va de año»... y lo convierte en
 * fechas. Trabaja sobre el texto normalizado (minúsculas, sin tildes, con las
 * abreviaturas ya expandidas: «3t» llega como «tercer trimestre»).
 *
 * Reglas:
 *  - un mes, un trimestre o un semestre sin año es el más reciente que ya ha
 *    empezado; «del año pasado» o «de este año» detrás fijan el año;
 *  - un rango sin año empieza en la fecha más reciente que ya ha llegado y
 *    termina en el mismo año (o en el siguiente si el final queda antes);
 *  - «hoy» es la fecha peninsular que se pasa (hoyEspana()).
 */
import type { Periodo } from '../tipos';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MESES_RE = '(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)';
const ORDINAL_TRIM: Record<string, number> = { primer: 1, primero: 1, segundo: 2, tercer: 3, tercero: 3, cuarto: 4 };
const ANIO_RE = '(?:año|ano|anio|ejercicio)';
/**
 * Año detrás de un trimestre, un semestre o un mes: «de 2025», «del año 2025»,
 * «del año pasado», «del ejercicio anterior», «de este año», «del año».
 * El orden importa: «del año pasado» antes que «del año».
 */
const SUFIJO_ANIO = `(?<sufijo> (?:(?:de|del) )?(?:(?:el )?${ANIO_RE} )?(?<digitos>\\d{4})| (?:de|del) (?:el )?${ANIO_RE} (?:pasado|anterior)| (?:de|del) (?:este |el )?${ANIO_RE}(?: actual| en curso)?)?`;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (a: number, m: number, d: number) => `${a}-${pad(m)}-${pad(d)}`;
const diasDelMes = (a: number, m: number) => new Date(Date.UTC(a, m, 0)).getUTCDate();
const fechaES = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function ejerciciosEntre(desde: string, hasta: string): number[] {
  const a = Number(desde.slice(0, 4));
  const b = Number(hasta.slice(0, 4));
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function crear(desde: string, hasta: string, etiqueta: string, codigo: string): Periodo {
  return { desde, hasta, etiqueta, ejercicios: ejerciciosEntre(desde, hasta), codigo };
}

export function periodoMes(anio: number, mes: number, etiqueta?: string, codigo?: string): Periodo {
  return crear(iso(anio, mes, 1), iso(anio, mes, diasDelMes(anio, mes)), etiqueta ?? `${MESES[mes - 1]} de ${anio}`, codigo ?? `${anio}-${pad(mes)}`);
}

export function periodoTrimestre(anio: number, t: number, etiqueta?: string, codigo?: string): Periodo {
  const mesIni = (t - 1) * 3 + 1;
  return crear(iso(anio, mesIni, 1), iso(anio, mesIni + 2, diasDelMes(anio, mesIni + 2)), etiqueta ?? `el ${t}T de ${anio}`, codigo ?? `${anio}-${t}T`);
}

export function periodoSemestre(anio: number, s: number, etiqueta?: string, codigo?: string): Periodo {
  const mesIni = s === 1 ? 1 : 7;
  return crear(iso(anio, mesIni, 1), iso(anio, mesIni + 5, diasDelMes(anio, mesIni + 5)), etiqueta ?? `el ${s === 1 ? 'primer' : 'segundo'} semestre de ${anio}`, codigo ?? `${anio}-${s}S`);
}

export function periodoAnio(anio: number, etiqueta?: string, codigo?: string): Periodo {
  return crear(`${anio}-01-01`, `${anio}-12-31`, etiqueta ?? `${anio}`, codigo ?? String(anio));
}

/** Trimestre (1-4) de una fecha AAAA-MM-DD. */
export function trimestreDe(fecha: string): number {
  return Math.floor((Number(fecha.slice(5, 7)) - 1) / 3) + 1;
}

/**
 * Resuelve un código de periodo (el que viaja en los botones) a fechas.
 * Los relativos ('mes-pasado') se resuelven con la fecha de hoy.
 */
export function resolverCodigoPeriodo(codigo: string, hoy: string): Periodo | null {
  const anio = Number(hoy.slice(0, 4));
  const mes = Number(hoy.slice(5, 7));
  const t = trimestreDe(hoy);
  switch (codigo) {
    case 'hoy':
      return crear(hoy, hoy, `hoy (${fechaES(hoy)})`, 'hoy');
    case 'ayer': {
      const f = sumarDias(hoy, -1);
      return crear(f, f, `ayer (${fechaES(f)})`, 'ayer');
    }
    case 'esta-semana': {
      const dia = (new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = lunes
      const lunes = sumarDias(hoy, -dia);
      return crear(lunes, sumarDias(lunes, 6), 'esta semana', 'esta-semana');
    }
    case 'semana-pasada': {
      const dia = (new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7;
      const lunes = sumarDias(hoy, -dia - 7);
      return crear(lunes, sumarDias(lunes, 6), 'la semana pasada', 'semana-pasada');
    }
    case 'semana-que-viene': {
      const dia = (new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7;
      const lunes = sumarDias(hoy, 7 - dia);
      return crear(lunes, sumarDias(lunes, 6), 'la semana que viene', 'semana-que-viene');
    }
    case 'este-mes':
      return periodoMes(anio, mes, `${MESES[mes - 1]} de ${anio}`, 'este-mes');
    case 'mes-que-viene': {
      const a = mes === 12 ? anio + 1 : anio;
      const m = mes === 12 ? 1 : mes + 1;
      return periodoMes(a, m, `el mes que viene (${MESES[m - 1]} de ${a})`, 'mes-que-viene');
    }
    case 'mes-pasado': {
      const a = mes === 1 ? anio - 1 : anio;
      const m = mes === 1 ? 12 : mes - 1;
      return periodoMes(a, m, `el mes pasado (${MESES[m - 1]} de ${a})`, 'mes-pasado');
    }
    case 'este-trimestre':
      return periodoTrimestre(anio, t, `este trimestre (${t}T de ${anio})`, 'este-trimestre');
    case 'trimestre-pasado': {
      const a = t === 1 ? anio - 1 : anio;
      const tp = t === 1 ? 4 : t - 1;
      return periodoTrimestre(a, tp, `el trimestre pasado (${tp}T de ${a})`, 'trimestre-pasado');
    }
    case 'este-semestre': {
      const se = mes <= 6 ? 1 : 2;
      return periodoSemestre(anio, se, `este semestre (${se === 1 ? 'primer' : 'segundo'} semestre de ${anio})`, 'este-semestre');
    }
    case 'semestre-pasado': {
      const a = mes <= 6 ? anio - 1 : anio;
      const se = mes <= 6 ? 2 : 1;
      return periodoSemestre(a, se, `el semestre pasado (${se === 1 ? 'primer' : 'segundo'} semestre de ${a})`, 'semestre-pasado');
    }
    case 'este-anio':
      return periodoAnio(anio, `lo que va de ${anio}`, 'este-anio');
    case 'anio-pasado':
      return periodoAnio(anio - 1, `el año pasado (${anio - 1})`, 'anio-pasado');
    default:
      break;
  }
  let m: RegExpMatchArray | null;
  if ((m = codigo.match(/^(\d{4})-(\d{2})$/))) {
    const mm = Number(m[2]);
    return mm >= 1 && mm <= 12 ? periodoMes(Number(m[1]), mm) : null;
  }
  if ((m = codigo.match(/^(\d{4})-([1-4])T$/))) return periodoTrimestre(Number(m[1]), Number(m[2]));
  if ((m = codigo.match(/^(\d{4})-([12])S$/))) return periodoSemestre(Number(m[1]), Number(m[2]));
  if ((m = codigo.match(/^(\d{4})$/))) return periodoAnio(Number(m[1]));
  if ((m = codigo.match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/))) {
    if (!fechaValida(m[1]) || !fechaValida(m[2]) || m[1] > m[2]) return null;
    return crear(m[1], m[2], `del ${fechaES(m[1])} al ${fechaES(m[2])}`, codigo);
  }
  return null;
}

function fechaValida(f: string): boolean {
  const [a, m, d] = f.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= diasDelMes(a, m);
}

/** Año del mes `mes` sin año: el más reciente que ya ha empezado. */
function anioMasReciente(mes: number, hoy: string): number {
  const anio = Number(hoy.slice(0, 4));
  return mes <= Number(hoy.slice(5, 7)) ? anio : anio - 1;
}

const normalizarAnio = (a: number) => (a < 100 ? a + 2000 : a);

/**
 * Rango de dos fechas (día y mes, con año o sin él). Sin año, el inicio es la
 * fecha más reciente que ya ha llegado y el final va en el mismo año (o en el
 * siguiente si queda antes del inicio), aunque sea futuro: «del 1/10 al 31/10»
 * el 07/10/2026 es octubre de 2026, no de 2025. Los cálculos que no admiten
 * futuro ya recortan a hoy (hastaHoy).
 */
function rangoFechas(d1: number, m1: number, a1: number | undefined, d2: number, m2: number, a2: number | undefined, hoy: string): { desde: string; hasta: string } | null {
  if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12) return null;
  let anioDesde: number;
  let anioHasta: number;
  if (a1 !== undefined && a2 !== undefined) {
    anioDesde = normalizarAnio(a1);
    anioHasta = normalizarAnio(a2);
  } else if (a1 !== undefined) {
    anioDesde = normalizarAnio(a1);
    anioHasta = m2 * 100 + d2 < m1 * 100 + d1 ? anioDesde + 1 : anioDesde;
  } else if (a2 !== undefined) {
    anioHasta = normalizarAnio(a2);
    anioDesde = m1 * 100 + d1 > m2 * 100 + d2 ? anioHasta - 1 : anioHasta;
  } else {
    const anioHoy = Number(hoy.slice(0, 4));
    // El inicio más reciente que ya ha llegado (se compara como texto AAAA-MM-DD).
    anioDesde = iso(anioHoy, m1, d1) <= hoy ? anioHoy : anioHoy - 1;
    anioHasta = m2 * 100 + d2 < m1 * 100 + d1 ? anioDesde + 1 : anioDesde;
  }
  const desde = iso(anioDesde, m1, d1);
  const hasta = iso(anioHasta, m2, d2);
  if (!fechaValida(desde) || !fechaValida(hasta) || desde > hasta) return null;
  return { desde, hasta };
}

export interface PeriodoExtraido {
  periodo: Periodo;
  /** Texto sin el trozo del periodo (para clasificar sin él). */
  resto: string;
}

/** Busca un periodo en el texto normalizado. Devuelve null si no hay. */
export function extraerPeriodo(texto: string, hoy: string): PeriodoExtraido | null {
  const anioHoy = Number(hoy.slice(0, 4));
  const quitar = (trozo: string) => texto.replace(trozo, ' ').replace(/\s+/g, ' ').trim();
  let m: RegExpMatchArray | null;

  // Rango de fechas: «del 15/12 al 15/01», «entre el 1/9/2026 y el 30/9/2026».
  m = texto.match(/(?:del?|desde el|desde|entre el|entre)\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s+(?:al|hasta el|hasta|y el|y)\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/);
  if (m) {
    const r = rangoFechas(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined, Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : undefined, hoy);
    if (r) return { periodo: crear(r.desde, r.hasta, `del ${fechaES(r.desde)} al ${fechaES(r.hasta)}`, `${r.desde}_${r.hasta}`), resto: quitar(m[0]) };
  }

  // Rango con meses escritos: «del 15 de diciembre al 15 de enero».
  m = texto.match(new RegExp(`(?:del?|desde el)\\s+(\\d{1,2}) de ${MESES_RE}(?: de (\\d{4}))?\\s+(?:al|hasta el)\\s+(\\d{1,2}) de ${MESES_RE}(?: de (\\d{4}))?`));
  if (m) {
    const r = rangoFechas(Number(m[1]), indiceMes(m[2]), m[3] ? Number(m[3]) : undefined, Number(m[4]), indiceMes(m[5]), m[6] ? Number(m[6]) : undefined, hoy);
    if (r) return { periodo: crear(r.desde, r.hasta, `del ${fechaES(r.desde)} al ${fechaES(r.hasta)}`, `${r.desde}_${r.hasta}`), resto: quitar(m[0]) };
  }

  const fijos: Array<[RegExp, string]> = [
    [/\b(hoy)\b/, 'hoy'],
    [/\b(ayer)\b/, 'ayer'],
    [/\b(la semana que viene|la proxima semana|proxima semana|semana proxima)\b/, 'semana-que-viene'],
    [/\b(esta semana)\b/, 'esta-semana'],
    [/\b(el mes que viene|el proximo mes|proximo mes|mes que viene)\b/, 'mes-que-viene'],
    [/\b(la semana pasada|semana pasada|la ultima semana|semana anterior)\b/, 'semana-pasada'],
    [/\b((?:el |este )?mes pasado|el mes anterior|mes anterior|el ultimo mes)\b/, 'mes-pasado'],
    [/\b((?:en )?este mes|en lo que va de mes|del mes|el mes)\b/, 'este-mes'],
    [/\b((?:el |este )?trimestre pasado|(?:el )?trimestre anterior|(?:el )?anterior trimestre|(?:el )?ultimo trimestre)\b/, 'trimestre-pasado'],
    [/\b((?:en )?este trimestre|en lo que va de trimestre|del trimestre|el trimestre|trimestre actual)\b/, 'este-trimestre'],
    [/\b((?:el |este )?semestre pasado|(?:el )?semestre anterior|(?:el )?anterior semestre|(?:el )?ultimo semestre)\b/, 'semestre-pasado'],
    [/\b((?:en )?este semestre|en lo que va de semestre|del semestre|el semestre|semestre actual)\b/, 'este-semestre'],
    [/\b((?:el )?(?:año|ano|anio|ejercicio) pasado|(?:el )?(?:año|ano|anio|ejercicio) anterior)\b/, 'anio-pasado'],
    [/\b((?:en )?lo que va de (?:año|ano|anio|ejercicio)|(?:en )?este (?:año|ano|anio|ejercicio)|del (?:año|ano|anio|ejercicio)|el (?:año|ano|anio|ejercicio)|(?:año|ano|anio|ejercicio) actual)\b(?! \d)/, 'este-anio'],
  ];

  /** Año del sufijo («de 2025», «del año pasado», «de este año»), o null si no lo hay. */
  const anioDelSufijo = (g: Record<string, string | undefined> | undefined): number | null => {
    if (!g?.sufijo) return null;
    if (g.digitos) return Number(g.digitos);
    return /pasado|anterior/.test(g.sufijo) ? anioHoy - 1 : anioHoy;
  };

  // Trimestre con ordinal: «el tercer trimestre (de 2025 | del año pasado)».
  m = texto.match(new RegExp(`\\b(?:el )?(primer|primero|segundo|tercer|tercero|cuarto) trimestre${SUFIJO_ANIO}`));
  if (m) {
    const t = ORDINAL_TRIM[m[1]];
    let anio = anioDelSufijo(m.groups) ?? anioHoy;
    if (!m.groups?.sufijo && t > trimestreDe(hoy)) anio -= 1;
    return { periodo: periodoTrimestre(anio, t), resto: quitar(m[0]) };
  }

  // Semestre con ordinal: «el primer semestre (de 2025 | del año pasado)».
  m = texto.match(new RegExp(`\\b(?:el )?(primer|primero|segundo) semestre${SUFIJO_ANIO}`));
  if (m) {
    const se = m[1] === 'segundo' ? 2 : 1;
    let anio = anioDelSufijo(m.groups) ?? anioHoy;
    if (!m.groups?.sufijo && se === 2 && Number(hoy.slice(5, 7)) < 7) anio -= 1;
    return { periodo: periodoSemestre(anio, se), resto: quitar(m[0]) };
  }

  // Mes con nombre: «septiembre», «en marzo de 2025», «marzo del año pasado».
  m = texto.match(new RegExp(`\\b(?:en |de |del mes de )?${MESES_RE}${SUFIJO_ANIO}(?![\\p{L}\\d])`, 'u'));
  if (m) {
    const mes = indiceMes(m[1]);
    const anio = anioDelSufijo(m.groups) ?? anioMasReciente(mes, hoy);
    return { periodo: periodoMes(anio, mes), resto: quitar(m[0]) };
  }

  for (const [re, codigo] of fijos) {
    const f = texto.match(re);
    if (f) {
      const periodo = resolverCodigoPeriodo(codigo, hoy);
      if (periodo) return { periodo, resto: quitar(f[0]) };
    }
  }

  // Últimos N días / meses.
  m = texto.match(/\b(?:los )?ultimos (\d{1,3}) (dias|meses)\b/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && n <= 366) {
      let desde: string;
      if (m[2] === 'dias') {
        desde = sumarDias(hoy, -(n - 1));
      } else {
        // Los meses, desde el día 1 del primero.
        const total = anioHoy * 12 + (Number(hoy.slice(5, 7)) - 1) - (n - 1);
        desde = iso(Math.floor(total / 12), (total % 12) + 1, 1);
      }
      return { periodo: crear(desde, hoy, `los últimos ${n} ${m[2] === 'dias' ? 'días' : 'meses'}`, `${desde}_${hoy}`), resto: quitar(m[0]) };
    }
  }

  // Año suelto: «en 2025», «de 2024», «2025» (no el principio de un número de factura como 2026-0045).
  m = texto.match(/(?:\b(?:en|de|del|el) )?(?:(?:año|ano|anio|ejercicio) )?(?<![\d/.-])(20\d{2})(?![\d/.-])/);
  if (m) {
    const anio = Number(m[1]);
    if (anio >= 2000 && anio <= anioHoy + 1) return { periodo: periodoAnio(anio), resto: quitar(m[0]) };
  }

  return null;
}

function indiceMes(nombre: string): number {
  return nombre === 'setiembre' ? 9 : MESES.indexOf(nombre) + 1;
}

/** Fecha de hoy recortada al final del periodo (para «lo que va de...»). */
export function hastaHoy(periodo: Periodo, hoy: string): string {
  return periodo.hasta < hoy ? periodo.hasta : hoy;
}

export { fechaES };
