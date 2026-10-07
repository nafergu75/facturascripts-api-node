/**
 * Lectura del Excel (o CSV) de nominas que manda la gestoria cada mes: una fila
 * por trabajador. Funciones puras, sin base de datos.
 *
 * Cada programa de nominas (A3, Nominasol, Sage...) exporta a su manera, asi
 * que nada es fijo:
 *  - la fila de titulos se busca entre las primeras filas (puede haber antes
 *    un titulo como "Resumen de nominas enero 2026");
 *  - las columnas se reconocen por su titulo, con los nombres habituales
 *    ("Total devengado", "Aportacion trabajador", "Liquido a percibir"...), y
 *    se pueden fijar a mano con `mapeo` ({ campo: indice de columna });
 *  - las filas de totales se saltan;
 *  - el mes sale de una columna, del titulo del fichero o de las opciones.
 *
 * El "bruto" del fichero puede incluir la especie (total devengado) o no: se
 * prueba con las dos lecturas y se queda la que cuadra con el liquido.
 */
import { leerFilasArchivo } from '../extractoBancario.service';
import {
  detectarSeparadorDecimal,
  letraColumna,
  normalizarTitulo,
  parsearFecha,
  parsearImporte,
  texto,
  type SeparadorDecimal,
} from '../puestaEnMarcha/lectorContable';
import { badRequest } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { errorNaf, errorNifPersona, normalizarNaf, normalizarNif } from '../../utils/nif';
import { TIPOS_NOMINA, type CuadreNomina, type ImportesNomina, type TipoNomina } from '../../domain/nominas.model';
import { cuadreNomina, fmtEuros, mensajeDescuadre } from './calculo';

export const CAMPOS_FICHERO = [
  'nombre',
  'apellidos',
  'apellido2',
  'nif',
  'naf',
  'periodo',
  'tipo',
  'ejercicioDevengo',
  'bruto',
  'especie',
  'ingresoACuenta',
  'dietas',
  'indemnizacion',
  'indemnizacionSujeta',
  'ssTrabajador',
  'irpf',
  'porcentajeIrpf',
  'embargos',
  'anticipos',
  'otrasDeducciones',
  'liquido',
  'ssEmpresa',
  'costeTotal',
] as const;
export type CampoFichero = (typeof CAMPOS_FICHERO)[number];
export type MapeoNominas = Partial<Record<CampoFichero, number>>;

/** Para la pantalla de mapeo: nombre de cada campo. */
export const ETIQUETAS_CAMPOS: Record<CampoFichero, string> = {
  nombre: 'Trabajador (nombre)',
  apellidos: 'Apellidos',
  apellido2: 'Segundo apellido',
  nif: 'NIF / DNI / NIE',
  naf: 'Nº de afiliación a la SS',
  periodo: 'Mes / periodo',
  tipo: 'Tipo de nómina (ordinaria, extra...)',
  ejercicioDevengo: 'Ejercicio de devengo (atrasos de otro año)',
  bruto: 'Bruto / total devengado',
  especie: 'Retribución en especie',
  ingresoACuenta: 'Ingreso a cuenta (especie)',
  dietas: 'Dietas exentas',
  indemnizacion: 'Indemnización (exenta)',
  indemnizacionSujeta: 'Indemnización sujeta',
  ssTrabajador: 'Seguridad Social del trabajador',
  irpf: 'Retención IRPF',
  porcentajeIrpf: '% de IRPF',
  embargos: 'Embargos',
  anticipos: 'Anticipos',
  otrasDeducciones: 'Otras deducciones',
  liquido: 'Líquido a percibir',
  ssEmpresa: 'Seguridad Social de la empresa',
  costeTotal: 'Coste total empresa',
};

/** Columnas sin las que no se puede importar. */
export const CAMPOS_OBLIGATORIOS: readonly CampoFichero[] = ['nif', 'bruto', 'liquido'];

/** Columnas importantes que, si faltan, se toman como 0 con aviso. */
const CAMPOS_AVISO: readonly CampoFichero[] = ['ssTrabajador', 'irpf', 'ssEmpresa'];

// ---------------------------------------------------------------------------
// Reconocimiento de columnas
// ---------------------------------------------------------------------------

