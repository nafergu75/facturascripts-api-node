/**
 * Comprobaciones de los tests de exportacion: que en el PDF y en el Excel de un
 * informe cada cifra cae bajo su titulo de columna, fila a fila, sin cortarse
 * ni correrse de sitio. Devuelven la lista de fallos (vacia si todo esta bien).
 */
import * as XLSX from 'xlsx';
import { aImporte, fechaES, num, textoCelda, type TablaInforme } from '../services/informesContables.documentos';
import { lineasDePdf, type TextoPdf } from './texto-pdf';

/** Tamaño de letra de los titulos de columna y de las filas de datos en el PDF. */
const TAM_CABECERA = 6.5;
const TAM_FILA = 8;
const TOLERANCIA = 0.6;

const cerca = (a: number, b: number) => Math.abs(a - b) <= TOLERANCIA;

/**
 * PDF: los titulos de columna en orden y alineados (importes a la derecha), y
 * cada celda de cada fila (salvo las de seccion, que ocupan toda la fila) en su
 * columna: los importes enteros y acabando donde acaba su titulo; el resto
 * empezando donde empieza el suyo. Ningun texto pisa al siguiente.
 */
export function fallosColumnasPdf(t: TablaInforme, textos: TextoPdf[]): string[] {
  const fallos: string[] = [];
  const cols = t.columnas;
  // Titulos de columna de la primera pagina: una columna por grupo de lineas
  // con el mismo borde (izquierdo si va a la izquierda, derecho si va a la derecha).
  const cab = textos.filter((x) => x.pagina === 1 && x.tam === TAM_CABECERA);
  const grupos: TextoPdf[][] = [];
  for (const x of cab.sort((a, b) => b.y - a.y)) {
    const g = grupos.find((gr) => cerca(gr[0].x, x.x) || cerca(gr[0].derecha, x.derecha));
    if (g) g.push(x);
    else grupos.push([x]);
  }
  grupos.sort((a, b) => Math.min(...a.map((x) => x.x)) - Math.min(...b.map((x) => x.x)));
  if (grupos.length !== cols.length) return [`Hay ${grupos.length} titulos de columna y la tabla tiene ${cols.length}.`];
  const titulos = grupos.map((g) => ({ texto: g.map((x) => x.texto).join(' '), x: Math.min(...g.map((x) => x.x)), derecha: Math.max(...g.map((x) => x.derecha)) }));
  cols.forEach((c, k) => {
    if (titulos[k].texto !== c.titulo.toUpperCase()) fallos.push(`Columna ${k + 1}: el titulo es «${titulos[k].texto}» y deberia ser «${c.titulo.toUpperCase()}».`);
  });

  const lineas = lineasDePdf(textos.filter((x) => x.tam === TAM_FILA));
  const filas = t.filas.filter((f) => (f.estilo ?? 'normal') !== 'seccion');
  if (lineas.length !== filas.length) fallos.push(`El PDF tiene ${lineas.length} filas de datos y la tabla ${filas.length}.`);
  filas.forEach((f, i) => {
    const linea = lineas[i] ?? [];
    const estilo = f.estilo ?? 'normal';
    const primeraTexto = cols.findIndex((c) => c.tipo === 'texto');
    cols.forEach((c, k) => {
      const esperado = textoCelda(f.celdas[k] ?? null, c, estilo);
      if (!esperado) return;
      const quien = `Fila ${i + 1} («${f.celdas.filter((v) => typeof v === 'string').join(' ')}»), columna ${c.titulo}`;
      if (c.tipo === 'importe') {
        // La misma cifra puede salir en dos columnas de la fila (p. ej. Debe y Saldo): vale la que acaba bajo su titulo.
        const iguales = linea.filter((x) => x.texto === esperado);
        if (!iguales.length) fallos.push(`${quien}: no aparece ${esperado}.`);
        else if (!iguales.some((x) => cerca(x.derecha, titulos[k].derecha))) {
          fallos.push(`${quien}: ${esperado} acaba en ${iguales.map((x) => x.derecha.toFixed(1)).join(' y ')} y su titulo en ${titulos[k].derecha.toFixed(1)}.`);
        }
        return;
      }
      const sangria = k === primeraTexto ? (f.sangria ?? 0) * 10 : 0;
      const item = linea.find((x) => cerca(x.x, titulos[k].x + sangria));
      if (!item) fallos.push(`${quien}: no hay nada donde empieza su titulo.`);
      else if (item.texto !== esperado && !(item.texto.endsWith('…') && esperado.startsWith(item.texto.slice(0, -1).trimEnd()))) {
        fallos.push(`${quien}: pone «${item.texto}» y deberia poner «${esperado}».`);
      }
    });
    for (let j = 1; j < linea.length; j++) {
      if (linea[j - 1].derecha > linea[j].x + 0.5) fallos.push(`Fila ${i + 1}: «${linea[j - 1].texto}» pisa a «${linea[j].texto}».`);
    }
  });
  return fallos;
}

