/**
 * Lector de libros completos para «Traer la contabilidad de 2026».
 *
 * Los programas de las gestorias (a3ECO, ContaPlus/Sage Despachos, Sage 50,
 * Holded, Contasol, Monitor...) exportan de muchas formas. Aqui solo se
 * convierte cada fichero en hojas de celdas, sin decidir todavia que es cada
 * una (eso lo hace clasificador.ts):
 *
 *  - Excel (.xlsx, .xls), tambien el HTML o XML que algunos programas guardan
 *    con extension .xls: se leen TODAS las hojas; las vacias se saltan.
 *  - dBase (.dbf), el formato de las tablas de ContaPlus. Si el fichero no dice
 *    su pagina de codigos, se lee como 850 (la de MS-DOS), que es la que usa
 *    ContaPlus: asi salen bien la ñ y las tildes.
 *  - CSV y TXT: UTF-8 (con o sin BOM), UTF-16 (el «texto Unicode» de Excel) o,
 *    si no es UTF-8 valido, Windows-1252, avisando. El separador se decide por
 *    votacion en las primeras 20 lineas con algo (; tabulador , |): una linea
 *    de titulo sin separadores ya no confunde.
 *  - PDF y texto de ancho fijo no se pueden leer: se devuelve el motivo para
 *    pedir a la gestoria el mismo listado en Excel o CSV.
 *
 * Funciones puras: sin base de datos ni ficheros en disco.
 */
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.js';
import { normalizarCuenta, normalizarTitulo, texto } from '../puestaEnMarcha/lectorContable';

XLSX.set_cptable(cptable);

export type FormatoLibro = 'xlsx' | 'xls' | 'ods' | 'html' | 'csv' | 'txt' | 'dbf';
export type Codificacion = 'utf-8' | 'utf-16' | 'windows-1252' | 'cp850' | 'binario';

/** Una hoja (o el unico «hoja» de un CSV o DBF) como matriz de celdas. */
export interface HojaLibro {
  /** Nombre de la hoja; en CSV, TXT y DBF, el del fichero. */
  hoja: string;
  filas: unknown[][];
  avisos: string[];
}

export type MotivoIlegible = 'PDF' | 'ANCHO_FIJO' | 'VACIO' | 'ILEGIBLE';

export interface LibroLeido {
  fichero: string;
  formato: FormatoLibro | 'pdf' | 'desconocido';
  codificacion: Codificacion;
  hojas: HojaLibro[];
  avisos: string[];
  /** Si no se ha podido leer: por que, en palabras para la persona. */
  error: { motivo: MotivoIlegible; mensaje: string } | null;
}

/** Limites de una carga (los de las subidas por trozos). */
export const TAM_MAX_FICHERO = 50 * 1024 * 1024;
export const MAX_FICHEROS_CARGA = 20;

/** Extensiones admitidas al subir ficheros a la carga (el PDF se admite para explicar que no vale). */
export const EXTENSIONES_CARGA = /\.(xlsx|xlsm|xls|ods|csv|txt|dbf|pdf)$/i;

const MENSAJE_PDF = 'Los PDF no se pueden leer: pide a tu gestoría este listado en Excel o CSV.';
const MENSAJE_ANCHO_FIJO =
  'Este fichero es de ancho fijo (el formato de intercambio de otro programa) y no se puede leer. Pide a tu gestoría el mismo listado en Excel o CSV.';

// ---------------------------------------------------------------------------
// Tipo de fichero
// ---------------------------------------------------------------------------

const empiezaPor = (b: Buffer, bytes: number[]) => bytes.every((x, i) => b[i] === x);

/**
 * ¿Es una tabla dBase? La cabecera dice cuantos registros hay y cuanto mide
 * cada uno: el tamano del fichero tiene que encajar.
 */
export function pareceDbf(b: Buffer): boolean {
  if (b.length < 33) return false;
  if (![0x02, 0x03, 0x04, 0x05, 0x30, 0x31, 0x32, 0x43, 0x63, 0x83, 0x8b, 0x8e, 0xcb, 0xe5, 0xf5, 0xfb].includes(b[0])) return false;
  const registros = b.readUInt32LE(4);
  const cabecera = b.readUInt16LE(8);
  const registro = b.readUInt16LE(10);
  if (cabecera < 33 || registro < 1) return false;
  const esperado = cabecera + registros * registro;
  // Con o sin la marca de fin de fichero (0x1A); algunos programas dejan algo de relleno.
  return b.length >= esperado && b.length <= esperado + 512;
}