/** Titulo normalizado: "% IRPF" -> "pct irpf", "Líquido (€)" -> "liquido". */
export function normalizarTituloNomina(v: unknown): string {
  return normalizarTitulo(texto(v).replace(/%/g, ' pct '))
    .replace(/\b(eur|euros|importe)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SS = /\b(ss|s s|seg|seguridad social|segsocial|seg soc|cuotas?|cotizacion(es)?|cotiz|aportacion(es)?|aport|contingencias)\b/;
const TRAB = /\b(trabajador(es)?|trab|empleados?|obrer[ao]s?|operario)\b/;
const EMP = /\b(empresa|emp|patronal|empresarial|empleador)\b/;

type Prueba = (t: string) => boolean;

/**
 * Por campo, en orden de prioridad: [prueba fuerte, prueba debil]. Primero se
 * reparten las columnas con las pruebas fuertes y luego, a los campos que
 * queden, con las debiles. Cada columna va a un solo campo.
 */
const PRUEBAS: Array<[CampoFichero, Prueba, Prueba?]> = [
  ['naf', (t) => /\b(naf|nss|afiliacion)\b/.test(t) || /^(n|num|numero|no|cod|codigo)( de)? (ss|s s|seg social|seguridad social)$/.test(t)],
  [
    'nif',
    (t) => /^(nif|dni|nie|n i f|d n i|n i e|nif dni|dni nif|nif nie|dni nie|nif cif|cif nif|documento|doc identidad|documento identidad|documento identificativo|n documento|nif trabajador|dni trabajador|nif empleado|dni empleado|nif del trabajador|dni del trabajador)$/.test(t),
    (t) => /\b(nif|dni|nie)\b/.test(t),
  ],
  [
    'porcentajeIrpf',
    (t) => (/\bpct\b/.test(t) && /\b(irpf|i r p f|retencion|ret)\b/.test(t)) || /^(porcentaje|tipo|tanto por ciento)( de)? (irpf|retencion)( irpf)?$/.test(t),
  ],
  ['ingresoACuenta', (t) => /\bingresos? a cuenta\b|\bing a cta\b|\bingreso cuenta\b/.test(t) || (/\b(irpf|retencion|ret)\b/.test(t) && /\bespecie\b/.test(t))],
  ['ssTrabajador', (t) => SS.test(t) && TRAB.test(t) && !/\b(coste|costo|base|bases)\b/.test(t)],
  ['ssEmpresa', (t) => SS.test(t) && EMP.test(t) && !/\b(base|bases)\b/.test(t)],
  ['especie', (t) => /\bespecie\b/.test(t)],
  ['embargos', (t) => /\bembargos?\b|\bretencion(es)? judicial(es)?\b|\bjudicial(es)?\b/.test(t)],
  ['irpf', (t) => /\b(irpf|i r p f|retencion|retenciones|ret)\b/.test(t) && !/\b(pct|base|bases)\b/.test(t)],
  ['anticipos', (t) => /\b(anticipos?|adelantos?)\b/.test(t)],
  ['otrasDeducciones', (t) => /^(otras|otros) (deducciones|descuentos)\b|^descuentos?( varios)?$|^deducciones varias$/.test(t)],
  ['liquido', (t) => /\b(liquido|neto)\b/.test(t) || /\b(a percibir|a pagar)$/.test(t)],
  ['costeTotal', (t) => /\b(coste|costo)\b/.test(t) && !SS.test(t)],
  ['dietas', (t) => /\bdietas?\b/.test(t)],
  ['indemnizacionSujeta', (t) => /\bindemnizacion(es)?\b/.test(t) && /\b(sujeta|no exenta|tributable)\b/.test(t)],
  ['indemnizacion', (t) => /\bindemnizacion(es)?\b/.test(t)],
  [
    'bruto',
    (t) =>
      /^(bruto|total bruto|bruto total|importe bruto|salario bruto|sueldo bruto|retribucion bruta|remuneracion bruta|bruto dinerario|bruto nomina|total devengado|devengado|devengos|total devengos|devengado total|percepciones|total percepciones|percepciones dinerarias|retribuciones dinerarias|total retribuciones)$/.test(t),
    (t) => /\b(bruto|devengad[oa]s?|devengos)\b/.test(t) && !/\bespecie\b/.test(t),
  ],
  [
    'nombre',
    (t) =>
      /^(trabajador|trabajadores|empleado|empleados|nombre|nombre y apellidos|apellidos y nombre|apellidos nombre|nombre apellidos|nombre completo|perceptor|nombre trabajador|nombre del trabajador|nombre empleado|nombre del empleado|trabajador nombre|empleado nombre|razon social)$/.test(t),
  ],
  ['apellido2', (t) => /^(segundo apellido|apellido 2|apellido2|2 apellido)$/.test(t)],
  ['ejercicioDevengo', (t) => /^(ejercicio|ano|anio|año) (de )?(devengo|atrasos)$|^devengo (ejercicio|ano)$/.test(t)],
  ['apellidos', (t) => /^(apellidos|primer apellido|apellido 1|apellido1|1 apellido|apellido)$/.test(t)],
  [
    'periodo',
    (t) =>
      /^(mes|periodo|periodo liquidacion|periodo de liquidacion|mes liquidacion|mes de liquidacion|fecha|fecha nomina|mes devengo|periodo devengo|mes nomina|periodo nomina|devengo|mes ano|mes y ano|fecha devengo|fecha liquidacion|mes ejercicio)$/.test(t),
  ],
  ['tipo', (t) => /^(tipo|tipo nomina|tipo de nomina|clase|clase nomina|clase de nomina|tipo paga|tipo de paga|paga)$/.test(t)],
];

/** Asigna columnas a campos por su titulo. */
export function mapearTitulosNominas(titulos: string[]): MapeoNominas {
  const mapeo: MapeoNominas = {};
  const usadas = new Set<number>();
  for (const fase of [1, 2] as const) {
    for (const [campo, fuerte, debil] of PRUEBAS) {
      if (mapeo[campo] !== undefined) continue;
      const prueba = fase === 1 ? fuerte : debil;
      if (!prueba) continue;
      const idx = titulos.findIndex((t, i) => !usadas.has(i) && t !== '' && prueba(t));
      if (idx >= 0) {
        mapeo[campo] = idx;
        usadas.add(idx);
      }
    }
  }
  return mapeo;
}

const mapeoUtil = (m: MapeoNominas) => CAMPOS_OBLIGATORIOS.every((c) => m[c] !== undefined);

/**
 * Fila de titulos mas probable (0-based): la de las 40 primeras con mas titulos
 * reconocidos, si al menos son dos; -1 si ninguna.
 */
export function filaTitulosProbable(filas: unknown[][]): number {
  let mejor = -1;
  let puntos = 1;
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const n = Object.keys(mapearTitulosNominas((filas[i] ?? []).map(normalizarTituloNomina))).length;
    if (n > puntos) {
      mejor = i;
      puntos = n;
    }
  }
  return mejor;
}

export interface ColumnaFichero {
  indice: number;
  letra: string;
  titulo: string;
  ejemplo: string;
}

function describirColumnas(filas: unknown[][], filaCabecera: number): ColumnaFichero[] {
  const ancho = Math.max(0, ...filas.slice(0, 200).map((f) => (f ?? []).length));
  const cab = filaCabecera >= 0 ? (filas[filaCabecera] ?? []) : [];
  const out: ColumnaFichero[] = [];
  for (let i = 0; i < ancho; i++) {
    let ejemplo = '';
    for (let r = filaCabecera + 1; r < filas.length && r < filaCabecera + 30; r++) {
      const v = texto(filas[r]?.[i]);
      if (v) {
        ejemplo = v.slice(0, 40);
        break;
      }
    }
    out.push({ indice: i, letra: letraColumna(i), titulo: texto(cab[i]) || `Columna ${letraColumna(i)}`, ejemplo });
  }
  return out;
}

/** Valida un mapeo que llega del cliente: indices enteros, cada columna una vez. */
export function limpiarMapeo(mapeo: unknown): MapeoNominas | null {
  if (!mapeo || typeof mapeo !== 'object') return null;
  const out: MapeoNominas = {};
  const usadas = new Set<number>();
  for (const c of CAMPOS_FICHERO) {
    const v = (mapeo as Record<string, unknown>)[c];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= 200) throw badRequest(`La columna indicada para "${ETIQUETAS_CAMPOS[c]}" no es válida.`);
    if (usadas.has(n)) throw badRequest(`La columna ${letraColumna(n)} está asignada a dos datos distintos.`);
    usadas.add(n);
    out[c] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mes / periodo
// ---------------------------------------------------------------------------

const MESES: Record<string, number> = {
  enero: 1, ene: 1, gener: 1, febrero: 2, feb: 2, febrer: 2, marzo: 3, mar: 3, marc: 3, abril: 4, abr: 4,
  mayo: 5, may: 5, maig: 5, junio: 6, jun: 6, juny: 6, julio: 7, jul: 7, juliol: 7, agosto: 8, ago: 8, agost: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, set: 9, setembre: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, novembre: 11, diciembre: 12, dic: 12, desembre: 12,
};

export interface Periodo {
  ejercicio: number;
  mes: number;
}

const anioValido = (a: number) => (a < 100 ? 2000 + a : a);
const periodoOk = (ejercicio: number, mes: number): Periodo | null =>
  Number.isInteger(ejercicio) && ejercicio >= 2000 && ejercicio <= 2100 && Number.isInteger(mes) && mes >= 1 && mes <= 12 ? { ejercicio, mes } : null;

/**
 * Mes y año de una celda: "01/2026", "1-2026", "2026-01", "202601", "enero
 * 2026", "ENE-26", una fecha (del mes) o un numero de serie de Excel. Un
 * numero suelto de 1 a 12 es el mes (el año sale de `ejercicioPorDefecto`).
 */
export function parsearPeriodo(v: unknown, ejercicioPorDefecto?: number): Periodo | null {
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 1 && v <= 12) return ejercicioPorDefecto ? periodoOk(ejercicioPorDefecto, v) : null;
    if (Number.isInteger(v) && v >= 200001 && v <= 210012) return periodoOk(Math.floor(v / 100), v % 100);
    const f = parsearFecha(v);
    return f ? periodoOk(Number(f.slice(0, 4)), Number(f.slice(5, 7))) : null;
  }
  if (v instanceof Date) {
    const f = parsearFecha(v);
    return f ? periodoOk(Number(f.slice(0, 4)), Number(f.slice(5, 7))) : null;
  }
  const s = normalizarTitulo(v);
  if (!s) return null;
  let m = /^(\d{1,2}) (\d{4}|\d{2})$/.exec(s);
  if (m) return periodoOk(anioValido(Number(m[2])), Number(m[1]));
  m = /^(\d{4}) (\d{1,2})$/.exec(s);
  if (m) return periodoOk(Number(m[1]), Number(m[2]));
  m = /^(\d{4})(\d{2})$/.exec(s);
  if (m) return periodoOk(Number(m[1]), Number(m[2]));
  if (/^\d{1,2}$/.test(s) && ejercicioPorDefecto) return periodoOk(ejercicioPorDefecto, Number(s));
  const f = parsearFecha(texto(v));
  if (f) return periodoOk(Number(f.slice(0, 4)), Number(f.slice(5, 7)));
  // "enero 2026", "nomina de enero de 2026", "ene 26", "01 enero 2026"
  const palabras = s.split(' ');
  let mes: number | null = null;
  let anio: number | null = null;
  for (const p of palabras) {
    if (mes === null && MESES[p] !== undefined) mes = MESES[p];
    else if (anio === null && /^\d{4}$/.test(p)) anio = Number(p);
    else if (anio === null && mes !== null && /^\d{2}$/.test(p)) anio = anioValido(Number(p));
  }
  if (mes !== null) return periodoOk(anio ?? ejercicioPorDefecto ?? NaN, mes);
  return null;
}

