/**
 * Descarga de los informes contables en PDF (PDF/A-2b) y Excel (.xlsx).
 *
 * Cada informe se describe una sola vez como TablaInforme (columnas y filas con
 * su estilo) y de ahi salen la vista en pantalla, el PDF y el Excel: las cifras
 * son las mismas en los tres.
 *
 * El PDF sigue el diseno de la factura (facturaPdf.service): tinta slate,
 * filetes finos, cifras en Geist Mono alineadas a la derecha y un unico acento
 * verde (#047857) bajo la cabecera. En Excel los importes son numeros (con
 * formato #,##0.00), no texto, para poder sumar y filtrar.
 */
import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { crearDocumentoPdfA, guardarPdfA } from '../utils/pdf-a';

export type TipoColumna = 'texto' | 'codigo' | 'fecha' | 'importe';

export interface ColumnaInforme {
  titulo: string;
  tipo: TipoColumna;
  /** Peso relativo del ancho (en el PDF se reparte el ancho util; en Excel, caracteres). */
  ancho: number;
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

const num = (n: number): string =>
  `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true })}`;
export const fechaES = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

export function textoPeriodo(desde: string, hasta: string): string {
  const anio = desde.slice(0, 4);
  if (desde === `${anio}-01-01` && hasta === `${anio}-12-31`) return `Ejercicio ${anio}`;
  return `Del ${fechaES(desde)} al ${fechaES(hasta)}`;
}

function textoCelda(v: string | number | null, tipo: TipoColumna): string {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'importe' && typeof v === 'number') return num(v);
  if (tipo === 'fecha' && typeof v === 'string') return fechaES(v);
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
const ALTO_FILA = 13;

export async function tablaAPdf(t: TablaInforme): Promise<Buffer> {
  const tituloDoc = `${t.titulo} · ${t.periodo}`;
  const { doc, normal, negrita, mono, monoNegrita, ancho: anchoA4, alto: altoA4 } = await crearDocumentoPdfA(tituloDoc);
  const [ancho, alto] = t.apaisado ? [altoA4, anchoA4] : [anchoA4, altoA4];
  const derecha = ancho - MARGEN;
  const anchoUtil = derecha - MARGEN;

  // Columnas: el ancho util se reparte segun el peso de cada una.
  const pesoTotal = t.columnas.reduce((s, c) => s + c.ancho, 0);
  const cols: Array<ColumnaInforme & { x: number; w: number }> = [];
  {
    let x = MARGEN;
    for (const c of t.columnas) {
      const w = (anchoUtil * c.ancho) / pesoTotal;
      cols.push({ ...c, x, w });
      x += w;
    }
  }
  const PAD = 4;

  type Estilo = { tam?: number; fuente?: PDFFont; color?: RGB; alinear?: 'izq' | 'der' };
  const texto = (pg: PDFPage, s: string, x: number, y: number, o: Estilo = {}) => {
    if (!s) return;
    const tam = o.tam ?? TAM;
    const fuente = o.fuente ?? normal;
    const xx = o.alinear === 'der' ? x - fuente.widthOfTextAtSize(s, tam) : x;
    pg.drawText(s, { x: xx, y, size: tam, font: fuente, color: o.color ?? TINTA });
  };
  const recortar = (s: string, fuente: PDFFont, tam: number, max: number): string => {
    if (fuente.widthOfTextAtSize(s, tam) <= max) return s;
    let r = s;
    while (r.length > 1 && fuente.widthOfTextAtSize(`${r}…`, tam) > max) r = r.slice(0, -1);
    return `${r.trimEnd()}…`;
  };
  const filete = (pg: PDFPage, y: number, grueso = 0.5, color = LINEA, x1 = MARGEN, x2 = derecha) =>
    pg.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: grueso, color });

  const paginas: PDFPage[] = [];
  let p!: PDFPage;
  let y = 0;

  const cabeceraColumnas = () => {
    for (const c of cols) {
      const der = c.tipo === 'importe';
      texto(p, c.titulo.toUpperCase(), der ? c.x + c.w - PAD : c.x + PAD, y - 10, { tam: 6.5, fuente: negrita, color: GRIS, alinear: der ? 'der' : 'izq' });
    }
    y -= 15;
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
      texto(p, t.titulo, MARGEN, y, { tam: 18, fuente: negrita });
      y -= 18;
      texto(p, t.periodo, MARGEN, y, { tam: 10, color: GRIS });
      y -= 12;
      filete(p, y, 1.25, ACENTO);
      y -= 14;
    } else {
      texto(p, t.empresa.nombre || 'Empresa', MARGEN, y, { tam: 8.5, fuente: negrita });
      texto(p, `${t.titulo} · ${t.periodo} (continuación)`, derecha, y, { tam: 8.5, color: GRIS, alinear: 'der' });
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
      // Una seccion (p. ej. una cuenta del mayor) ocupa toda la fila.
      y -= 6;
      p.drawRectangle({ x: MARGEN, y: y - ALTO_FILA + 3, width: anchoUtil, height: ALTO_FILA, color: FONDO_SECCION });
      const s = fila.celdas.map((c, k) => textoCelda(c, cols[k]?.tipo ?? 'texto')).filter(Boolean).join('  ·  ');
      texto(p, recortar(s, negrita, TAM + 0.5, anchoUtil - 2 * PAD), MARGEN + PAD, y - 7, { tam: TAM + 0.5, fuente: negrita });
      y -= ALTO_FILA + 2;
      continue;
    }

    if (estilo === 'total') {
      y -= 3;
      p.drawRectangle({ x: MARGEN, y: y - ALTO_FILA + 2, width: anchoUtil, height: ALTO_FILA + 2, color: ACENTO_SUAVE });
      filete(p, y + 2, 0.75, ACENTO);
    } else if (estilo === 'subtotal') {
      filete(p, y, 0.5, GRIS);
    }

    const fuerte = estilo === 'total' || estilo === 'subtotal';
    const yt = y - 9;
    cols.forEach((c, k) => {
      const bruto = fila.celdas[k] ?? null;
      // Los ceros de las filas normales se dejan en blanco: se leen mejor las cifras.
      if (estilo === 'normal' && c.tipo === 'importe' && bruto === 0) return;
      const v = textoCelda(bruto, c.tipo);
      if (!v) return;
      if (c.tipo === 'importe') {
        texto(p, v, c.x + c.w - PAD, yt, { fuente: fuerte ? monoNegrita : mono, alinear: 'der', color: estilo === 'nota' ? GRIS : TINTA });
      } else {
        const sangria = k === primeraTexto ? (fila.sangria ?? 0) * 10 : 0;
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
    for (const n of t.notas) {
      if (y - 12 < SUELO) nuevaPagina(false);
      texto(p, recortar(n, normal, 7.5, anchoUtil), MARGEN, y, { tam: 7.5, color: GRIS });
      y -= 11;
    }
  }

  const generado = `Generado el ${fechaES(new Date().toISOString().slice(0, 10))}`;
  const pie = [t.empresa.nombre, t.titulo, t.periodo].filter(Boolean).join(' · ');
  paginas.forEach((pg, i) => {
    texto(pg, `${pie} · ${generado}`, MARGEN, PIE_Y, { tam: 7, color: GRIS });
    texto(pg, `Página ${i + 1} de ${paginas.length}`, derecha, PIE_Y, { tam: 7, color: GRIS, alinear: 'der' });
  });

  return guardarPdfA(doc, tituloDoc);
}

// ---------- Excel ----------

const FORMATO_IMPORTE = '#,##0.00;-#,##0.00;""';

export function tablaAXlsx(t: TablaInforme): Buffer {
  const cabecera: Array<Array<string | number | Date | null>> = [
    [t.empresa.nombre + (t.empresa.nif ? ` (NIF ${t.empresa.nif})` : '')],
    [t.titulo],
    [t.periodo],
    [],
    t.columnas.map((c) => c.titulo),
  ];
  const filaCabecera = cabecera.length - 1;
  const cuerpo = t.filas.map((f) =>
    t.columnas.map((c, k) => {
      const v = f.celdas[k] ?? null;
      if (v === null || v === '') return null;
      if (c.tipo === 'importe') return typeof v === 'number' ? v : Number(v);
      if (c.tipo === 'fecha' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        return new Date(`${v}T00:00:00Z`);
      }
      // La sangria se ve tambien en Excel (espacios delante).
      const s = String(v);
      return k === 0 && f.sangria ? `${'   '.repeat(f.sangria)}${s}` : s;
    }),
  );
  const notas = t.notas?.length ? [[], ...t.notas.map((n) => [n])] : [];
  const ws = XLSX.utils.aoa_to_sheet([...cabecera, ...cuerpo, ...notas], { dateNF: 'dd/mm/yyyy', UTC: true } as XLSX.AOA2SheetOpts);

  // Formato de los importes y de las fechas.
  t.columnas.forEach((c, k) => {
    if (c.tipo !== 'importe' && c.tipo !== 'fecha') return;
    for (let r = filaCabecera + 1; r <= filaCabecera + cuerpo.length; r++) {
      const celda = ws[XLSX.utils.encode_cell({ r, c: k })];
      if (!celda) continue;
      if (c.tipo === 'importe' && celda.t === 'n') celda.z = FORMATO_IMPORTE;
      if (c.tipo === 'fecha' && (celda.t === 'n' || celda.t === 'd')) celda.z = 'dd/mm/yyyy';
    }
  });
  ws['!cols'] = t.columnas.map((c) => ({ wch: Math.max(c.titulo.length + 2, Math.round(c.ancho * (c.tipo === 'texto' ? 4 : 1.6))) }));
  ws['!autofilter'] = {
    ref: XLSX.utils.encode_range({ s: { r: filaCabecera, c: 0 }, e: { r: filaCabecera + Math.max(cuerpo.length, 1), c: t.columnas.length - 1 } }),
  };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.titulo.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  wb.Props = { Title: `${t.titulo} · ${t.periodo}`, Company: t.empresa.nombre };
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
