/**
 * Descarga de los informes contables en PDF (PDF/A-2b) y Excel (.xlsx).
 *
 * Cada informe se describe una sola vez como TablaInforme (columnas y filas con
 * su estilo) y de ahi salen la vista en pantalla, el PDF y el Excel: las cifras
 * son las mismas en los tres, y cada una va en la columna que le corresponde.
 *
 * El PDF sigue el diseno de la factura (facturaPdf.service): tinta slate,
 * filetes finos, cifras en Geist Mono alineadas a la derecha y un unico acento
 * verde (#047857) bajo la cabecera. Las columnas de importes, fechas y codigos
 * miden lo que necesita su contenido (un importe cabe siempre, hasta
 * −9.999.999,99); el concepto se queda con el resto y es el que se recorta.
 *
 * En Excel los importes son numeros (formato #,##0.00, sumables) y las fechas
 * son fechas; cada columna es tan ancha como su texto mas largo, la cabecera y
 * los totales van destacados, la fila de titulos se queda fija y al imprimir
 * sale ajustado a una pagina de ancho (utils/hojaExcel).
 */
import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';
import { hoyEspana } from '../utils/fechas';
import { escribirHojaExcel, type FilaHoja, type CeldaHoja } from '../utils/hojaExcel';

export type TipoColumna = 'texto' | 'codigo' | 'fecha' | 'importe';

export interface ColumnaInforme {
  titulo: string;
  tipo: TipoColumna;
  /**
   * Peso relativo del ancho. En el PDF reparte el sitio que dejan las columnas
   * de importes, fechas y codigos (que miden lo que su contenido) entre las de texto.
   */
  ancho: number;
  /**
   * Columna de saldo (acumulado, inicial o final): su 0,00 se escribe siempre,
   * porque un saldo a cero es un dato. En Debe, Haber y el resto de importes, un
   * cero de una fila normal se deja en blanco.
   */
  saldo?: boolean;
}

export type EstiloFila = 'normal' | 'seccion' | 'subtotal' | 'total' | 'nota';

export interface FilaInforme {
  celdas: Array<string | number | null>;
  estilo?: EstiloFila;
  /** Nivel de sangria de la primera columna de texto. */
  sangria?: number;
}

export interface TablaInforme {
  titulo: string;
  /** "Ejercicio 2025" o "Del 01/01/2025 al 31/03/2025". */
  periodo: string;
  empresa: { nombre: string; nif: string };
  columnas: ColumnaInforme[];
  filas: FilaInforme[];
  /** Hoja apaisada (informes con muchas columnas). */
  apaisado?: boolean;
  /** Avisos al pie (p. ej. "el balance no cuadra"). */
  notas?: string[];
  /** Nombre del fichero sin extension. */
  fichero: string;
}

// ---------- Formatos ----------

/**
 * 1234.5 -> "1.234,50"; los negativos con el signo menos (−). Se agrupan los
 * miles a mano: Intl en es-ES no separa los de 4 cifras ("1234,50") en todas
 * las versiones de Node.
 */