/** Mes que aparece en las filas de titulo de encima de la cabecera ("Nóminas enero 2026"). */
export function periodoEnTitulo(filas: unknown[][], hastaFila: number): Periodo | null {
  for (let i = 0; i < Math.min(hastaFila, 15); i++) {
    for (const celda of filas[i] ?? []) {
      const t = texto(celda);
      if (!t || t.length > 120) continue;
      const s = normalizarTitulo(t);
      // Una fecha de emision o de impresion no es el mes de las nominas.
      if (/\b(fecha|emision|emitido|impreso|impresion|listado a)\b/.test(s)) continue;
      // Solo con nombre de mes o con "mes/año" suelto (no dentro de una fecha dd/mm/aaaa).
      const conMes = s.split(' ').some((p) => MESES[p] !== undefined && p.length >= 3);
      const numerico = /(?:^|[^\d/.-])((?:0?[1-9]|1[0-2])[/-]20\d{2})(?![\d/])/.exec(t);
      const p = conMes ? parsearPeriodo(t) : numerico ? parsearPeriodo(numerico[1]) : null;
      if (p) return p;
    }
  }
  return null;
}

export function parsearTipo(v: unknown): TipoNomina | null {
  const s = normalizarTitulo(v);
  if (!s) return 'ORDINARIA';
  if (/\bextra(ordinaria)?s?\b|\bpaga (de )?(junio|diciembre|verano|navidad|beneficios)\b/.test(s)) return 'EXTRA';
  if (/\batrasos?\b/.test(s)) return 'ATRASOS';
  if (/\bfiniquito\b|\bliquidacion\b/.test(s)) return 'FINIQUITO';
  if (/\bcomplementaria\b/.test(s)) return 'COMPLEMENTARIA';
  if (/\b(ordinaria|normal|mensual|nomina|mes)\b/.test(s)) return 'ORDINARIA';
  const upper = texto(v).toUpperCase();
  return (TIPOS_NOMINA as readonly string[]).includes(upper) ? (upper as TipoNomina) : null;
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

/** Una nomina tal como se va a guardar (salida del lector y entrada de la confirmacion). */
export interface FilaNomina extends ImportesNomina {
  /** Fila del fichero (1-based, como en Excel); en filas enviadas como JSON, su posicion. */
  fila: number;
  nif: string;
  nombre: string;
  apellidos: string;
  naf: string | null;
  ejercicio: number;
  mes: number;
  tipo: TipoNomina;
  porcentajeIrpf: number | null;
  /** Ejercicio al que corresponden unos atrasos de otro año (190); null si no lo trae. */
  ejercicioDevengo: number | null;
  /** Coste total que trae el fichero (solo para comprobarlo). */
  costeTotal: number | null;
  cuadre: CuadreNomina;
  errores: string[];
  avisos: string[];
}

export type BrutoConEspecie = 'auto' | 'si' | 'no';

export interface OpcionesLecturaNominas {
  mapeo?: unknown;
  /** Fila de titulos (1-based). */
  filaCabecera?: number;
  separadorDecimal?: SeparadorDecimal;
  /** Mes de todas las nominas del fichero, si no lo trae (o para comprobarlo). */
  ejercicio?: number;
  mes?: number;
  /** El "bruto" del fichero incluye la especie (total devengado): auto lo deduce del cuadre. */
  brutoIncluyeEspecie?: BrutoConEspecie;
}

export interface LecturaNominas {
  formato: string;
  /** 1-based; 0 si no hay titulos. */
  filaCabecera: number;
  columnas: ColumnaFichero[];
  mapeo: MapeoNominas;
  separadorDecimal: SeparadorDecimal;
  /** Mes encontrado en el titulo del fichero, si lo hay. */
  periodoTitulo: Periodo | null;
  filas: FilaNomina[];
  /** Filas ignoradas (totales, vacias...). */
  filasIgnoradas: number;
  avisos: string[];
}

const esFilaTotal = (f: unknown[]) =>
  f.some((c) => {
    const t = normalizarTitulo(c);
    return /^(total|totales|suma|sumas|total general|totales generales|total empresa|total centro)\b/.test(t);
  });

/**
 * Importes de la fila con la lectura del bruto que cuadre: con o sin especie
 * incluida, y con el ingreso a cuenta repercutido o no.
 */
function elegirLectura(
  base: Omit<ImportesNomina, 'brutoDinerario' | 'ingresoACuentaRepercutido'>,
  bruto: number,
  opcion: BrutoConEspecie,
): { importes: ImportesNomina; incluyeEspecie: boolean } {
  const especie = base.especieValoracion;
  const conEspecie = opcion === 'si' ? [true] : opcion === 'no' ? [false] : especie > 0 ? [true, false] : [false];
  const repercutido = base.ingresoACuenta > 0 ? [false, true] : [false];
  let primera: { importes: ImportesNomina; incluyeEspecie: boolean } | null = null;
  for (const incluye of conEspecie) {
    for (const rep of repercutido) {
      const importes: ImportesNomina = {
        ...base,
        brutoDinerario: Math.round((bruto - (incluye ? especie : 0)) * 100) / 100,
        ingresoACuentaRepercutido: rep,
      };
      const r = { importes, incluyeEspecie: incluye };
      if (!primera) primera = r;
      if (cuadreNomina(importes).cuadra) return r;
    }
  }
  return primera!;
}

/** Nombre de cada importe en los mensajes (nunca la clave interna de la API). */
export const ETIQUETAS_IMPORTES: Record<string, string> = {
  brutoDinerario: 'Bruto dinerario',
  dietasExentas: 'Dietas exentas',
  especieValoracion: 'Retribución en especie',
  ingresoACuenta: 'Ingreso a cuenta',
  indemnizacionExenta: 'Indemnización exenta',
  indemnizacionSujeta: 'Indemnización sujeta',
  ssTrabajador: 'SS del trabajador',
  irpf: 'IRPF',
  anticipos: 'Anticipos',
  embargos: 'Embargos',
  otrasDeducciones: 'Otras deducciones',
  liquido: 'Líquido a percibir',
  ssEmpresa: 'SS de la empresa',
};

/** Comprueba una nomina ya normalizada y rellena su cuadre, errores y avisos. */
export function validarFilaNomina(f: FilaNomina): FilaNomina {
  const errores = [...f.errores];
  const avisos = [...f.avisos];
  const nifError = errorNifPersona(f.nif);
  if (nifError) errores.push(nifError);
  if (f.naf) {
    const e = errorNaf(f.naf);
    if (e) {
      avisos.push(`${e} No se guardará.`);
      f.naf = null;
    }
  }
  if (!f.nombre.trim() && !f.apellidos.trim()) avisos.push('Falta el nombre del trabajador.');
  if (!(Number.isInteger(f.ejercicio) && f.ejercicio >= 2000 && f.ejercicio <= 2100 && Number.isInteger(f.mes) && f.mes >= 1 && f.mes <= 12)) {
    errores.push('Falta el mes de la nómina: añade una columna "Mes" o indícalo al importar.');
  }
  for (const [k, v] of Object.entries(f) as Array<[string, unknown]>) {
    if (['fila', 'ejercicio', 'mes', 'porcentajeIrpf', 'costeTotal', 'ejercicioDevengo'].includes(k)) continue;
    if (typeof v !== 'number' || (Number.isFinite(v) && v >= 0)) continue;
    if (k === 'liquido' && Number.isFinite(v)) {
      errores.push(`El líquido a percibir es negativo (${fmtEuros(v)}): suele ser un finiquito o una regularización que deja saldo a favor de la empresa. No se puede importar: regístrala a mano.`);
    } else {
      errores.push(`El importe de "${ETIQUETAS_IMPORTES[k] ?? k}" no es válido (${Number.isFinite(v) ? fmtEuros(v) : v}).`);
    }
  }
  if (f.ejercicioDevengo !== null) {
    if (!Number.isInteger(f.ejercicioDevengo) || f.ejercicioDevengo < 2000 || f.ejercicioDevengo > 2100) {
      errores.push(`El ejercicio de devengo (${f.ejercicioDevengo}) no es un año válido.`);
    } else if (Number.isInteger(f.ejercicio) && f.ejercicioDevengo > f.ejercicio) {
      errores.push(`El ejercicio de devengo (${f.ejercicioDevengo}) es posterior al de la nómina (${f.ejercicio}).`);
    }
  }
  if (f.tipo === 'ATRASOS' && f.ejercicioDevengo === null) {
    avisos.push('Son atrasos sin ejercicio de devengo: si son de un año anterior, añade la columna "Ejercicio devengo" (el 190 los declara aparte).');
  }
  if (f.porcentajeIrpf !== null && (!Number.isFinite(f.porcentajeIrpf) || f.porcentajeIrpf < 0 || f.porcentajeIrpf > 100)) {
    avisos.push(`El % de IRPF (${f.porcentajeIrpf}) no es válido: no se guardará.`);
    f.porcentajeIrpf = null;
  }
  f.cuadre = cuadreNomina(f);
  const descuadre = mensajeDescuadre(f);
  if (descuadre) errores.push(descuadre);
  else if (f.cuadre.diferencia !== 0) avisos.push(`Diferencia de ${fmtEuros(f.cuadre.diferencia)} por redondeo: se ajusta en la 640.`);
  if (aCentimos(f.liquido) <= 0 && aCentimos(f.brutoDinerario) > 0) avisos.push('El líquido a percibir es cero.');
  if (f.costeTotal !== null && Number.isFinite(f.costeTotal) && f.costeTotal > 0) {
    const coste = aCentimos(f.costeTotal);
    const candidatos = [aCentimos(f.cuadre.costeEmpresa), aCentimos(f.cuadre.costeEmpresa) + aCentimos(f.especieValoracion)];
    if (!candidatos.some((c) => Math.abs(c - coste) <= 1)) {
      avisos.push(`El coste total del fichero (${fmtEuros(f.costeTotal)}) no coincide con bruto + SS empresa (${fmtEuros(f.cuadre.costeEmpresa)}).`);
    }
  }
  return { ...f, errores, avisos };
}

/**
 * Lee las nominas de un fichero ya convertido en filas. Si no reconoce las
 * columnas, lanza 400 con `details.necesitaMapeo` y las columnas del fichero.
 */
export function leerNominasDeFilas(filas: unknown[][], opciones: OpcionesLecturaNominas = {}, formato = 'xlsx'): LecturaNominas {
  const avisos: string[] = [];
  let fila = -1;
  let mapeo: MapeoNominas;
  const manual = limpiarMapeo(opciones.mapeo);
  if (manual && Object.keys(manual).length > 0) {
    mapeo = manual;
    if (opciones.filaCabecera !== undefined) {
      fila = Number(opciones.filaCabecera) - 1;
      if (!(Number.isInteger(fila) && fila >= -1 && fila < filas.length)) throw badRequest('La fila de títulos indicada no existe en el fichero.');
    } else {
      // La fila de titulos que se detecte (aunque no sea util por si sola), o ninguna.
      fila = filaTitulosProbable(filas);
    }
    const faltan = CAMPOS_OBLIGATORIOS.filter((c) => mapeo[c] === undefined);
    if (faltan.length) {
      throw badRequest(`Faltan columnas en el mapeo: ${faltan.map((c) => ETIQUETAS_CAMPOS[c]).join(', ')}.`, {
        necesitaMapeo: true,
        columnas: describirColumnas(filas, fila),
        filaCabecera: fila + 1,
        mapeo,
        campos: ETIQUETAS_CAMPOS,
      });
    }
  } else {
    let mejor: { fila: number; mapeo: MapeoNominas; puntos: number } | null = null;
    for (let i = 0; i < Math.min(filas.length, 40); i++) {
      const m = mapearTitulosNominas((filas[i] ?? []).map(normalizarTituloNomina));
      if (!mapeoUtil(m)) continue;
      const puntos = Object.keys(m).length;
      if (!mejor || puntos > mejor.puntos) mejor = { fila: i, mapeo: m, puntos };
    }
    if (!mejor) {
      // La fila que mas titulos reconocidos tiene, aunque no basten: con ella se
      // describen las columnas y la pantalla de mapeo parte de ahi (no de la 1).
      const probable = filaTitulosProbable(filas);
      throw badRequest(
        'No encuentro la fila de títulos del fichero de nóminas (por ejemplo "Trabajador", "NIF", "Total devengado", "Líquido"). Indica qué columna es cada dato.',
        { necesitaMapeo: true, columnas: describirColumnas(filas, probable), filaCabecera: probable + 1, mapeo: probable >= 0 ? mapearTitulosNominas((filas[probable] ?? []).map(normalizarTituloNomina)) : {}, campos: ETIQUETAS_CAMPOS },
      );
    }
    fila = mejor.fila;
    mapeo = mejor.mapeo;
  }

  for (const c of CAMPOS_AVISO) {
    if (mapeo[c] === undefined) avisos.push(`No encuentro la columna "${ETIQUETAS_CAMPOS[c]}": se toma 0. Si el fichero la trae, indícala en el mapeo.`);
  }

  const datos = filas.slice(fila + 1);
  const colsImporte = (['bruto', 'especie', 'ingresoACuenta', 'dietas', 'indemnizacion', 'indemnizacionSujeta', 'ssTrabajador', 'irpf', 'embargos', 'anticipos', 'otrasDeducciones', 'liquido', 'ssEmpresa', 'costeTotal'] as const)
    .map((c) => mapeo[c])
    .filter((c): c is number => c !== undefined);
  const decimal = opciones.separadorDecimal ?? detectarSeparadorDecimal(datos.flatMap((f) => colsImporte.map((c) => f?.[c])));

  const periodoTitulo = periodoEnTitulo(filas, Math.max(fila, 0));
  const periodoOpciones = opciones.ejercicio && opciones.mes ? periodoOk(Number(opciones.ejercicio), Number(opciones.mes)) : null;
  if ((opciones.ejercicio || opciones.mes) && !periodoOpciones) throw badRequest('El mes o el ejercicio indicados no son válidos.');
  const opcionEspecie: BrutoConEspecie = opciones.brutoIncluyeEspecie ?? 'auto';

  const salida: FilaNomina[] = [];
  let ignoradas = 0;
  let negativas = 0;
  datos.forEach((f, k) => {
    const nFila = fila + 2 + k;
    if (!f || f.every((c) => texto(c) === '')) return;
    const celda = (c: CampoFichero) => (mapeo[c] === undefined ? undefined : f[mapeo[c]!]);
    const nifTexto = texto(celda('nif'));
    if (!nifTexto) {
      // Totales, subtotales, notas al pie: sin NIF no es la nomina de nadie.
      const conImportes = colsImporte.some((c) => {
        const v = parsearImporte(f[c], decimal);
        return Number.isFinite(v) && v !== 0;
      });
      if (!conImportes || esFilaTotal(f)) {
        ignoradas++;
        return;
      }
    }
    const errores: string[] = [];
    const filaAvisos: string[] = [];
    const imp = (c: CampoFichero, deduccion = false): number => {
      const v = celda(c);
      if (v === undefined) return 0;
      const n = parsearImporte(v, decimal);
      if (Number.isNaN(n)) {
        errores.push(`"${texto(v).slice(0, 20)}" no es un importe (${ETIQUETAS_CAMPOS[c]}).`);
        return 0;
      }
      if (n < 0 && deduccion) {
        negativas++;
        return -n;
      }
      return n;
    };

    const bruto = imp('bruto');
    const base = {
      dietasExentas: imp('dietas'),
      especieValoracion: imp('especie'),
      ingresoACuenta: imp('ingresoACuenta', true),
      indemnizacionExenta: imp('indemnizacion'),
      indemnizacionSujeta: imp('indemnizacionSujeta'),
      ssTrabajador: imp('ssTrabajador', true),
      irpf: imp('irpf', true),
      anticipos: imp('anticipos', true),
      embargos: imp('embargos', true),
      otrasDeducciones: imp('otrasDeducciones', true),
      liquido: imp('liquido'),
      ssEmpresa: imp('ssEmpresa', true),
    };
    const { importes, incluyeEspecie } = elegirLectura(base, bruto, opcionEspecie);
    if (importes.especieValoracion > 0 && opcionEspecie === 'auto') {
      filaAvisos.push(
        incluyeEspecie
          ? `El bruto incluye la especie (${fmtEuros(importes.especieValoracion)}): el dinerario es ${fmtEuros(importes.brutoDinerario)}.`
          : 'El bruto no incluye la especie.',
      );
    }
    if (importes.ingresoACuenta > 0) {
      filaAvisos.push(importes.ingresoACuentaRepercutido ? 'El ingreso a cuenta se descuenta al trabajador.' : 'El ingreso a cuenta lo asume la empresa (no se descuenta al trabajador).');
    }
    if (importes.dietasExentas > 0) filaAvisos.push('Las dietas se toman como exentas.');
    if (importes.indemnizacionExenta > 0) filaAvisos.push('La indemnización se toma como exenta: revísalo si una parte tributa.');

    // Mes: columna, titulo del fichero u opciones (y que no se contradigan).
    let periodo: Periodo | null = null;
    const vPeriodo = celda('periodo');
    if (vPeriodo !== undefined && texto(vPeriodo) !== '') {
      periodo = parsearPeriodo(vPeriodo, periodoOpciones?.ejercicio ?? periodoTitulo?.ejercicio);
      if (!periodo) errores.push(`No entiendo el mes "${texto(vPeriodo).slice(0, 20)}".`);
    }
    if (periodo && periodoOpciones && (periodo.ejercicio !== periodoOpciones.ejercicio || periodo.mes !== periodoOpciones.mes)) {
      errores.push(
        `El mes de la fila (${String(periodo.mes).padStart(2, '0')}/${periodo.ejercicio}) no es el indicado al importar (${String(periodoOpciones.mes).padStart(2, '0')}/${periodoOpciones.ejercicio}).`,
      );
    }
    periodo = periodo ?? periodoOpciones ?? periodoTitulo;

    const tipoTexto = celda('tipo');
    const tipo = parsearTipo(tipoTexto);
    if (!tipo) errores.push(`No entiendo el tipo de nómina "${texto(tipoTexto).slice(0, 20)}" (ordinaria, extra, atrasos, finiquito o complementaria).`);

    const pctRaw = celda('porcentajeIrpf');
    let porcentajeIrpf: number | null = null;
    if (pctRaw !== undefined && texto(pctRaw) !== '') {
      let p = parsearImporte(texto(pctRaw).replace('%', ''), decimal);
      // Excel guarda "15 %" como 0,15 si la celda tiene formato de porcentaje.
      if (typeof pctRaw === 'number' && p > 0 && p < 1) p = Math.round(p * 10000) / 100;
      porcentajeIrpf = Number.isFinite(p) ? p : null;
    }

    const coste = celda('costeTotal');
    const costeTotal = coste === undefined || texto(coste) === '' ? null : parsearImporte(coste, decimal);

    const devengoRaw = celda('ejercicioDevengo');
    let ejercicioDevengo: number | null = null;
    if (devengoRaw !== undefined && texto(devengoRaw) !== '') {
      const m = /^\s*(\d{4})(?:[.,]0+)?\s*$/.exec(texto(devengoRaw));
      if (m) ejercicioDevengo = Number(m[1]);
      else errores.push(`No entiendo el ejercicio de devengo "${texto(devengoRaw).slice(0, 20)}" (un año, por ejemplo 2025).`);
    }

    const nombre = texto(celda('nombre'));
    const apellidos = [texto(celda('apellidos')), texto(celda('apellido2'))].filter(Boolean).join(' ');
    const nafTexto = texto(celda('naf'));

    salida.push(
      validarFilaNomina({
        fila: nFila,
        nif: normalizarNif(nifTexto),
        nombre: nombre.slice(0, 120),
        apellidos: apellidos.slice(0, 120),
        naf: nafTexto ? normalizarNaf(celda('naf')) : null,
        ejercicio: periodo?.ejercicio ?? NaN,
        mes: periodo?.mes ?? NaN,
        tipo: tipo ?? 'ORDINARIA',
        ...importes,
        porcentajeIrpf,
        ejercicioDevengo,
        costeTotal: costeTotal !== null && Number.isFinite(costeTotal) ? costeTotal : null,
        cuadre: cuadreNomina(importes),
        errores,
        avisos: filaAvisos,
      }),
    );
  });

  if (negativas) avisos.push(`${negativas} deducción(es) venían en negativo: se han tomado en positivo.`);
  if (salida.length === 0) avisos.push('El fichero no tiene ninguna nómina.');
  if (periodoTitulo && periodoOpciones && (periodoTitulo.ejercicio !== periodoOpciones.ejercicio || periodoTitulo.mes !== periodoOpciones.mes)) {
    avisos.push(
      `El título del fichero habla de ${String(periodoTitulo.mes).padStart(2, '0')}/${periodoTitulo.ejercicio}, pero se importa como ${String(periodoOpciones.mes).padStart(2, '0')}/${periodoOpciones.ejercicio}.`,
    );
  }

  return {
    formato,
    filaCabecera: fila + 1,
    columnas: describirColumnas(filas, fila),
    mapeo,
    separadorDecimal: decimal,
    periodoTitulo,
    filas: salida,
    filasIgnoradas: ignoradas,
    avisos,
  };
}

/** Lee el Excel o CSV de nominas. */
export function leerNominas(contenido: Buffer, nombreArchivo: string, opciones: OpcionesLecturaNominas = {}): LecturaNominas {
  const { formato, filas } = leerFilasArchivo(contenido, nombreArchivo);
  return leerNominasDeFilas(filas, opciones, formato);
}

/** Comprueba que no haya dos filas para el mismo trabajador, mes y tipo. */
export function marcarRepetidas(filas: FilaNomina[]): void {
  const vistas = new Map<string, number>();
  for (const f of filas) {
    if (!f.nif || !Number.isInteger(f.mes)) continue;
    const k = `${f.nif}|${f.ejercicio}|${f.mes}|${f.tipo}`;
    const previa = vistas.get(k);
    if (previa !== undefined) {
      f.errores.push(`Está repetida: la fila ${previa} es la misma nómina (mismo NIF, mes y tipo). Si es una paga extra aparte, indica el tipo.`);
    } else vistas.set(k, f.fila);
  }
}

// ---------------------------------------------------------------------------
// Filas recibidas como JSON (vista previa editada en la pantalla)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return 0;
  return typeof v === 'number' ? v : NaN;
};

