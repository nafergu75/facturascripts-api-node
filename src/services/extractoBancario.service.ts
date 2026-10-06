// Lectura de extractos bancarios en Excel (.xlsx, .xls) o CSV.
//
// Cada banco exporta a su manera: filas de cabecera con el titular y el IBAN,
// "Fecha operacion" y "Fecha valor", un importe con signo o columnas de cargo y
// abono, saldo, pie con totales... Aqui se busca la fila de cabecera por el
// nombre de las columnas y se leen los movimientos que hay debajo. Si una fila
// con importe no se puede leer, el extracto entero se rechaza (no se importa a
// medias), indicando la fila.
import * as XLSX from 'xlsx';
import { badRequest } from '../utils/http-errors';

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface FilaExtracto {
  fila: number; // numero de fila en el fichero (para los mensajes)
  fecha: string; // aaaa-mm-dd
  importe: number; // positivo = entra dinero; negativo = sale
  concepto: string;
  referencia?: string;
  saldo?: number;
}

export interface ExtractoLeido {
  formato: 'xlsx' | 'xls' | 'csv';
  columnas: Record<string, string>; // campo -> titulo de la columna en el fichero
  filas: FilaExtracto[];
  avisos: string[];
}

/** Sin tildes, en minusculas, sin puntos ni espacios de mas. */
export function normalizar(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.:()€]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Campo = 'fecha' | 'fechaValor' | 'concepto' | 'importe' | 'cargo' | 'abono' | 'saldo' | 'referencia';

function campoDeCabecera(titulo: string): Campo | null {
  const t = normalizar(titulo);
  if (!t) return null;
  if (/valor/.test(t) && /fecha|^f /.test(t)) return 'fechaValor';
  if (/^(fecha|f)( de)?( (operacion|oper|contable|movimiento))?$/.test(t) || /^fecha/.test(t)) return 'fecha';
  if (/saldo/.test(t)) return 'saldo';
  if (/^importe|^cantidad|^importe eur/.test(t)) return 'importe';
  if (/cargo|^debe$|salida|reintegro|pagos?$/.test(t)) return 'cargo';
  if (/abono|^haber$|ingresos?$|entrada|cobros?$/.test(t)) return 'abono';
  if (/concepto|descripcion|detalle|movimiento|observaciones|beneficiario|ordenante/.test(t)) return 'concepto';
  if (/referencia|^ref|documento|^n ?doc|^num/.test(t)) return 'referencia';
  return null;
}

/** Busca la fila de cabecera: la primera con una fecha y un importe (o cargo/abono). */
function buscarCabecera(filas: unknown[][]): { indice: number; columnas: Partial<Record<Campo, number>>; titulos: Record<string, string> } {
  for (let i = 0; i < Math.min(filas.length, 40); i++) {
    const columnas: Partial<Record<Campo, number>> = {};
    const titulos: Record<string, string> = {};
    filas[i].forEach((celda, j) => {
      const campo = campoDeCabecera(String(celda ?? ''));
      // Si hay dos columnas de un campo (p. ej. dos "Concepto"), vale la primera.
      if (campo && columnas[campo] === undefined) {
        columnas[campo] = j;
        titulos[campo] = String(celda).trim();
      }
    });
    const tieneFecha = columnas.fecha !== undefined || columnas.fechaValor !== undefined;
    const tieneImporte = columnas.importe !== undefined || columnas.cargo !== undefined || columnas.abono !== undefined;
    if (tieneFecha && tieneImporte) return { indice: i, columnas, titulos };
  }
  throw badRequest(
    'No se encuentra la fila de títulos del extracto: hace falta una columna de fecha y otra de importe (o de cargo y abono).',
  );
}

/** Fecha de una celda: numero de serie de Excel, Date o texto dd/mm/aaaa, dd-mm-aa, aaaa-mm-dd. */
export function leerFecha(valor: unknown): string {
  if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
    return `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`;
  }
  if (typeof valor === 'number' && valor > 20000 && valor < 80000) {
    const d = XLSX.SSF.parse_date_code(valor);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const t = String(valor ?? '').trim();
  let iso = '';
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (dmy) {
    const anio = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    iso = `${anio}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  } else if (ymd) {
    iso = `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : '';
}

/**
 * Importe de una celda. Numeros tal cual; en texto acepta "1.234,56",
 * "-12,30 €", "1234.56" y "(50,00)". Vacio -> null. Ilegible -> NaN.
 */
export function leerImporte(valor: unknown): number | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? round2(valor) : NaN;
  let t = String(valor ?? '').replace(/[\s€ ]/g, '').replace(/EUR$/i, '');
  if (!t) return null;
  let negativo = false;
  if (/^\(.*\)$/.test(t)) {
    negativo = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith('-')) {
    negativo = true;
    t = t.slice(0, -1);
  }
  let n: number;
  if (t.includes(',')) {
    if (!/^[+-]?\d{1,3}(\.\d{3})*(,\d+)?$|^[+-]?\d+(,\d+)?$/.test(t)) return NaN;
    n = Number(t.replace(/\./g, '').replace(',', '.'));
  } else if (/^[+-]?\d{1,3}(\.\d{3})+$/.test(t)) {
    n = Number(t.replace(/\./g, '')); // "1.234" = mil doscientos treinta y cuatro
  } else {
    if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return NaN;
    n = Number(t);
  }
  return round2(negativo ? -Math.abs(n) : n);
}

