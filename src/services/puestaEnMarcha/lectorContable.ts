/**
 * Lectura de ficheros contables de otros programas (A3, Contasol, Sage, Holded,
 * FacturaScripts...) para la puesta en marcha: balance de sumas y saldos y
 * libro diario / mayor. Funciones puras, sin base de datos.
 *
 * Cada programa exporta a su manera, asi que nada es fijo:
 *  - la fila de titulos se busca entre las primeras filas;
 *  - las columnas se reconocen por su titulo (y se pueden fijar a mano con `mapeo`);
 *  - los importes admiten coma o punto decimal, miles, signo delante o detras,
 *    parentesis y sufijo D/H;
 *  - los codigos de cuenta pueden tener de 3 a 10 digitos (con puntos o espacios).
 */
import { leerFilasArchivo } from '../extractoBancario.service';
import { badRequest } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Utilidades de celdas
// ---------------------------------------------------------------------------

/** Texto de una celda, sin espacios sobrantes. */
export function texto(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/ /g, ' ').trim();
}

/** Titulo normalizado: minusculas, sin acentos ni signos. "Nº Asiento" -> "n asiento". */
export function normalizarTitulo(v: unknown): string {
  return texto(v)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/º|ª/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Letra de columna de Excel: 0 -> A, 27 -> AB. */
export function letraColumna(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export type SeparadorDecimal = ',' | '.';

/**
 * Decide el separador decimal mirando todos los importes en texto de una
 * columna: "1.234,56" vota coma y "1,234.56" vota punto. Si no hay pistas,
 * coma (lo normal en Espana).
 */
export function detectarSeparadorDecimal(valores: unknown[]): SeparadorDecimal {
  let coma = 0;
  let punto = 0;
  for (const v of valores) {
    if (typeof v !== 'string') continue;
    const s = v.replace(/[^\d.,]/g, '');
    if (!s) continue;
    const ultComa = s.lastIndexOf(',');
    const ultPunto = s.lastIndexOf('.');
    if (ultComa >= 0 && ultPunto >= 0) {
      if (ultComa > ultPunto) coma++;
      else punto++;
    } else if (ultComa >= 0) {
      // "1,5" o "1234,56" -> coma decimal; "1,234,567" -> miles
      if ((s.match(/,/g) ?? []).length === 1 && !/,\d{3}$/.test(s)) coma++;
      else if ((s.match(/,/g) ?? []).length === 1) coma += 0.5; // "1,234": ambiguo, se inclina a coma
      else punto++;
    } else if (ultPunto >= 0) {
      if ((s.match(/\./g) ?? []).length === 1 && !/\.\d{3}$/.test(s)) punto++;
      else coma++; // "1.234" o "1.234.567": miles con punto
    }
  }
  return punto > coma ? '.' : ',';
}

/**
 * Importe de una celda. Admite numeros de Excel y textos como "1.234,56",
 * "-1.234,56", "1.234,56-", "(1.234,56)", "1.234,56 €", "1.234,56 D" o "H".
 * Vacio -> 0. Si no es un importe -> NaN.
 */
export function parsearImporte(v: unknown, decimal: SeparadorDecimal = ','): number {
  if (typeof v === 'number') return Number.isFinite(v) ? round2(v) : NaN;
  let s = texto(v);
  if (!s) return 0;
  let signo = 1;
  s = s.replace(/€|eur(os)?/gi, '').replace(/\s+/g, ' ').trim();
  // Sufijo deudor/acreedor: "1.234,56 D" / "1.234,56 H" (tambien DR/CR).
  const sufijo = /^(.*?)\s*\b(D|H|DR|CR|Db|Cr)$/i.exec(s);
  if (sufijo && /\d/.test(sufijo[1])) {
    const k = sufijo[2].toUpperCase();
    if (k === 'H' || k === 'CR') signo = -signo;
    s = sufijo[1].trim();
  }
  if (/^\(.*\)$/.test(s)) {
    signo = -signo;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    signo = -signo;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('-')) {
    signo = -signo;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/\s/g, '');
  if (!/^[\d.,]+$/.test(s)) return NaN;
  const miles = decimal === ',' ? '.' : ',';
  s = s.split(miles).join('');
  if (decimal === ',') s = s.replace(',', '.');
  if ((s.match(/\./g) ?? []).length > 1) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? round2(signo * n) : NaN;
}

/**
 * Codigo de cuenta de una celda: solo digitos, de 3 a 10. Quita puntos,
 * espacios y guiones ("430.0001" -> "4300001"). Si no lo es, null.
 */
export function normalizarCuenta(v: unknown): string | null {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return null;
    v = String(v);
  }
  const s = texto(v);
  if (!/^\d[\d.\s-]*$/.test(s)) return null;
  const codigo = s.replace(/[.\s-]/g, '');
  return /^\d{3,10}$/.test(codigo) ? codigo : null;
}

/** "4300000001 Cliente S.L." -> { codigo, nombre }, o null si no empieza por una cuenta. */
export function cuentaYNombre(v: unknown): { codigo: string; nombre: string } | null {
  const s = texto(v);
  const m = /^(?:(?:sub)?cuenta|cta\.?)?\s*:?\s*(\d[\d.]{2,14})(?:\s*[-–:]\s*|\s+|$)(.*)$/i.exec(s);
  if (!m) return null;
  const codigo = normalizarCuenta(m[1]);
  return codigo ? { codigo, nombre: m[2].trim() } : null;
}

/**
 * Fecha de una celda en formato yyyy-mm-dd. Admite el numero de serie de
 * Excel, Date, "dd/mm/aaaa", "dd-mm-aa", "dd.mm.aaaa" y "aaaa-mm-dd".
 */
export function parsearFecha(v: unknown): string | null {
  const valida = (y: number, m: number, d: number): string | null => {
    if (y < 100) y += y < 70 ? 2000 : 1900;
    const f = new Date(Date.UTC(y, m - 1, d));
    if (f.getUTCFullYear() !== y || f.getUTCMonth() !== m - 1 || f.getUTCDate() !== d) return null;
    return f.toISOString().slice(0, 10);
  };
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null; // 1954..2119
    const f = new Date(Math.round((v - 25569) * 86400000));
    return f.toISOString().slice(0, 10);
  }
  const s = texto(v);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return valida(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) return valida(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

// ---------------------------------------------------------------------------
// Columnas
// ---------------------------------------------------------------------------

export type CampoBalance = 'cuenta' | 'nombre' | 'debe' | 'haber' | 'saldoDeudor' | 'saldoAcreedor' | 'saldo';
export type CampoDiario = 'fecha' | 'asiento' | 'cuenta' | 'nombre' | 'concepto' | 'debe' | 'haber' | 'importe' | 'signo';
export type Mapeo<C extends string> = Partial<Record<C, number>>;

/** Patrones por campo, en orden de prioridad (los mas concretos primero). */
const PATRONES_BALANCE: Array<[CampoBalance, RegExp]> = [
  ['saldoDeudor', /^(saldos? )?deudor(es)?$|^saldo deudor/],
  ['saldoAcreedor', /^(saldos? )?acreedor(es)?$|^saldo acreedor/],
  ['debe', /^(sumas? |total |acumulado |movimientos? )?(debe|cargos?|debit)( acumulado| periodo| ejercicio)?$/],
  ['haber', /^(sumas? |total |acumulado |movimientos? )?(haber|abonos?|credit)( acumulado| periodo| ejercicio)?$/],
  ['saldo', /^(saldo|saldo final|saldo actual|saldo cierre|saldo al cierre|saldo a fecha.*|saldo periodo|saldo ejercicio|importe|importe saldo|balance|saldo total|total)$/],
  ['cuenta', /^(cuenta|subcuenta|cod|codigo|cta|n cuenta|num cuenta|numero cuenta|codigo cuenta|cod cuenta|codigo subcuenta|cod subcuenta|codsubcuenta|account|code)$/],
  ['nombre', /^(descripcion|nombre|titulo|denominacion|concepto|nombre cuenta|descripcion cuenta|nombre subcuenta|descripcion subcuenta|titulo cuenta|description|name)$/],
];

const PATRONES_DIARIO: Array<[CampoDiario, RegExp]> = [
  ['fecha', /^(fecha|f asiento|fecha asiento|fecha apunte|fecha contable|date)$/],
  ['asiento', /^(asiento|n asiento|num asiento|numero asiento|n asto|asto|n de asiento|numero|n|entry|id asiento|asiento n)$/],
  ['cuenta', /^(cuenta|subcuenta|cod|codigo|cta|n cuenta|codigo cuenta|cod cuenta|codigo subcuenta|cod subcuenta|codsubcuenta|account)$/],
  ['nombre', /^(nombre|titulo|nombre cuenta|descripcion cuenta|nombre subcuenta|descripcion subcuenta|titulo cuenta|denominacion)$/],
  ['concepto', /^(concepto|descripcion|detalle|texto|glosa|comentario|concepto apunte|description)$/],
  ['debe', /^(debe|cargo|cargos|debit|importe debe)$/],
  ['haber', /^(haber|abono|abonos|credit|importe haber)$/],
  ['importe', /^(importe|importe apunte|amount|valor)$/],
  ['signo', /^(d h|dh|signo|debe haber|lado)$/],
];

/** Asigna columnas a campos por su titulo. Cada columna, a un solo campo. */
function mapearTitulos<C extends string>(titulos: string[], patrones: Array<[C, RegExp]>): Mapeo<C> {
  const mapeo: Mapeo<C> = {};
  const usadas = new Set<number>();
  for (const [campo, re] of patrones) {
    const idx = titulos.findIndex((t, i) => !usadas.has(i) && t !== '' && re.test(t));
    if (idx >= 0) {
      mapeo[campo] = idx;
      usadas.add(idx);
    }
  }
  return mapeo;
}

/**
 * Balance de sumas y saldos con dos pares Debe/Haber (sumas y saldos con el
 * mismo titulo): el segundo par son los saldos.
 */
function ajustarDoblePar(titulos: string[], mapeo: Mapeo<CampoBalance>): void {
  if (mapeo.saldoDeudor !== undefined || mapeo.saldoAcreedor !== undefined || mapeo.saldo !== undefined) return;
  const debes = titulos.map((t, i) => (/^(debe|deudor)$/.test(t) ? i : -1)).filter((i) => i >= 0);
  const haberes = titulos.map((t, i) => (/^(haber|acreedor)$/.test(t) ? i : -1)).filter((i) => i >= 0);
  if (debes.length >= 2 && haberes.length >= 2) {
    mapeo.debe = debes[0];
    mapeo.haber = haberes[0];
    mapeo.saldoDeudor = debes[debes.length - 1];
    mapeo.saldoAcreedor = haberes[haberes.length - 1];
  }
}

const esMapeoBalanceUtil = (m: Mapeo<CampoBalance>) =>
  m.cuenta !== undefined &&
  (m.saldo !== undefined || (m.saldoDeudor !== undefined && m.saldoAcreedor !== undefined) || (m.debe !== undefined && m.haber !== undefined));

const esMapeoDiarioUtil = (m: Mapeo<CampoDiario>) =>
  m.fecha !== undefined && ((m.debe !== undefined && m.haber !== undefined) || m.importe !== undefined);

interface Cabecera<C extends string> {
  fila: number; // indice 0-based en el fichero; -1 si no hay titulos
  titulos: string[];
  mapeo: Mapeo<C>;
}

function buscarCabecera<C extends string>(
  filas: unknown[][],
  patrones: Array<[C, RegExp]>,
  util: (m: Mapeo<C>) => boolean,
  ajuste?: (titulos: string[], m: Mapeo<C>) => void,
): Cabecera<C> | null {
  let mejor: (Cabecera<C> & { puntos: number }) | null = null;
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const titulos = (filas[i] ?? []).map(normalizarTitulo);
    const mapeo = mapearTitulos(titulos, patrones);
    ajuste?.(titulos, mapeo);
    if (!util(mapeo)) continue;
    const puntos = Object.keys(mapeo).length;
    if (!mejor || puntos > mejor.puntos) mejor = { fila: i, titulos, mapeo, puntos };
  }
  return mejor;
}

/** Descripcion de las columnas del fichero para que el usuario pueda corregir el mapeo. */
export interface ColumnaFichero {
  indice: number;
  letra: string;
  titulo: string;
  ejemplo: string;
}

function describirColumnas(filas: unknown[][], filaCabecera: number): ColumnaFichero[] {
  const ancho = Math.max(0, ...filas.slice(0, 200).map((f) => (f ?? []).length));
  const cab = filaCabecera >= 0 ? filas[filaCabecera] ?? [] : [];
  const out: ColumnaFichero[] = [];
  for (let i = 0; i < ancho; i++) {
    let ejemplo = '';
    for (let r = filaCabecera + 1; r < filas.length && r < filaCabecera + 50; r++) {
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

/** Valida un mapeo que llega del cliente: indices enteros dentro del ancho. */
function limpiarMapeo<C extends string>(mapeo: unknown, campos: readonly C[]): Mapeo<C> | null {
  if (!mapeo || typeof mapeo !== 'object') return null;
  const out: Mapeo<C> = {};
  for (const c of campos) {
    const v = (mapeo as Record<string, unknown>)[c];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isInteger(n) && n >= 0 && n < 200) out[c] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Naturaleza de las cuentas (para balances que dan los saldos en positivo)
// ---------------------------------------------------------------------------

/**
 * true si la cuenta tiene saldo acreedor por naturaleza en el PGC (patrimonio
 * neto, pasivo, ingresos y correcciones de valor del activo). Solo se usa
 * cuando el fichero da todos los saldos en positivo.
 */
export function esAcreedoraPorNaturaleza(codigo: string): boolean {
  const g = codigo[0];
  if (g === '1' || g === '7') return true;
  const acreedoras = [
    '28', '29', '39', '40', '41', '437', '438', '465', '466', '475', '476', '477', '479',
    '485', '49', '50', '51', '52', '560', '561', '569', '59',
  ];
  return acreedoras.some((p) => codigo.startsWith(p));
}

// ---------------------------------------------------------------------------
// Balance de sumas y saldos
// ---------------------------------------------------------------------------

export type ConvencionSigno = 'auto' | 'deudor' | 'naturaleza';

export interface CuentaSaldo {
  codigo: string;
  nombre: string;
  /** Saldo deudor (debe - haber): positivo deudor, negativo acreedor. */
  saldo: number;
}

export interface FilaDescartada {
  fila: number; // 1-based, como en Excel
  motivo: string;
}

export interface LecturaBalance {
  formato: string;
  filaCabecera: number; // 1-based; 0 si no hay titulos
  columnas: ColumnaFichero[];
  mapeo: Mapeo<CampoBalance>;
  separadorDecimal: SeparadorDecimal;
  convencionSigno: 'deudor' | 'naturaleza';
  cuentas: CuentaSaldo[];
  /** Cuentas de nivel superior (grupo, cuenta de 3 digitos...) que el fichero trae ademas de sus subcuentas. */
  agregadasOmitidas: string[];
  filasDescartadas: FilaDescartada[];
  avisos: string[];
}

export interface OpcionesLectura<C extends string> {
  mapeo?: unknown;
  filaCabecera?: number; // 1-based
  convencionSigno?: ConvencionSigno;
  separadorDecimal?: SeparadorDecimal;
  /** Solo para tipar el mapeo por campos. */
  _campos?: C;
}

const CAMPOS_BALANCE: readonly CampoBalance[] = ['cuenta', 'nombre', 'debe', 'haber', 'saldoDeudor', 'saldoAcreedor', 'saldo'];
const CAMPOS_DIARIO: readonly CampoDiario[] = ['fecha', 'asiento', 'cuenta', 'nombre', 'concepto', 'debe', 'haber', 'importe', 'signo'];

/** Suma de saldos deudores y acreedores. */
export function totalesSaldos(cuentas: CuentaSaldo[]): { deudor: number; acreedor: number; diferencia: number } {
  let deudor = 0;
  let acreedor = 0;
  for (const c of cuentas) {
    if (c.saldo > 0) deudor += c.saldo;
    else acreedor -= c.saldo;
  }
  deudor = round2(deudor);
  acreedor = round2(acreedor);
  return { deudor, acreedor, diferencia: round2(deudor - acreedor) };
}

function resolverCabecera<C extends string>(
  filas: unknown[][],
  opciones: OpcionesLectura<C>,
  campos: readonly C[],
  patrones: Array<[C, RegExp]>,
  util: (m: Mapeo<C>) => boolean,
  ajuste?: (titulos: string[], m: Mapeo<C>) => void,
  queEs = 'el fichero',
): { fila: number; mapeo: Mapeo<C> } {
  const manual = limpiarMapeo(opciones.mapeo, campos);
  if (manual && Object.keys(manual).length > 0) {
    let fila = opciones.filaCabecera !== undefined ? Number(opciones.filaCabecera) - 1 : -1;
    if (!(Number.isInteger(fila) && fila >= -1 && fila < filas.length)) fila = -1;
    if (fila === -1 && opciones.filaCabecera === undefined) {
      // Sin fila indicada: la que se detecte, o ninguna.
      fila = buscarCabecera(filas, patrones, (m) => Object.keys(m).length >= 2)?.fila ?? -1;
    }
    if (!util(manual)) {
      throw badRequest(`Faltan columnas en el mapeo de ${queEs}: indica al menos ${queEs === 'el diario' ? 'la fecha' : 'la cuenta'} y los importes (Debe y Haber, o el saldo o importe).`, {
        columnas: describirColumnas(filas, fila),
        mapeo: manual,
        necesitaMapeo: true,
      });
    }
    return { fila, mapeo: manual };
  }
  const cab = buscarCabecera(filas, patrones, util, ajuste);
  if (!cab) {
    throw badRequest(
      `No encuentro la fila de títulos de ${queEs} (por ejemplo "Cuenta", "Debe", "Haber", "Saldo"). Indica a mano qué columna es cada dato.`,
      { columnas: describirColumnas(filas, -1), necesitaMapeo: true },
    );
  }
  return { fila: cab.fila, mapeo: cab.mapeo };
}

/** Lee un balance de sumas y saldos (o un balance por subcuentas) ya convertido en filas. */
export function leerBalanceDeFilas(filas: unknown[][], opciones: OpcionesLectura<CampoBalance> = {}, formato = 'xlsx'): LecturaBalance {
  const { fila, mapeo } = resolverCabecera(filas, opciones, CAMPOS_BALANCE, PATRONES_BALANCE, esMapeoBalanceUtil, ajustarDoblePar, 'el balance');
  const avisos: string[] = [];
  const descartadas: FilaDescartada[] = [];

  const colsImporte = (['debe', 'haber', 'saldoDeudor', 'saldoAcreedor', 'saldo'] as const)
    .map((c) => mapeo[c])
    .filter((c): c is number => c !== undefined);
  const datos = filas.slice(fila + 1);
  const decimal = opciones.separadorDecimal ?? detectarSeparadorDecimal(datos.flatMap((f) => colsImporte.map((c) => f?.[c])));

  const porCodigo = new Map<string, CuentaSaldo>();
  let duplicadas = 0;
  let saldoUnico = false;
  datos.forEach((f, k) => {
    const nFila = fila + 2 + k;
    if (!f || f.every((c) => texto(c) === '')) return;
    let codigo = normalizarCuenta(f[mapeo.cuenta!]);
    let nombre = mapeo.nombre !== undefined ? texto(f[mapeo.nombre]) : '';
    if (!codigo) {
      const cn = cuentaYNombre(f[mapeo.cuenta!]);
      if (cn) {
        codigo = cn.codigo;
        nombre = nombre || cn.nombre;
      }
    }
    if (!codigo) {
      const t = texto(f[mapeo.cuenta!]);
      // Titulos de grupo, totales y lineas en blanco: se ignoran sin avisar.
      if (t && !/^(total|suma|grupo|subgrupo|\d{1,2}$)/i.test(normalizarTitulo(t))) {
        descartadas.push({ fila: nFila, motivo: `"${t.slice(0, 30)}" no es un código de cuenta` });
      }
      return;
    }
    const imp = (c?: number) => (c === undefined ? 0 : parsearImporte(f[c], decimal));
    let saldo: number;
    if (mapeo.saldoDeudor !== undefined || mapeo.saldoAcreedor !== undefined) {
      const sd = imp(mapeo.saldoDeudor);
      const sa = imp(mapeo.saldoAcreedor);
      saldo = round2(sd - sa);
    } else if (mapeo.saldo !== undefined) {
      saldo = imp(mapeo.saldo);
      saldoUnico = true;
    } else {
      saldo = round2(imp(mapeo.debe) - imp(mapeo.haber));
    }
    if (Number.isNaN(saldo)) {
      descartadas.push({ fila: nFila, motivo: `Importe ilegible en la cuenta ${codigo}` });
      return;
    }
    const previa = porCodigo.get(codigo);
    if (previa) {
      duplicadas++;
      previa.saldo = round2(previa.saldo + saldo);
      if (!previa.nombre && nombre) previa.nombre = nombre;
    } else {
      porCodigo.set(codigo, { codigo, nombre, saldo });
    }
  });

  if (duplicadas) avisos.push(`${duplicadas} cuenta(s) aparecían repetidas: se han sumado sus saldos.`);

  // Si el fichero trae a la vez la cuenta 430 y sus subcuentas 4300000001...,
  // la de nivel superior es un total: se quita para no contar dos veces.
  // Ordenados, las subcuentas de una cuenta van justo detras de ella: basta con
  // mirar la siguiente (antes se comparaba cada una con todas, y un balance de
  // decenas de miles de subcuentas tardaba decenas de segundos).
  const codigos = [...porCodigo.keys()].sort();
  const agregadas = codigos.filter((c, i) => {
    const sig = codigos[i + 1];
    return sig !== undefined && sig.length > c.length && sig.startsWith(c);
  });
  for (const c of agregadas) porCodigo.delete(c);
  if (agregadas.length) {
    avisos.push(`Se han ignorado ${agregadas.length} cuenta(s) de nivel superior (${agregadas.slice(0, 5).join(', ')}${agregadas.length > 5 ? '...' : ''}) porque el fichero trae también sus subcuentas.`);
  }

  let cuentas = [...porCodigo.values()].filter((c) => aCentimos(c.saldo) !== 0);
  cuentas.sort((a, b) => a.codigo.localeCompare(b.codigo));

  // Convencion de signo: solo importa cuando hay una unica columna de saldo.
  let convencion: 'deudor' | 'naturaleza' = 'deudor';
  const pedida = opciones.convencionSigno ?? 'auto';
  if (saldoUnico) {
    if (pedida === 'naturaleza') convencion = 'naturaleza';
    else if (pedida === 'auto') {
      const hayNegativos = cuentas.some((c) => c.saldo < 0);
      const conNaturaleza = cuentas.map((c) => ({ ...c, saldo: esAcreedoraPorNaturaleza(c.codigo) ? -Math.abs(c.saldo) : Math.abs(c.saldo) }));
      if (!hayNegativos && cuentas.length > 0) {
        convencion = 'naturaleza';
      } else if (aCentimos(totalesSaldos(cuentas).diferencia) !== 0 && aCentimos(totalesSaldos(conNaturaleza).diferencia) === 0) {
        convencion = 'naturaleza';
      }
    }
    if (convencion === 'naturaleza') {
      cuentas = cuentas.map((c) => ({ ...c, saldo: esAcreedoraPorNaturaleza(c.codigo) ? round2(-c.saldo) : c.saldo }));
      avisos.push('Los saldos vienen en positivo: se han interpretado según la naturaleza de cada cuenta (activo y gastos deudoras; patrimonio, pasivo e ingresos acreedoras). Revisa el cuadre.');
    }
  }

  if (cuentas.length === 0) {
    throw badRequest('No he encontrado ninguna cuenta con saldo en el fichero. Revisa que sea un balance por cuentas o subcuentas.', {
      columnas: describirColumnas(filas, fila),
      mapeo,
      necesitaMapeo: true,
    });
  }

  return {
    formato,
    filaCabecera: fila + 1,
    columnas: describirColumnas(filas, fila),
    mapeo,
    separadorDecimal: decimal,
    convencionSigno: convencion,
    cuentas,
    agregadasOmitidas: agregadas,
    filasDescartadas: descartadas.slice(0, 50),
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Libro diario / mayor
// ---------------------------------------------------------------------------

export interface ApunteLeido {
  fila: number;
  fecha: string;
  asiento: string;
  cuenta: string;
  nombre: string;
  concepto: string;
  debe: number;
  haber: number;
}

export interface LecturaDiario {
  formato: string;
  filaCabecera: number;
  columnas: ColumnaFichero[];
  mapeo: Mapeo<CampoDiario>;
  separadorDecimal: SeparadorDecimal;
  /** true si la cuenta sale de lineas de encabezado ("Cuenta 4300001 Cliente") y no de una columna. */
  mayorPorCuenta: boolean;
  apuntes: ApunteLeido[];
  filasDescartadas: FilaDescartada[];
  avisos: string[];
}

function esDebe(v: unknown): boolean | null {
  const t = normalizarTitulo(v);
  if (!t) return null;
  if (/^(d|debe|cargo|c|debit|dr)$/.test(t)) return true;
  if (/^(h|haber|abono|a|credit|cr)$/.test(t)) return false;
  return null;
}

/** Lee un libro diario o un mayor ya convertido en filas. */
export function leerDiarioDeFilas(filas: unknown[][], opciones: OpcionesLectura<CampoDiario> = {}, formato = 'xlsx'): LecturaDiario {
  const { fila, mapeo } = resolverCabecera(filas, opciones, CAMPOS_DIARIO, PATRONES_DIARIO, esMapeoDiarioUtil, undefined, 'el diario');
  const avisos: string[] = [];
  const descartadas: FilaDescartada[] = [];
  const colsImporte = (['debe', 'haber', 'importe'] as const).map((c) => mapeo[c]).filter((c): c is number => c !== undefined);
  const datos = filas.slice(fila + 1);
  const decimal = opciones.separadorDecimal ?? detectarSeparadorDecimal(datos.flatMap((f) => colsImporte.map((c) => f?.[c])));
  const mayorPorCuenta = mapeo.cuenta === undefined;

  const apuntes: ApunteLeido[] = [];
  let cuentaActual: { codigo: string; nombre: string } | null = null;
  let asientoAnterior = '';
  let fechaAnterior = '';

  datos.forEach((f, k) => {
    const nFila = fila + 2 + k;
    if (!f || f.every((c) => texto(c) === '')) return;
    const fecha = parsearFecha(f[mapeo.fecha!]);

    if (!fecha) {
      // Encabezado de cuenta en un mayor: "Cuenta: 4300000001 Cliente S.L."
      if (mayorPorCuenta) {
        for (const c of f) {
          const cn = cuentaYNombre(c);
          if (cn && texto(c).length >= cn.codigo.length) {
            cuentaActual = cn;
            break;
          }
        }
      }
      return; // titulos, "Saldo anterior", "Suma y sigue", totales...
    }

    let cuenta: string | null = null;
    let nombre = mapeo.nombre !== undefined ? texto(f[mapeo.nombre]) : '';
    if (mapeo.cuenta !== undefined) {
      cuenta = normalizarCuenta(f[mapeo.cuenta]);
      if (!cuenta) {
        const cn = cuentaYNombre(f[mapeo.cuenta]);
        if (cn) {
          cuenta = cn.codigo;
          nombre = nombre || cn.nombre;
        }
      }
    } else if (cuentaActual) {
      cuenta = (cuentaActual as { codigo: string }).codigo;
      nombre = nombre || (cuentaActual as { nombre: string }).nombre;
    }
    const concepto = mapeo.concepto !== undefined ? texto(f[mapeo.concepto]) : '';
    if (/^(saldo anterior|saldo inicial|suma y sigue|sumas? y saldos?|total)/i.test(normalizarTitulo(concepto))) return;
    if (!cuenta) {
      descartadas.push({ fila: nFila, motivo: 'Sin código de cuenta' });
      return;
    }

    let debe = 0;
    let haber = 0;
    if (mapeo.debe !== undefined && mapeo.haber !== undefined) {
      debe = parsearImporte(f[mapeo.debe], decimal);
      haber = parsearImporte(f[mapeo.haber], decimal);
    } else {
      const importe = parsearImporte(f[mapeo.importe!], decimal);
      const lado = mapeo.signo !== undefined ? esDebe(f[mapeo.signo]) : null;
      if (lado === true) debe = importe;
      else if (lado === false) haber = importe;
      else if (importe >= 0) debe = importe;
      else haber = -importe;
    }
    if (Number.isNaN(debe) || Number.isNaN(haber)) {
      descartadas.push({ fila: nFila, motivo: `Importe ilegible en la cuenta ${cuenta}` });
      return;
    }
    // Importes negativos o con debe y haber a la vez: se deja el neto en su lado.
    const neto = round2(debe - haber);
    if (aCentimos(neto) === 0) return;

    let asiento = mapeo.asiento !== undefined ? texto(f[mapeo.asiento]) : '';
    // Algunos programas solo ponen el numero en la primera linea del asiento.
    if (mapeo.asiento !== undefined && !asiento && fecha === fechaAnterior) asiento = asientoAnterior;
    asientoAnterior = asiento;
    fechaAnterior = fecha;

    apuntes.push({
      fila: nFila,
      fecha,
      asiento,
      cuenta,
      nombre,
      concepto,
      debe: neto > 0 ? neto : 0,
      haber: neto < 0 ? -neto : 0,
    });
  });

  if (apuntes.length === 0) {
    throw badRequest('No he encontrado ningún apunte (fecha, cuenta e importe) en el fichero.', {
      columnas: describirColumnas(filas, fila),
      mapeo,
      necesitaMapeo: true,
    });
  }
  if (mayorPorCuenta) avisos.push('El fichero no tiene columna de cuenta: se ha tomado de las líneas de encabezado de cada cuenta (formato de listado de mayor).');

  return {
    formato,
    filaCabecera: fila + 1,
    columnas: describirColumnas(filas, fila),
    mapeo,
    separadorDecimal: decimal,
    mayorPorCuenta,
    apuntes,
    filasDescartadas: descartadas.slice(0, 50),
    avisos,
  };
}

export type Agrupacion = 'auto' | 'asiento' | 'fecha' | 'mes';

export interface AsientoAgrupado {
  clave: string;
  fecha: string;
  numeroOriginal: string;
  concepto: string;
  lineas: Array<{ cuenta: string; nombre: string; concepto: string; debe: number; haber: number }>;
  debe: number;
  haber: number;
  cuadra: boolean;
  /** APERTURA / REGULARIZACION / CIERRE si el concepto lo dice: no se importan por defecto. */
  especial: 'APERTURA' | 'REGULARIZACION' | 'CIERRE' | null;
}

/**
 * Agrupa los apuntes en asientos: por numero de asiento si el fichero lo trae;
 * si no (mayor sin contrapartida), por fecha. 'mes' junta todo el mes en un
 * asiento resumen (util si el fichero es un mayor parcial que solo cuadra por meses).
 */
export function agruparAsientos(apuntes: ApunteLeido[], agrupacion: Agrupacion = 'auto'): { asientos: AsientoAgrupado[]; agrupacion: Exclude<Agrupacion, 'auto'> } {
  const hayNumero = apuntes.some((a) => a.asiento !== '');
  const modo: Exclude<Agrupacion, 'auto'> = agrupacion === 'auto' ? (hayNumero ? 'asiento' : 'fecha') : agrupacion;
  const grupos = new Map<string, ApunteLeido[]>();
  for (const a of apuntes) {
    const clave = modo === 'asiento' ? `${a.asiento || `sin-numero-${a.fecha}`}` : modo === 'fecha' ? a.fecha : a.fecha.slice(0, 7);
    const g = grupos.get(clave) ?? [];
    g.push(a);
    grupos.set(clave, g);
  }
  const asientos: AsientoAgrupado[] = [];
  for (const [clave, g] of grupos) {
    const fecha = modo === 'mes' ? g.reduce((m, a) => (a.fecha > m ? a.fecha : m), '') : g.reduce((m, a) => (a.fecha < m ? a.fecha : m), g[0].fecha);
    const debe = round2(g.reduce((s, a) => s + a.debe, 0));
    const haber = round2(g.reduce((s, a) => s + a.haber, 0));
    const conceptos = g.map((a) => a.concepto).filter(Boolean);
    const conceptoBase = conceptos[0] ?? '';
    const todo = normalizarTitulo(conceptos.join(' '));
    const especial = /\bapertura\b/.test(todo)
      ? 'APERTURA'
      : /\bregularizacion\b/.test(todo)
        ? 'REGULARIZACION'
        : /\bcierre\b/.test(todo) && /\b(asiento|ejercicio)\b/.test(todo)
          ? 'CIERRE'
          : null;
    const numeroOriginal = modo === 'asiento' ? g[0].asiento : '';
    asientos.push({
      clave,
      fecha,
      numeroOriginal,
      concepto:
        modo === 'mes'
          ? `Movimientos de ${clave} (importados)`
          : modo === 'fecha'
            ? `Movimientos del ${fecha.split('-').reverse().join('/')} (importados)`
            : conceptoBase || `Asiento ${numeroOriginal} (importado)`,
      lineas: g.map((a) => ({ cuenta: a.cuenta, nombre: a.nombre, concepto: a.concepto, debe: a.debe, haber: a.haber })),
      debe,
      haber,
      cuadra: aCentimos(debe) === aCentimos(haber),
      especial,
    });
  }
  asientos.sort((a, b) => (a.fecha === b.fecha ? a.clave.localeCompare(b.clave, 'es', { numeric: true }) : a.fecha.localeCompare(b.fecha)));
  return { asientos, agrupacion: modo };
}

// ---------------------------------------------------------------------------
// Entrada desde fichero
// ---------------------------------------------------------------------------

export function leerBalance(contenido: Buffer, nombreArchivo: string, opciones: OpcionesLectura<CampoBalance> = {}): LecturaBalance {
  const { formato, filas } = leerFilasArchivo(contenido, nombreArchivo);
  return leerBalanceDeFilas(filas, opciones, formato);
}

export function leerDiario(contenido: Buffer, nombreArchivo: string, opciones: OpcionesLectura<CampoDiario> = {}): LecturaDiario {
  const { formato, filas } = leerFilasArchivo(contenido, nombreArchivo);
  return leerDiarioDeFilas(filas, opciones, formato);
}