/** Filas de nominas ya mapeadas que manda el cliente. */
export function filasDesdeJson(valor: unknown): FilaNomina[] {
  let lista = valor;
  if (typeof lista === 'string') {
    try {
      lista = JSON.parse(lista);
    } catch {
      throw badRequest('Las nóminas enviadas no son un JSON válido.');
    }
  }
  if (!Array.isArray(lista)) throw badRequest('"filas" tiene que ser una lista de nóminas.');
  if (lista.length === 0) throw badRequest('No hay ninguna nómina que importar.');
  if (lista.length > 5000) throw badRequest('Demasiadas nóminas en una sola importación (máximo 5.000).');
  return lista.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const errores: string[] = [];
    const tipo = parsearTipo(r.tipo);
    if (!tipo) errores.push(`Tipo de nómina no válido: ${String(r.tipo)}.`);
    const importes: ImportesNomina = {
      brutoDinerario: num(r.brutoDinerario),
      dietasExentas: num(r.dietasExentas),
      especieValoracion: num(r.especieValoracion),
      ingresoACuenta: num(r.ingresoACuenta),
      ingresoACuentaRepercutido: r.ingresoACuentaRepercutido === true,
      indemnizacionExenta: num(r.indemnizacionExenta),
      indemnizacionSujeta: num(r.indemnizacionSujeta),
      ssTrabajador: num(r.ssTrabajador),
      irpf: num(r.irpf),
      anticipos: num(r.anticipos),
      embargos: num(r.embargos),
      otrasDeducciones: num(r.otrasDeducciones),
      liquido: num(r.liquido),
      ssEmpresa: num(r.ssEmpresa),
    };
    for (const [k, v] of Object.entries(importes)) {
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) errores.push(`"${ETIQUETAS_IMPORTES[k] ?? k}" tiene más de dos decimales.`);
    }
    const pct = r.porcentajeIrpf === undefined || r.porcentajeIrpf === null || r.porcentajeIrpf === '' ? null : Number(r.porcentajeIrpf);
    const devengo = r.ejercicioDevengo === undefined || r.ejercicioDevengo === null || r.ejercicioDevengo === '' ? null : Number(r.ejercicioDevengo);
    return validarFilaNomina({
      fila: Number.isInteger(r.fila) ? (r.fila as number) : i + 1,
      nif: normalizarNif(r.nif),
      nombre: String(r.nombre ?? '').trim().slice(0, 120),
      apellidos: String(r.apellidos ?? '').trim().slice(0, 120),
      naf: r.naf ? normalizarNaf(r.naf) : null,
      ejercicio: Number(r.ejercicio),
      mes: Number(r.mes),
      tipo: tipo ?? 'ORDINARIA',
      ...importes,
      porcentajeIrpf: pct,
      ejercicioDevengo: devengo,
      costeTotal: null,
      cuadre: cuadreNomina(importes),
      errores,
      avisos: [],
    });
  });
}

/** Titulos de la plantilla (los reconoce el lector). */
export const TITULOS_PLANTILLA: Array<[CampoFichero, string]> = [
  ['nombre', 'Trabajador'],
  ['apellidos', 'Apellidos'],
  ['nif', 'NIF'],
  ['naf', 'Nº afiliación SS'],
  ['periodo', 'Mes'],
  ['tipo', 'Tipo'],
  ['ejercicioDevengo', 'Ejercicio devengo'],
  ['bruto', 'Total devengado'],
  ['especie', 'Retribución en especie'],
  ['ingresoACuenta', 'Ingreso a cuenta'],
  ['dietas', 'Dietas'],
  ['indemnizacion', 'Indemnización'],
  ['ssTrabajador', 'SS trabajador'],
  ['irpf', 'IRPF'],
  ['porcentajeIrpf', '% IRPF'],
  ['embargos', 'Embargos'],
  ['anticipos', 'Anticipos'],
  ['otrasDeducciones', 'Otras deducciones'],
  ['liquido', 'Líquido a percibir'],
  ['ssEmpresa', 'SS empresa'],
  ['costeTotal', 'Coste total'],
];