function tipoDeFichero(contenido: Buffer, nombre: string): ExtractoLeido['formato'] {
  if (contenido.subarray(0, 2).toString('latin1') === 'PK') return 'xlsx';
  if (contenido.subarray(0, 4).toString('hex') === 'd0cf11e0') return 'xls';
  if (/\.(xlsx?|xlsm)$/i.test(nombre)) throw badRequest('El fichero dice ser un Excel pero no lo es.');
  return 'csv';
}

/**
 * Filas de un Excel (.xlsx/.xls, primera hoja) o CSV como matriz de celdas.
 * Lo usan tambien otras importaciones (productos).
 */
export function leerFilasArchivo(contenido: Buffer, nombreArchivo = ''): { formato: ExtractoLeido['formato']; filas: unknown[][] } {
  if (!contenido?.length) throw badRequest('El fichero está vacío.');
  const formato = tipoDeFichero(contenido, nombreArchivo);
  return { formato, filas: celdas(contenido, formato) };
}

/** Filas del fichero como matriz de celdas. */
function celdas(contenido: Buffer, formato: ExtractoLeido['formato']): unknown[][] {
  if (formato === 'csv') {
    const texto = contenido.toString('utf8').replace(/^﻿/, '');
    const primera = texto.split(/\r?\n/).find((l) => l.trim()) ?? '';
    const sep = primera.includes(';') ? ';' : primera.includes('\t') ? '\t' : ',';
    return texto.split(/\r?\n/).map((l) => partirCsv(l, sep));
  }
  const libro = XLSX.read(contenido, { type: 'buffer', cellDates: false, dense: true });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  if (!hoja) throw badRequest('El Excel no tiene ninguna hoja.');
  return XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: '', blankrows: true });
}

/** Una linea CSV respetando comillas ("Pago, con coma"). */
function partirCsv(linea: string, sep: string): string[] {
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

export function leerExtracto(contenido: Buffer, nombreArchivo = ''): ExtractoLeido {
  if (!contenido?.length) throw badRequest('El fichero está vacío.');
  const formato = tipoDeFichero(contenido, nombreArchivo);
  const filas = celdas(contenido, formato);
  const { indice, columnas, titulos } = buscarCabecera(filas);
  const avisos: string[] = [];
  const errores: string[] = [];
  const movimientos: FilaExtracto[] = [];
  const colFecha = columnas.fecha ?? columnas.fechaValor!;
  if (columnas.fecha === undefined) avisos.push('No hay fecha de operación: se usa la fecha valor.');

  for (let i = indice + 1; i < filas.length; i++) {
    const f = filas[i];
    const numero = i + 1;
    if (!f || f.every((c) => String(c ?? '').trim() === '')) continue;
    let importe: number | null;
    if (columnas.importe !== undefined) {
      importe = leerImporte(f[columnas.importe]);
    } else {
      const cargo = columnas.cargo !== undefined ? leerImporte(f[columnas.cargo]) : null;
      const abono = columnas.abono !== undefined ? leerImporte(f[columnas.abono]) : null;
      if ((cargo !== null && Number.isNaN(cargo)) || (abono !== null && Number.isNaN(abono))) importe = NaN;
      else if (cargo === null && abono === null) importe = null;
      else importe = round2((abono ?? 0) - Math.abs(cargo ?? 0));
    }
    const fecha = leerFecha(f[colFecha]);
    // Filas sin importe (pie con totales, notas, saldo final): se saltan.
    if (importe === null) continue;
    if (!fecha && !String(f[colFecha] ?? '').trim()) continue;
    if (!fecha) errores.push(`fila ${numero}: fecha no válida «${String(f[colFecha])}»`);
    if (Number.isNaN(importe)) errores.push(`fila ${numero}: importe no válido`);
    if (!fecha || Number.isNaN(importe)) continue;
    const saldo = columnas.saldo !== undefined ? leerImporte(f[columnas.saldo]) : null;
    movimientos.push({
      fila: numero,
      fecha,
      importe,
      concepto: columnas.concepto !== undefined ? String(f[columnas.concepto] ?? '').trim().slice(0, 500) : '',
      referencia: columnas.referencia !== undefined ? String(f[columnas.referencia] ?? '').trim().slice(0, 100) || undefined : undefined,
      saldo: saldo !== null && !Number.isNaN(saldo) ? saldo : undefined,
    });
  }

  if (errores.length) {
    throw badRequest(`El extracto tiene filas que no se pueden leer; no se ha importado nada. ${errores.slice(0, 10).join('; ')}${errores.length > 10 ? `; y ${errores.length - 10} más` : ''}`);
  }
  if (movimientos.length === 0) throw badRequest('El extracto no tiene movimientos.');
  avisos.push(...comprobarSaldos(movimientos));
  return { formato, columnas: titulos, filas: movimientos, avisos };
}

/**
 * Si el extracto trae saldo, cada saldo tiene que ser el anterior mas el
 * importe (en orden ascendente o descendente). Si no cuadra, se avisa: suele
 * ser una columna mal leida.
 */
function comprobarSaldos(movs: FilaExtracto[]): string[] {
  const con = movs.filter((m) => m.saldo !== undefined);
  if (con.length < 2) return [];
  const cuadra = (lista: FilaExtracto[]) => lista.every((m, i) => i === 0 || Math.abs(lista[i - 1].saldo! + m.importe - m.saldo!) < 0.01);
  if (cuadra(con) || cuadra([...con].reverse())) return [];
  return ['Los saldos del extracto no cuadran con los importes. Revisa que las columnas de importe y saldo se hayan leído bien.'];
}