function tipoDeFichero(b: Buffer, nombre: string): LibroLeido['formato'] {
  if (empiezaPor(b, [0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (empiezaPor(b, [0x50, 0x4b, 0x03, 0x04])) return /\.ods$/i.test(nombre) ? 'ods' : 'xlsx'; // ZIP
  if (empiezaPor(b, [0xd0, 0xcf, 0x11, 0xe0])) return 'xls'; // OLE
  if (/\.dbf$/i.test(nombre) || pareceDbf(b)) return 'dbf';
  const inicio = b.subarray(0, 512).toString('latin1').replace(/^﻿|^ï»¿/, '').trimStart().toLowerCase();
  if (inicio.startsWith('<?xml') || inicio.startsWith('<html') || inicio.startsWith('<!doctype html') || inicio.startsWith('<table')) return 'html';
  return /\.txt$/i.test(nombre) ? 'txt' : 'csv';
}

// ---------------------------------------------------------------------------
// Texto: codificacion y separador
// ---------------------------------------------------------------------------

/**
 * Texto de un CSV o TXT. Sin BOM ni pistas: si no es UTF-8 valido, se lee
 * como Windows-1252 (lo que guarda Excel en Espana con «CSV (delimitado por
 * comas)»).
 */
export function decodificarTexto(b: Buffer): { texto: string; codificacion: Codificacion } {
  if (empiezaPor(b, [0xff, 0xfe])) return { texto: b.subarray(2).toString('utf16le'), codificacion: 'utf-16' };
  if (empiezaPor(b, [0xfe, 0xff])) {
    const copia = Buffer.from(b.subarray(2));
    copia.swap16();
    return { texto: copia.toString('utf16le'), codificacion: 'utf-16' };
  }
  if (empiezaPor(b, [0xef, 0xbb, 0xbf])) return { texto: b.subarray(3).toString('utf8'), codificacion: 'utf-8' };
  try {
    return { texto: new TextDecoder('utf-8', { fatal: true }).decode(b), codificacion: 'utf-8' };
  } catch {
    return { texto: new TextDecoder('windows-1252').decode(b), codificacion: 'windows-1252' };
  }
}

/** Una linea CSV respetando comillas ("Pago, con coma"). */
export function partirLinea(linea: string, sep: string): string[] {
  const out: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (comillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else comillas = !comillas;
    } else if (c === sep && !comillas) {
      out.push(actual.trim());
      actual = '';
    } else actual += c;
  }
  out.push(actual.trim());
  return out;
}

const SEPARADORES = [';', '\t', ',', '|'] as const;

/**
 * Separador por votacion: gana el que da el mismo numero de columnas (mas de
 * una) en mas lineas de las 20 primeras con algo. null si ninguno parte las
 * lineas (fichero de una sola columna o de ancho fijo).
 */
export function detectarSeparador(lineas: string[]): string | null {
  const muestra = lineas.filter((l) => l.trim()).slice(0, 20);
  let mejor: { sep: string; votos: number } | null = null;
  for (const sep of SEPARADORES) {
    const cuentas = muestra.map((l) => partirLinea(l, sep).length);
    const frecuencia = new Map<number, number>();
    for (const n of cuentas) if (n > 1) frecuencia.set(n, (frecuencia.get(n) ?? 0) + 1);
    const votos = Math.max(0, ...frecuencia.values());
    if (votos > 0 && (!mejor || votos > mejor.votos)) mejor = { sep, votos };
  }
  return mejor?.sep ?? null;
}

/** Texto de ancho fijo: casi todas las lineas miden lo mismo y no hay separadores. */
export function esAnchoFijo(lineas: string[]): boolean {
  const conAlgo = lineas.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  if (conAlgo.length < 3) return false;
  const largos = new Map<number, number>();
  for (const l of conAlgo) largos.set(l.length, (largos.get(l.length) ?? 0) + 1);
  const [largo, veces] = [...largos.entries()].sort((a, b) => b[1] - a[1])[0];
  return largo >= 20 && veces / conAlgo.length >= 0.7 && conAlgo.some((l) => /\d/.test(l));
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const hojaVacia = (filas: unknown[][]) => !filas.some((f) => (f ?? []).some((c) => texto(c) !== ''));

function hojasDeLibro(libro: XLSX.WorkBook): HojaLibro[] {
  const out: HojaLibro[] = [];
  for (const nombre of libro.SheetNames) {
    const hoja = libro.Sheets[nombre];
    if (!hoja) continue;
    const filas = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: '', blankrows: true });
    if (hojaVacia(filas)) continue;
    out.push({ hoja: nombre, filas, avisos: [] });
  }
  return out;
}

/**
 * Lee un fichero de la gestoria y lo devuelve como hojas de celdas. Nunca
 * lanza: si no se puede leer, `error` dice por que.
 */
export function leerLibro(contenido: Buffer, nombre: string): LibroLeido {
  const base: LibroLeido = { fichero: nombre, formato: 'desconocido', codificacion: 'binario', hojas: [], avisos: [], error: null };
  if (!contenido?.length) return { ...base, error: { motivo: 'VACIO', mensaje: 'El fichero está vacío.' } };
  const formato = tipoDeFichero(contenido, nombre);
  base.formato = formato;
  if (formato === 'pdf') return { ...base, error: { motivo: 'PDF', mensaje: MENSAJE_PDF } };

  try {
    if (formato === 'dbf') {
      // Byte 29: pagina de codigos declarada. 0 = sin declarar: la de ContaPlus (850).
      const sinDeclarar = contenido[29] === 0;
      const libro = XLSX.read(contenido, { type: 'buffer', dense: true, ...(sinDeclarar ? { codepage: 850 } : {}) });
      const hojas = hojasDeLibro(libro).map((h) => ({ ...h, hoja: nombre }));
      return { ...base, codificacion: sinDeclarar ? 'cp850' : 'binario', hojas, error: hojas.length ? null : { motivo: 'VACIO', mensaje: 'La tabla no tiene datos.' } };
    }
    if (formato === 'xlsx' || formato === 'xls' || formato === 'ods' || formato === 'html') {
      const libro = XLSX.read(contenido, { type: 'buffer', dense: true, cellDates: false });
      const hojas = hojasDeLibro(libro);
      return { ...base, hojas, error: hojas.length ? null : { motivo: 'VACIO', mensaje: 'El libro no tiene ninguna hoja con datos.' } };
    }

    // CSV o TXT.
    const { texto: contenidoTexto, codificacion } = decodificarTexto(contenido);
    base.codificacion = codificacion;
    if (codificacion === 'windows-1252') base.avisos.push('El fichero no venía en UTF-8: se ha leído como Windows-1252 (lo normal en Excel). Revisa que las tildes y la ñ salgan bien.');
    const lineas = contenidoTexto.split(/\r?\n/);
    const sep = detectarSeparador(lineas);
    if (!sep && esAnchoFijo(lineas)) return { ...base, error: { motivo: 'ANCHO_FIJO', mensaje: MENSAJE_ANCHO_FIJO } };
    const filas = lineas.map((l) => (sep ? partirLinea(l, sep) : [l.trim()]));
    if (hojaVacia(filas)) return { ...base, error: { motivo: 'VACIO', mensaje: 'El fichero está vacío.' } };
    return { ...base, hojas: [{ hoja: nombre, filas, avisos: [] }] };
  } catch {
    return { ...base, error: { motivo: 'ILEGIBLE', mensaje: 'No se ha podido leer el fichero. Pide a tu gestoría el listado en Excel o CSV.' } };
  }
}

// ---------------------------------------------------------------------------
// Ayudas para las filas
// ---------------------------------------------------------------------------

/**
 * Quita las filas iguales a la de titulos que se repiten mas abajo (listados
 * impresos con el titulo en cada pagina).
 */
export function quitarCabecerasRepetidas(filas: unknown[][], filaCabecera: number): unknown[][] {
  if (filaCabecera < 0 || !filas[filaCabecera]) return filas;
  const clave = (f: unknown[] | undefined) => (f ?? []).map(normalizarTitulo).join('|');
  const cab = clave(filas[filaCabecera]);
  if (!cab.replace(/\|/g, '')) return filas;
  return filas.filter((f, i) => i <= filaCabecera || clave(f) !== cab);
}

/**
 * Codigo con punto de relleno, como se teclea en ContaPlus, Contasol o a3:
 * «430.1» con subcuentas de 10 digitos es la 4300000001. Si sin el punto ya
 * tiene la longitud (o mas), solo se quita el punto. null si no es un codigo.
 */
export function expandirCodigoConPunto(valor: unknown, longitud: number): string | null {
  const s = texto(valor);
  const m = /^(\d{1,9})\.(\d{1,9})$/.exec(s);
  if (!m) return normalizarCuenta(valor);
  const [, izq, der] = m;
  if (izq.length + der.length >= longitud) return normalizarCuenta(`${izq}${der}`);
  return `${izq}${'0'.repeat(longitud - izq.length - der.length)}${der}`;
}

/** ¿Hay codigos con punto de relleno en la columna? (para avisar y para no tomar «430.1» por un importe). */
export function hayCodigosConPunto(valores: unknown[]): boolean {
  return valores.some((v) => typeof v === 'string' && /^\d{3,4}\.\d{1,9}$/.test(v.trim()));
}
