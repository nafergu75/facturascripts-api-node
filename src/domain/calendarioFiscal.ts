/**
 * Calendario de modelos de la AEAT de un ejercicio, según los ajustes fiscales
 * de la empresa (Configuración > Impuestos) y su forma jurídica.
 *
 *  - 303: trimestral ('1T'..'4T') o mensual ('01'..'12', REDEME o SII).
 *  - 111 y 115: mensuales si es gran empresa; si no, trimestrales.
 *  - 349: trimestral.
 *  - 130: trimestral, solo autónomos (en lugar del 200).
 *  - Anuales ('0A'): 390 y 347 (no con SII), 200 (no autónomos) y 190.
 *
 * Funciones puras: las usan el módulo de impuestos (al crear las filas) y los
 * ajustes fiscales (vista previa y cambio de ajustes).
 */
import { AJUSTES_FISCALES_POR_DEFECTO, type AjustesFiscales } from './ajustes.model';

export interface EntradaCalendario {
  codigo: string;
  periodo: string;
}

export interface OpcionesCalendario {
  ajustes: Pick<AjustesFiscales, 'periodicidadIva' | 'sii' | 'granEmpresa'>;
  /** Forma jurídica AUTONOMO: 130 trimestral y sin 200. */
  autonomo: boolean;
}

export const OPCIONES_CALENDARIO_POR_DEFECTO: OpcionesCalendario = { ajustes: AJUSTES_FISCALES_POR_DEFECTO, autonomo: false };

const TRIMESTRES = ['1T', '2T', '3T', '4T'];
const MESES = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

/** Modelos cuyo calendario depende de los ajustes fiscales o de la forma jurídica. */
export const CODIGOS_SEGUN_AJUSTES: readonly string[] = ['303', '111', '115', '130', '200', '390', '347'];

/** Modelos que componen el calendario de un ejercicio. */
export function calendarioEjercicio(ejercicio: number, opciones: OpcionesCalendario = OPCIONES_CALENDARIO_POR_DEFECTO): EntradaCalendario[] {
  void ejercicio; // Todos los ejercicios son de año natural (v1).
  const { ajustes, autonomo } = opciones;
  const out: EntradaCalendario[] = [];
  const periodos = (mensual: boolean) => (mensual ? MESES : TRIMESTRES);
  for (const periodo of periodos(ajustes.periodicidadIva === 'MENSUAL')) out.push({ codigo: '303', periodo });
  for (const codigo of ['111', '115']) for (const periodo of periodos(ajustes.granEmpresa)) out.push({ codigo, periodo });
  for (const periodo of TRIMESTRES) out.push({ codigo: '349', periodo });
  if (autonomo) for (const periodo of TRIMESTRES) out.push({ codigo: '130', periodo });
  const anuales = [...(ajustes.sii ? [] : ['390', '347']), ...(autonomo ? [] : ['200']), '190'];
  for (const codigo of anuales) out.push({ codigo, periodo: '0A' });
  return out;
}

/** Fechas (AAAA-MM-DD) que cubre un periodo: '0A', '1T'..'4T' o '01'..'12'. null si no se reconoce. */
export function rangoPeriodo(ejercicio: number, periodo: string): { inicio: string; fin: string } | null {
  const p = String(periodo ?? '').toUpperCase();
  if (p === '0A') return { inicio: `${ejercicio}-01-01`, fin: `${ejercicio}-12-31` };
  const t = /^([1-4])T$/.exec(p);
  const ultimoDia = (mes: number) => String(new Date(Date.UTC(ejercicio, mes, 0)).getUTCDate()).padStart(2, '0');
  if (t) {
    const q = Number(t[1]);
    const mesIni = (q - 1) * 3 + 1;
    const mesFin = q * 3;
    return { inicio: `${ejercicio}-${String(mesIni).padStart(2, '0')}-01`, fin: `${ejercicio}-${String(mesFin).padStart(2, '0')}-${ultimoDia(mesFin)}` };
  }
  if (/^(0[1-9]|1[0-2])$/.test(p)) return { inicio: `${ejercicio}-${p}-01`, fin: `${ejercicio}-${p}-${ultimoDia(Number(p))}` };
  return null;
}

