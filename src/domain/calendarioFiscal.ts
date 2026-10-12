/**
 * Calendario de modelos de la AEAT de un ejercicio, según los ajustes fiscales
 * de la empresa (Configuración > Impuestos) y su forma jurídica.
 *
 *  - 303: trimestral ('1T'..'4T') o mensual ('01'..'12', REDEME o SII).
 *  - 111 y 115: mensuales si es gran empresa; si no, trimestrales.
 *  - 349: trimestral.
 *  - 130: trimestral, solo autónomos (en lugar del 200).
 *  - Anuales ('0A'): 390 y 347 (no con SII), 200 (no autónomos), 190 y 180.
 *  - 202 (pagos fraccionados del Impuesto sobre Sociedades, no autónomos):
 *    '1P', '2P' y '3P', desde 2027 (los anteriores se presentaron fuera de la app).
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
/** Pagos fraccionados del 202: abril (1P), octubre (2P) y diciembre (3P). */
const PERIODOS_202 = ['1P', '2P', '3P'];
/** Primer ejercicio con los 202 en la app. */
export const PRIMER_EJERCICIO_202 = 2027;
/**
 * Desde cuando se lleva la contabilidad en la app (2026 y antes se llevan
 * fuera). Un 303 de antes no esta en la app, pero ya se presento: un abono
 * que reduce su IVA (ERROR_IVA de una factura de 2026) obliga a rectificarlo.
 */
export const INICIO_LLEVANZA_APP = '2027-01-01';
const MESES = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));

/** Modelos cuyo calendario depende de los ajustes fiscales o de la forma jurídica. */
export const CODIGOS_SEGUN_AJUSTES: readonly string[] = ['303', '111', '115', '130', '200', '390', '347'];

/** Modelos que componen el calendario de un ejercicio. */
export function calendarioEjercicio(ejercicio: number, opciones: OpcionesCalendario = OPCIONES_CALENDARIO_POR_DEFECTO): EntradaCalendario[] {
  // Todos los ejercicios son de año natural (v1).
  const { ajustes, autonomo } = opciones;
  const out: EntradaCalendario[] = [];
  const periodos = (mensual: boolean) => (mensual ? MESES : TRIMESTRES);
  for (const periodo of periodos(ajustes.periodicidadIva === 'MENSUAL')) out.push({ codigo: '303', periodo });
  for (const codigo of ['111', '115']) for (const periodo of periodos(ajustes.granEmpresa)) out.push({ codigo, periodo });
  for (const periodo of TRIMESTRES) out.push({ codigo: '349', periodo });
  if (autonomo) for (const periodo of TRIMESTRES) out.push({ codigo: '130', periodo });
  const anuales = [...(ajustes.sii ? [] : ['390', '347']), ...(autonomo ? [] : ['200']), '190', '180'];
  for (const codigo of anuales) out.push({ codigo, periodo: '0A' });
  if (!autonomo && ejercicio >= PRIMER_EJERCICIO_202) for (const periodo of PERIODOS_202) out.push({ codigo: '202', periodo });
  return out;
}

/**
 * Fechas (AAAA-MM-DD) que cubre un periodo: '0A', '1T'..'4T', '01'..'12' o los
 * pagos fraccionados '1P'..'3P'. Cada pago se calcula con lo acumulado desde
 * enero, pero aqui cuenta solo lo que añade (enero-marzo, abril-septiembre y
 * octubre-noviembre): asi los tres no se solapan entre si al crear las filas
 * del calendario. null si no se reconoce.
 */
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
  const pago: Record<string, [string, string]> = { '1P': ['01-01', '03-31'], '2P': ['04-01', '09-30'], '3P': ['10-01', '11-30'] };
  if (pago[p]) return { inicio: `${ejercicio}-${pago[p][0]}`, fin: `${ejercicio}-${pago[p][1]}` };
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

/** Primer día de cada trimestre del ejercicio (donde coinciden meses y trimestres). */
export const iniciosTrimestre = (ejercicio: number): string[] => ['01', '04', '07', '10'].map((m) => `${ejercicio}-${m}-01`);

export interface OpcionesPlan {
  /**
   * Hoy (AAAA-MM-DD). Un cambio de régimen vale para los periodos que aún no
   * han empezado: sin `aplicarDesde`, empieza en el primer trimestre que
   * empieza hoy o después. Sin `hoy`, desde el 1 de enero (sin límite).
   */
  hoy?: string;
  /**
   * Inicio de trimestre desde el que el cambio vale de verdad, aunque ya haya
   * pasado (p. ej. una gran empresa desde el 1 de enero que configura la app
   * tarde). Lo pide la persona y lo confirma en la pantalla.
   */
  aplicarDesde?: string;
}

/**
 * Qué cambia en el calendario de un ejercicio con los ajustes nuevos.
 *
 * El cambio empieza en el primer inicio de trimestre (los trimestres y los
 * meses coinciden en esas fechas) que cumpla las dos cosas:
 *  - no es anterior a hoy, o a `aplicarDesde` si se indica: los periodos que
 *    ya han empezado no cambian (un cambio de régimen no es retroactivo);
 *  - va después de la última fila presentada, omitida o editada a mano, que
 *    nunca se tocan (con el 1T presentado, como pronto desde abril).
 * Los modelos anuales solo cambian si el año entero queda libre. Los modelos
 * que no dependen de los ajustes (349, 190) no se tocan.
 */