export const num = (n: number): string => {
  const [ent, dec] = Math.abs(n).toFixed(2).split('.');
  const negativo = n < 0 && `${ent}${dec}` !== '000';
  return `${negativo ? '−' : ''}${ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
};
export const fechaES = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

export function textoPeriodo(desde: string, hasta: string): string {
  const anio = desde.slice(0, 4);
  if (desde === `${anio}-01-01` && hasta === `${anio}-12-31`) return `Ejercicio ${anio}`;
  return `Del ${fechaES(desde)} al ${fechaES(hasta)}`;
}

/** Un importe como numero, llegue como numero, como texto ("1234.50") o como Decimal de Prisma. */
export function aImporte(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  if (v && typeof v === 'object' && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    const n = (v as { toNumber(): number }).toNumber();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** El cero que se deja en blanco: el de un importe que no es saldo, en una fila normal. */
const ceroEnBlanco = (col: Pick<ColumnaInforme, 'tipo' | 'saldo'>, estilo: EstiloFila) => col.tipo === 'importe' && !col.saldo && estilo === 'normal';

/** Lo que se lee en una celda (PDF y pantalla). */
export function textoCelda(v: unknown, col: Pick<ColumnaInforme, 'tipo' | 'saldo'>, estilo: EstiloFila = 'normal'): string {
  if (v === null || v === undefined || v === '') return '';
  if (col.tipo === 'importe') {
    const n = aImporte(v);
    if (n === null) return String(v);
    return n === 0 && ceroEnBlanco(col, estilo) ? '' : num(n);
  }
  if (col.tipo === 'fecha' && typeof v === 'string') return fechaES(v);
  return String(v);
}

/** Nombre de fichero seguro (sin tildes ni espacios). */
export function nombreFichero(base: string, extension: 'pdf' | 'xlsx'): string {
  const limpio = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `${limpio || 'informe'}.${extension}`;
}

// ---------- PDF ----------

const TINTA = rgb(0.059, 0.09, 0.165); // #0F172A
const GRIS = rgb(0.392, 0.455, 0.545); // #64748B
const LINEA = rgb(0.886, 0.91, 0.941); // #E2E8F0
const ACENTO = rgb(0.016, 0.471, 0.341); // #047857
const ACENTO_SUAVE = rgb(0.925, 0.992, 0.961); // #ECFDF5
const FONDO_SECCION = rgb(0.973, 0.98, 0.988); // #F8FAFC

const MARGEN = 40;
const PIE_Y = 24;
const SUELO = 48;
const TAM = 8;
const TAM_CAB = 6.5;
const LINEA_CAB = 8;
const ALTO_FILA = 13;
/** Margen interior de cada celda, a cada lado. */
const PAD = 5;
/** Lo que entra cada nivel de sangria (partidas del balance, lineas del diario). */
const SANGRIA = 10;
/** La cifra mas ancha que tiene que caber siempre en una columna de importes. */
const MUESTRA_IMPORTE = '−9.999.999,99';
const MUESTRA_FECHA = '00/00/0000';
/** Ancho maximo de una columna de codigos (asiento, NIF, subcuenta): unos 35 caracteres; lo que pase, se recorta. */
const MAX_CODIGO = 180;
/** Ancho minimo de una columna de texto (concepto, nombre). */
const MIN_TEXTO = 70;
/**
 * Margen de error al medir: en coma flotante 57,6 + 10 − 10 da 57,5999…, y el
 * codigo mas largo de su columna (la que mide justo lo que el) se recortaba.
 */
const HOLGURA = 0.01;

interface Fuentes {
  normal: PDFFont;
  negrita: PDFFont;
  mono: PDFFont;
  monoNegrita: PDFFont;
}

/** Recorta un texto con «…» para que quepa en `max` puntos. */
function recortar(s: string, fuente: PDFFont, tam: number, max: number): string {
  if (fuente.widthOfTextAtSize(s, tam) <= max + HOLGURA) return s;
  let r = s;
  while (r.length > 1 && fuente.widthOfTextAtSize(`${r}…`, tam) > max + HOLGURA) r = r.slice(0, -1);
  return `${r.trimEnd()}…`;
}

/** Parte un texto en las lineas que hagan falta para que quepa en `max` puntos (por palabras). */
function partirEnLineas(s: string, fuente: PDFFont, tam: number, max: number): string[] {
  const lineas: string[] = [];
  let actual = '';
  // Solo se parte por los espacios normales: el espacio duro (U+00A0) une la cifra con su «€».
  for (const p of s.split(/[ \t\r\n]+/).filter(Boolean)) {
    const prueba = actual ? `${actual} ${p}` : p;
    if (!actual || fuente.widthOfTextAtSize(prueba, tam) <= max + HOLGURA) actual = prueba;
    else {
      lineas.push(actual);
      actual = p;
    }
  }
  if (actual) lineas.push(actual);
  // Una sola palabra mas larga que la linea (p. ej. una URL), recortada.
  return lineas.map((l) => recortar(l, fuente, tam, max));
}

/** Titulo de columna en una o dos lineas que quepan en `max` (en mayusculas). */
function partirTitulo(titulo: string, fuente: PDFFont, max: number): string[] {
  const palabras = titulo.toUpperCase().split(/\s+/).filter(Boolean);
  const lineas: string[] = [];
  for (const p of palabras) {
    const ultima = lineas[lineas.length - 1];
    if (ultima !== undefined && fuente.widthOfTextAtSize(`${ultima} ${p}`, TAM_CAB) <= max + HOLGURA) lineas[lineas.length - 1] = `${ultima} ${p}`;
    else lineas.push(p);
  }
  if (lineas.length <= 2) return lineas.map((l) => recortar(l, fuente, TAM_CAB, max));
  return [lineas[0], recortar(lineas.slice(1).join(' '), fuente, TAM_CAB, max)];
}

const palabraMasAncha = (titulo: string, fuente: PDFFont) =>
  Math.max(0, ...titulo.toUpperCase().split(/\s+/).map((p) => fuente.widthOfTextAtSize(p, TAM_CAB)));

/**
 * Ancho de cada columna del PDF. Importes, fechas y codigos miden lo que su
 * contenido (un importe, al menos −9.999.999,99) mas el margen. Las de texto
 * miden lo que su texto mas largo y, si sobra sitio, se lo reparten segun su
 * peso. Si falta, cede primero el texto de mas peso (el concepto) hasta
 * MIN_TEXTO, despues los demas textos, y solo al final, si ni con los textos al
 * ancho de su titulo cabe la tabla, los codigos. Los importes y las fechas no
 * ceden nunca.
 */
export function anchosColumnasPdf(t: Pick<TablaInforme, 'columnas' | 'filas'>, f: Fuentes, anchoUtil: number): number[] {
  const cols = t.columnas;
  const primeraTexto = cols.findIndex((c) => c.tipo === 'texto');
  const contenido = cols.map((c, k) => {
    let max = 0;
    for (const fila of t.filas) {
      const estilo = fila.estilo ?? 'normal';
      if (estilo === 'seccion') continue; // ocupa toda la fila
      const s = textoCelda(fila.celdas[k] ?? null, c, estilo);
      if (!s) continue;
      const fuente = c.tipo === 'texto' ? f.negrita : f.monoNegrita;
      const sangria = k === primeraTexto ? (fila.sangria ?? 0) * SANGRIA : 0;
      max = Math.max(max, fuente.widthOfTextAtSize(s, TAM) + sangria);
    }
    return max;
  });
  const minTitulo = cols.map((c) => palabraMasAncha(c.titulo, f.negrita) + 2 * PAD);
  const natural = cols.map((c, k) => {
    if (c.tipo === 'importe') return Math.max(f.monoNegrita.widthOfTextAtSize(MUESTRA_IMPORTE, TAM), contenido[k]) + 2 * PAD;
    if (c.tipo === 'fecha') return Math.max(f.monoNegrita.widthOfTextAtSize(MUESTRA_FECHA, TAM), contenido[k]) + 2 * PAD;
    if (c.tipo === 'codigo') return Math.min(MAX_CODIGO, contenido[k] + 2 * PAD);
    return 0;
  });
  const anchos = cols.map((c, k) => (c.tipo === 'texto' ? 0 : Math.max(natural[k], minTitulo[k])));
  const textos = cols.map((c, k) => (c.tipo === 'texto' ? k : -1)).filter((k) => k >= 0);
  const resto = anchoUtil - anchos.reduce((s, w) => s + w, 0);

  if (!textos.length) {
    // Sin columnas de texto: lo que sobre, segun el peso.
    const peso = cols.reduce((s, c) => s + c.ancho, 0) || 1;
    if (resto > 0) cols.forEach((c, k) => (anchos[k] += (resto * c.ancho) / peso));
    return anchos;
  }

  // Lo que mide cada texto entero; su minimo comodo (MIN_TEXTO, o menos si su
  // texto es mas corto) y el de urgencia (el ancho de su titulo).
  const entero = (k: number) => Math.max(minTitulo[k], contenido[k] + 2 * PAD);
  const comodo = (k: number) => Math.min(entero(k), Math.max(MIN_TEXTO, minTitulo[k]));
  const urgencia = (k: number) => minTitulo[k];
  for (const k of textos) anchos[k] = entero(k);
  const necesita = textos.reduce((s, k) => s + entero(k), 0);

  if (resto >= necesita) {
    // Sobra sitio: cada texto entero y lo que sobra, segun su peso.
    const peso = textos.reduce((s, k) => s + cols[k].ancho, 0) || 1;
    for (const k of textos) anchos[k] += ((resto - necesita) * cols[k].ancho) / peso;
    return anchos;
  }

  // Falta sitio: cede primero el texto de mas peso (el concepto), hasta su
  // minimo comodo; despues los demas; y si aun falta, hasta el de urgencia.
  let falta = necesita - resto;
  const porPeso = [...textos].sort((a, b) => cols[b].ancho - cols[a].ancho);
  for (const minimo of [comodo, urgencia]) {
    for (const k of porPeso) {
      const cede = Math.min(falta, Math.max(0, anchos[k] - minimo(k)));
      anchos[k] -= cede;
      falta -= cede;
    }
  }
  if (falta > HOLGURA) {
    // Ni asi cabe: ceden los codigos, como mucho hasta el ancho de su titulo (y se recortan con «…»).
    const codigos = cols.map((c, k) => (c.tipo === 'codigo' ? k : -1)).filter((k) => k >= 0);
    const cedible = codigos.reduce((s, k) => s + Math.max(0, anchos[k] - minTitulo[k]), 0);
    const cede = Math.min(falta, cedible);
    if (cede > 0) for (const k of codigos) anchos[k] -= (Math.max(0, anchos[k] - minTitulo[k]) * cede) / cedible;
  }
  return anchos;
}

export async function tablaAPdf(t: TablaInforme): Promise<Buffer> {
  const tituloDoc = `${t.titulo} · ${t.periodo}`;
  const { doc, normal, negrita, mono, monoNegrita, ancho: anchoA4, alto: altoA4 } = await crearDocumentoPdfA(tituloDoc);
  const [ancho, alto] = t.apaisado ? [altoA4, anchoA4] : [anchoA4, altoA4];
  const derecha = ancho - MARGEN;
  const anchoUtil = derecha - MARGEN;

  const anchos = anchosColumnasPdf(t, { normal, negrita, mono, monoNegrita }, anchoUtil);
  const cols: Array<ColumnaInforme & { x: number; w: number; cab: string[] }> = [];
  {
    let x = MARGEN;
    t.columnas.forEach((c, k) => {
      const w = anchos[k];
      cols.push({ ...c, x, w, cab: partirTitulo(c.titulo, negrita, w - 2 * PAD) });
      x += w;
    });
  }
  const lineasCab = Math.max(1, ...cols.map((c) => c.cab.length));
  const finTabla = Math.max(derecha, cols.length ? cols[cols.length - 1].x + cols[cols.length - 1].w : derecha);

  type Estilo = { tam?: number; fuente?: PDFFont; color?: RGB; alinear?: 'izq' | 'der' };
  const texto = (pg: PDFPage, s: string, x: number, y: number, o: Estilo = {}) => {
    if (!s) return;
    const tam = o.tam ?? TAM;
    const fuente = o.fuente ?? normal;
    const xx = o.alinear === 'der' ? x - fuente.widthOfTextAtSize(s, tam) : x;
    pg.drawText(s, { x: xx, y, size: tam, font: fuente, color: o.color ?? TINTA });
  };
  const filete = (pg: PDFPage, y: number, grueso = 0.5, color = LINEA, x1 = MARGEN, x2 = finTabla) =>
    pg.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: grueso, color });

  const paginas: PDFPage[] = [];
  let p!: PDFPage;
  let y = 0;

  // Titulos de columna (se repiten en cada pagina), pegados al filete: los de
  // una linea a la altura de la ultima de los de dos. Los de importes, a la
  // derecha, encima de sus cifras.
  const cabeceraColumnas = () => {
    for (const c of cols) {
      const der = c.tipo === 'importe';
      c.cab.forEach((l, i) => {
        const yl = y - 10 - (lineasCab - c.cab.length + i) * LINEA_CAB;
        texto(p, l, der ? c.x + c.w - PAD : c.x + PAD, yl, { tam: TAM_CAB, fuente: negrita, color: GRIS, alinear: der ? 'der' : 'izq' });
      });
    }
    y -= 15 + (lineasCab - 1) * LINEA_CAB;
    filete(p, y, 0.75, TINTA);
  };

  const nuevaPagina = (primera: boolean) => {
    p = doc.addPage([ancho, alto]);
    paginas.push(p);
    y = alto - 44;
    if (primera) {
      texto(p, t.empresa.nombre || 'Empresa', MARGEN, y, { tam: 9, fuente: negrita });
      if (t.empresa.nif) texto(p, `NIF ${t.empresa.nif}`, derecha, y, { tam: 8.5, fuente: mono, color: GRIS, alinear: 'der' });
      y -= 26;
      texto(p, recortar(t.titulo, negrita, 18, anchoUtil), MARGEN, y, { tam: 18, fuente: negrita });
      y -= 18;
      texto(p, recortar(t.periodo, normal, 10, anchoUtil), MARGEN, y, { tam: 10, color: GRIS });
      y -= 12;
      filete(p, y, 1.25, ACENTO, MARGEN, derecha);
      y -= 14;
    } else {
      texto(p, t.empresa.nombre || 'Empresa', MARGEN, y, { tam: 8.5, fuente: negrita });
      const cont = `${t.titulo} · ${t.periodo} (continuación)`;
      const libre = anchoUtil - negrita.widthOfTextAtSize(t.empresa.nombre || 'Empresa', 8.5) - 20;
      texto(p, recortar(cont, normal, 8.5, libre), derecha, y, { tam: 8.5, color: GRIS, alinear: 'der' });
      y -= 18;
    }
    cabeceraColumnas();
  };
  nuevaPagina(true);

  const primeraTexto = cols.findIndex((c) => c.tipo === 'texto');

  for (const fila of t.filas) {
    const estilo = fila.estilo ?? 'normal';
    const altoFila = estilo === 'seccion' ? ALTO_FILA + 8 : estilo === 'total' ? ALTO_FILA + 6 : ALTO_FILA;
    // Una seccion no se queda sola al pie de la pagina.
    if (y - altoFila - (estilo === 'seccion' ? ALTO_FILA * 2 : 0) < SUELO) nuevaPagina(false);

    if (estilo === 'seccion') {
      // Una seccion (p. ej. una cuenta del mayor o un asiento del diario) ocupa toda la fila.
      y -= 6;
      p.drawRectangle({ x: MARGEN, y: y - ALTO_FILA + 3, width: finTabla - MARGEN, height: ALTO_FILA, color: FONDO_SECCION });
      const s = fila.celdas.map((c, k) => textoCelda(c, cols[k] ?? { tipo: 'texto' }, estilo)).filter(Boolean).join('  ·  ');
      texto(p, recortar(s, negrita, TAM + 0.5, finTabla - MARGEN - 2 * PAD), MARGEN + PAD, y - 7, { tam: TAM + 0.5, fuente: negrita });
      y -= ALTO_FILA + 2;
      continue;
    }

    if (estilo === 'total') {
      y -= 3;
      p.drawRectangle({ x: MARGEN, y: y - ALTO_FILA + 2, width: finTabla - MARGEN, height: ALTO_FILA + 2, color: ACENTO_SUAVE });
      filete(p, y + 2, 0.75, ACENTO);
    } else if (estilo === 'subtotal') {
      filete(p, y, 0.5, GRIS);
    }

    const fuerte = estilo === 'total' || estilo === 'subtotal';
    const yt = y - 9;
    cols.forEach((c, k) => {
      const v = textoCelda(fila.celdas[k] ?? null, c, estilo);
      if (!v) return;
      if (c.tipo === 'importe') {
        // Las cifras nunca se recortan: su columna mide lo que necesitan.
        texto(p, v, c.x + c.w - PAD, yt, { fuente: fuerte ? monoNegrita : mono, alinear: 'der' });
      } else {
        const sangria = k === primeraTexto ? (fila.sangria ?? 0) * SANGRIA : 0;
        const fuente = c.tipo === 'codigo' || c.tipo === 'fecha' ? (fuerte ? monoNegrita : mono) : fuerte ? negrita : normal;
        const max = c.w - 2 * PAD - sangria;
        texto(p, recortar(v, fuente, TAM, max), c.x + PAD + sangria, yt, { fuente, color: estilo === 'nota' ? GRIS : TINTA });
      }
    });
    y -= altoFila;
    if (estilo === 'normal' || estilo === 'nota') filete(p, y + 0.5, 0.35);
  }

  if (t.notas?.length) {
    y -= 14;
    // Cada nota en las lineas que necesite: un aviso largo (p. ej. la lista de
    // ventas sin asiento) se lee entero, no se corta con «…».
    for (const n of t.notas) {
      for (const l of partirEnLineas(n, normal, 7.5, anchoUtil)) {
        if (y - 12 < SUELO) nuevaPagina(false);
        texto(p, l, MARGEN, y, { tam: 7.5, color: GRIS });
        y -= 9.5;
      }
      y -= 1.5;
    }
  }

  // Pie: si no cabe, se recorta la empresa, el titulo o el periodo; la fecha de generacion se lee siempre entera.
  const generado = ` · Generado el ${fechaES(hoyEspana())}`;
  const pie = [t.empresa.nombre, t.titulo, t.periodo].filter(Boolean).join(' · ');
  paginas.forEach((pg, i) => {
    const pagina = `Página ${i + 1} de ${paginas.length}`;
    const libre = anchoUtil - normal.widthOfTextAtSize(pagina, 7) - 20 - normal.widthOfTextAtSize(generado, 7);
    texto(pg, `${recortar(pie, normal, 7, libre)}${generado}`, MARGEN, PIE_Y, { tam: 7, color: GRIS });
    texto(pg, pagina, derecha, PIE_Y, { tam: 7, color: GRIS, alinear: 'der' });
  });

  return guardarPdfA(doc, tituloDoc);
}

// ---------- Excel ----------

/** Anchos minimo y maximo (en caracteres) de cada tipo de columna. */
const EXCEL_MIN: Record<TipoColumna, number> = { fecha: 11, importe: 14, codigo: 8, texto: 12 };
const EXCEL_MAX: Record<TipoColumna, number> = { fecha: 14, importe: 22, codigo: 40, texto: 60 };
/** Lo que ocupa el boton del autofiltro junto al titulo de la columna. */
const BOTON_FILTRO = 3;

/** Nombre de la hoja: el titulo, cortado por una palabra si pasa de 31 caracteres. */
function nombreDeHoja(titulo: string): string {
  if (titulo.length <= 31) return titulo;
  const corte = titulo.charAt(31) === ' ' ? 31 : titulo.slice(0, 31).lastIndexOf(' ');
  return corte > 10 ? titulo.slice(0, corte) : titulo.slice(0, 31);
}

/** Celda de Excel de un valor de la tabla: importes como numero, fechas como fecha. */
function celdaExcel(v: string | number | null | undefined, col: ColumnaInforme, estilo: EstiloFila): CeldaHoja {
  if (v === null || v === undefined || v === '') return { v: null };
  if (col.tipo === 'importe') {
    const n = aImporte(v);
    if (n === null) return { v: String(v) };
    return { v: n, formato: ceroEnBlanco(col, estilo) ? 'importe' : 'importeConCero' };
  }
  if (col.tipo === 'fecha' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return { v: new Date(`${v}T00:00:00Z`) };
  return { v: String(v) };
}

/** Largo (en caracteres) con el que se ve una celda, para calcular el ancho de su columna. */
function largoVisible(v: string | number | null | undefined, col: ColumnaInforme, estilo: EstiloFila, sangria: number): number {
  if (v === null || v === undefined || v === '') return 0;
  const s = col.tipo === 'importe' ? textoCelda(v, col, estilo) : col.tipo === 'fecha' ? fechaES(String(v)) : String(v);
  const fuerte = estilo === 'total' || estilo === 'subtotal' || estilo === 'seccion';
  // La negrita ocupa algo mas; la sangria, unos dos caracteres por nivel.
  return Math.ceil(s.length * (fuerte ? 1.1 : 1)) + sangria * 2;
}

export function tablaAXlsx(t: TablaInforme): Buffer {
  const cols = t.columnas;
  const primeraTexto = cols.findIndex((c) => c.tipo === 'texto');

  // Ancho de cada columna: el texto mas largo que va a enseñar, con su minimo y su maximo.
  const anchos = cols.map((c, k) => {
    let largo = 0;
    for (const f of t.filas) {
      const estilo = f.estilo ?? 'normal';
      largo = Math.max(largo, largoVisible(f.celdas[k], c, estilo, k === primeraTexto ? (f.sangria ?? 0) : 0));
    }
    const necesario = Math.max(EXCEL_MIN[c.tipo], c.titulo.length + BOTON_FILTRO, largo + 2);
    return { ancho: Math.min(EXCEL_MAX[c.tipo], necesario), ajustar: c.tipo === 'texto' && necesario > EXCEL_MAX[c.tipo] };
  });
  const anchoTabla = anchos.reduce((s, a) => s + a.ancho, 0);
  /** Lineas que ocupa un texto en una celda (o en la fila combinada) de ese ancho. */
  const lineas = (texto: string, ancho: number, letra = 1.1) => Math.max(1, Math.ceil((texto.length * letra) / Math.max(1, ancho)));

  const filas: FilaHoja[] = [];
  const combinada = (v: string, estilo: FilaHoja['estilo'], letra: number): FilaHoja => ({ celdas: [{ v }], estilo, combinar: true, lineas: lineas(v, anchoTabla, letra) });
  filas.push(combinada(t.empresa.nombre + (t.empresa.nif ? ` (NIF ${t.empresa.nif})` : ''), 'subtitulo', 1.1));
  filas.push(combinada(t.titulo, 'titulo', 1.5));
  filas.push(combinada(t.periodo, 'subtitulo', 1.1));
  filas.push({ celdas: [] });
  const filaCabecera = filas.length;
  filas.push({ celdas: cols.map((c) => ({ v: c.titulo })), estilo: 'cabecera' });
  // Una fila de la hoja por fila de la tabla y una celda por columna, en su
  // sitio aunque este vacia: nada se corre de columna. El alto lo ajusta Excel.
  for (const f of t.filas) {
    const estilo = f.estilo ?? 'normal';
    filas.push({ celdas: cols.map((c, k) => celdaExcel(f.celdas[k], c, estilo)), estilo, sangria: f.sangria, colSangria: primeraTexto });
  }
  // El total final se queda fuera del autofiltro: al filtrar u ordenar sigue abajo y a la vista.
  const ultimaFilaDatos = filas.length - 1 - (t.filas[t.filas.length - 1]?.estilo === 'total' ? 1 : 0);
  if (t.notas?.length) {
    filas.push({ celdas: [] });
    for (const n of t.notas) filas.push(combinada(n, 'pie', 0.95));
  }

  const generado = `Generado el ${fechaES(hoyEspana())}`;
  return escribirHojaExcel({
    nombre: nombreDeHoja(t.titulo),
    columnas: cols.map((c, k) => ({
      ancho: anchos[k].ancho,
      ajustar: anchos[k].ajustar,
      alinear: c.tipo === 'importe' ? ('derecha' as const) : c.tipo === 'fecha' ? ('izquierda' as const) : undefined,
    })),
    filas,
    filaCabecera,
    ultimaFilaDatos,
    // Horizontal como el PDF, y tambien el diario; el balance y la PyG (3 columnas), en vertical.
    imprimir: { apaisado: !!t.apaisado || cols.length >= 5, pie: [t.empresa.nombre, t.titulo, t.periodo, generado].filter(Boolean).join(' · ') },
    propiedades: { titulo: `${t.titulo} · ${t.periodo}`, empresa: t.empresa.nombre },
  });
}