const claveEntrada = (e: EntradaCalendario) => `${e.codigo}:${e.periodo}`;

function seSolapan(ejercicio: number, a: string, b: string): boolean {
  const ra = rangoPeriodo(ejercicio, a);
  const rb = rangoPeriodo(ejercicio, b);
  return !!ra && !!rb && ra.inicio <= rb.fin && rb.inicio <= ra.fin;
}

/**
 * Filas del calendario que faltan: las deseadas que no existen y no se solapan
 * con otra fila del mismo modelo. Así, tras pasar a IVA mensual en abril, el
 * 1T trimestral que ya existe no se duplica con enero, febrero y marzo.
 */
export function filasQueFaltan(ejercicio: number, deseado: EntradaCalendario[], existentes: EntradaCalendario[]): EntradaCalendario[] {
  const hay = new Set(existentes.map(claveEntrada));
  return deseado.filter(
    (d) => !hay.has(claveEntrada(d)) && !existentes.some((e) => e.codigo === d.codigo && seSolapan(ejercicio, e.periodo, d.periodo)),
  );
}

export interface FilaCalendario extends EntradaCalendario {
  id: string;
  estado: string;
  origen?: string | null;
}

export interface PlanCambioCalendario {
  /** Primer día al que se aplican los ajustes nuevos en el ejercicio; null = ya no cabe en él. */
  aplicadoDesde: string | null;
  /** Filas que sobran con los ajustes nuevos (sin presentar ni omitir ni editadas a mano). */
  borrar: string[];
  /** Filas nuevas. */
  crear: EntradaCalendario[];
}

/**
 * Qué cambia en el calendario de un ejercicio con los ajustes nuevos.
 *
 * No se tocan las filas presentadas, omitidas ni editadas a mano. El cambio
 * empieza en el primer trimestre libre después de la última de ellas (los
 * trimestres y los meses coinciden en esas fechas): con el 1T presentado,
 * desde el 1 de abril. Los modelos anuales solo cambian si el año entero queda
 * libre. Los modelos que no dependen de los ajustes (349, 190) no se tocan.
 */
export function planCambioCalendario(ejercicio: number, existentes: FilaCalendario[], deseado: EntradaCalendario[]): PlanCambioCalendario {
  const afectadas = existentes.filter((e) => CODIGOS_SEGUN_AJUSTES.includes(e.codigo));
  const fija = (e: FilaCalendario) => e.estado !== 'vigente' || e.origen === 'manual-mixto';
  const finFijas = afectadas
    .filter((e) => fija(e) && e.periodo !== '0A')
    .map((e) => rangoPeriodo(ejercicio, e.periodo)?.fin ?? '')
    .sort()
    .pop();
  const inicios = ['01', '04', '07', '10'].map((m) => `${ejercicio}-${m}-01`);
  const desde = inicios.find((q) => !finFijas || q > finFijas) ?? null;
  if (!desde) return { aplicadoDesde: null, borrar: [], crear: [] };

  const anioEntero = desde === inicios[0];
  const dentro = (e: EntradaCalendario) => (e.periodo === '0A' ? anioEntero : (rangoPeriodo(ejercicio, e.periodo)?.inicio ?? '') >= desde);
  const deseadas = new Set(deseado.map(claveEntrada));
  const borrar = afectadas.filter((e) => !fija(e) && !deseadas.has(claveEntrada(e)) && dentro(e));
  const idsBorrar = new Set(borrar.map((e) => e.id));
  const quedan = existentes.filter((e) => !idsBorrar.has(e.id));
  const crear = filasQueFaltan(
    ejercicio,
    deseado.filter((d) => CODIGOS_SEGUN_AJUSTES.includes(d.codigo) && dentro(d)),
    quedan,
  );
  return { aplicadoDesde: desde, borrar: borrar.map((e) => e.id), crear };
}