export function planCambioCalendario(
  ejercicio: number,
  existentes: FilaCalendario[],
  deseado: EntradaCalendario[],
  opciones: OpcionesPlan = {},
): PlanCambioCalendario {
  const afectadas = existentes.filter((e) => CODIGOS_SEGUN_AJUSTES.includes(e.codigo));
  const fija = (e: FilaCalendario) => e.estado !== 'vigente' || e.origen === 'manual-mixto';
  const finFijas = afectadas
    .filter((e) => fija(e) && e.periodo !== '0A')
    .map((e) => rangoPeriodo(ejercicio, e.periodo)?.fin ?? '')
    .sort()
    .pop();
  const inicios = iniciosTrimestre(ejercicio);
  const minimo = opciones.aplicarDesde ?? opciones.hoy ?? '';
  const desde = inicios.find((q) => (!finFijas || q > finFijas) && q >= minimo) ?? null;
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

// ---------------------------------------------------------------------------
// Régimen fiscal por fecha de efecto (spec arranque-2027, B.7) y fecha de
// inicio en la app (B.8)
// ---------------------------------------------------------------------------

/** Lo que decide el calendario: periodicidad del IVA, REDEME, SII y gran empresa. */
export type RegimenFiscal = Pick<AjustesFiscales, 'periodicidadIva' | 'redeme' | 'sii' | 'granEmpresa'>;

/** Un régimen desde su fecha de efecto (AAAA-MM-DD). */
export interface VigenciaRegimen extends RegimenFiscal {
  desde: string;
}

const REGIMEN_POR_DEFECTO: RegimenFiscal = {
  periodicidadIva: AJUSTES_FISCALES_POR_DEFECTO.periodicidadIva,
  redeme: AJUSTES_FISCALES_POR_DEFECTO.redeme,
  sii: AJUSTES_FISCALES_POR_DEFECTO.sii,
  granEmpresa: AJUSTES_FISCALES_POR_DEFECTO.granEmpresa,
};

export const regimenDe = (a: RegimenFiscal): RegimenFiscal => ({
  periodicidadIva: a.periodicidadIva === 'MENSUAL' ? 'MENSUAL' : 'TRIMESTRAL',
  redeme: !!a.redeme,
  sii: !!a.sii,
  granEmpresa: !!a.granEmpresa,
});

/** Régimen vigente un día: el de la última fecha de efecto que no es posterior; sin ninguna, el de por defecto. */
export function regimenEn(vigencias: readonly VigenciaRegimen[], fecha: string): RegimenFiscal {
  let elegido: VigenciaRegimen | null = null;
  for (const v of vigencias) if (v.desde <= fecha && (!elegido || v.desde >= elegido.desde)) elegido = v;
  return elegido ? regimenDe(elegido) : { ...REGIMEN_POR_DEFECTO };
}

/**
 * Calendario de un ejercicio cuando el régimen cambia a lo largo del año: cada
 * periodo trimestral o mensual sale con el régimen vigente el día que empieza,
 * y los anuales y los pagos del 202, con el del 1 de enero (igual que
 * planCambioCalendario, que solo cambia los anuales si el año entero queda
 * libre). Con un solo régimen en el año es calendarioEjercicio tal cual.
 */
export function calendarioConVigencias(ejercicio: number, vigencias: readonly VigenciaRegimen[], autonomo: boolean): EntradaCalendario[] {
  const enero = `${ejercicio}-01-01`;
  const delAnio = vigencias.filter((v) => v.desde > enero && v.desde <= `${ejercicio}-12-31`);
  const alEmpezar = calendarioEjercicio(ejercicio, { ajustes: regimenEn(vigencias, enero), autonomo });
  if (!delAnio.length) return alEmpezar;
  const cache = new Map<string, Set<string>>();
  const clavesCon = (r: RegimenFiscal) => {
    const k = JSON.stringify(r);
    if (!cache.has(k)) cache.set(k, new Set(calendarioEjercicio(ejercicio, { ajustes: r, autonomo }).map(claveEntrada)));
    return cache.get(k)!;
  };
  const candidatas = new Map<string, EntradaCalendario>();
  for (const r of [regimenEn(vigencias, enero), ...delAnio.map(regimenDe)]) {
    for (const e of calendarioEjercicio(ejercicio, { ajustes: r, autonomo })) candidatas.set(claveEntrada(e), e);
  }
  const anual = (p: string) => p === '0A' || /^[1-3]P$/.test(p);
  return [...candidatas.values()].filter((e) => {
    if (anual(e.periodo)) return alEmpezar.some((a) => a.codigo === e.codigo && a.periodo === e.periodo);
    const inicio = rangoPeriodo(ejercicio, e.periodo)?.inicio ?? enero;
    return clavesCon(regimenEn(vigencias, inicio)).has(claveEntrada(e));
  });
}

/**
 * ¿El periodo es anterior al inicio en la app? Lo es si acaba antes de esa
 * fecha: sus modelos los presentó otro (la gestoría) y no se crean ni cuentan
 * como pendientes. Sin fecha de inicio, nunca.
 */
export function antesDelInicio(ejercicio: number, periodo: string, inicioEnApp: string | null | undefined): boolean {
  if (!inicioEnApp) return false;
  const fin = rangoPeriodo(ejercicio, periodo)?.fin;
  return !!fin && fin < inicioEnApp;
}