/** Fila (desde 0) de los titulos de columna en el Excel: empresa, titulo, periodo y una en blanco encima. */
export const FILA_CABECERA_XLSX = 4;

/**
 * Excel: los titulos justo encima de los datos; cada celda en su columna, con
 * su tipo (importe = numero con formato #,##0.00, fecha = fecha); y cada
 * columna con ancho para lo que enseña (salvo el texto que se ajusta en varias lineas).
 */
export function fallosColumnasXlsx(t: TablaInforme, xlsx: Buffer): string[] {
  const fallos: string[] = [];
  const wb = XLSX.read(xlsx, { type: 'buffer', cellStyles: true, cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const celda = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
  const cols = t.columnas;
  const anchos = (ws['!cols'] ?? []) as Array<{ width?: number; wch?: number }>;
  cols.forEach((c, k) => {
    const v = celda(FILA_CABECERA_XLSX, k)?.v;
    if (v !== c.titulo) fallos.push(`Titulo de la columna ${k + 1}: «${String(v)}» en vez de «${c.titulo}».`);
  });
  t.filas.forEach((f, i) => {
    const r = FILA_CABECERA_XLSX + 1 + i;
    const estilo = f.estilo ?? 'normal';
    cols.forEach((c, k) => {
      const x = celda(r, k);
      const v = f.celdas[k] ?? null;
      const quien = `Fila ${r + 1}, columna ${c.titulo}`;
      const ancho = anchos[k]?.width ?? anchos[k]?.wch ?? 0;
      if (v === null || v === '') {
        if (x && x.v !== undefined && x.v !== '') fallos.push(`${quien}: deberia estar vacia y tiene «${String(x.v)}».`);
        return;
      }
      if (c.tipo === 'importe') {
        const n = aImporte(v)!;
        if (!x || x.t !== 'n' || x.v !== n) fallos.push(`${quien}: deberia ser el numero ${n} y es ${x ? `${x.t} ${String(x.v)}` : 'nada'}.`);
        else if (!String(x.z ?? '').startsWith('#,##0.00')) fallos.push(`${quien}: formato ${String(x.z)} en vez de #,##0.00.`);
        // El texto mas largo de un importe: con signo y separadores, 1 de margen.
        const visible = n === 0 && estilo === 'normal' && !c.saldo ? '' : num(n);
        if (ancho < visible.length + 1) fallos.push(`${quien}: ${visible} no cabe en ${ancho} caracteres.`);
        return;
      }
      if (c.tipo === 'fecha' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        if (!x || x.t !== 'n' || String(x.z) !== 'dd/mm/yyyy') fallos.push(`${quien}: deberia ser una fecha con formato dd/mm/yyyy.`);
        else {
          const d = XLSX.SSF.parse_date_code(x.v as number);
          const iso = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
          if (iso !== v) fallos.push(`${quien}: la fecha es ${iso} y deberia ser ${v}.`);
        }
        if (ancho < fechaES(v).length + 1) fallos.push(`${quien}: la fecha no cabe en ${ancho} caracteres.`);
        return;
      }
      if (!x || x.v !== String(v)) fallos.push(`${quien}: pone «${String(x?.v)}» y deberia poner «${String(v)}».`);
      const ajusta = c.tipo === 'texto' && ancho >= 59;
      if (!ajusta && ancho < String(v).length + 1) fallos.push(`${quien}: «${String(v)}» no cabe en ${ancho} caracteres.`);
    });
  });
  return fallos;
}
