/**
 * Hoja de Excel (.xlsx) con estilos, sin dependencias nuevas.
 *
 * SheetJS CE (la libreria que ya usamos) no escribe estilos: ni negrita, ni
 * rellenos, ni bordes, ni filas inmovilizadas, ni la preparacion de la pagina.
 * Aqui el XML de SpreadsheetML se escribe a mano y se empaqueta con el ZIP que
 * trae SheetJS (XLSX.CFB). Solo cubre lo que necesitan los informes:
 *
 *  - una hoja con textos, numeros con formato y fechas;
 *  - estilos de fila (titulo, cabecera, seccion, subtotal, total, nota, pie);
 *  - anchos de columna, alineacion a la derecha, texto ajustado y sangria;
 *  - autofiltro, filas inmovilizadas y celdas combinadas;
 *  - impresion: orientacion, ajustada a una pagina de ancho, titulos de columna
 *    en cada pagina y pie con el numero de pagina.
 *
 * Los textos van como cadenas en linea (inlineStr): Excel las lee igual que las
 * compartidas y las convierte al guardar.
 */
import * as XLSX from 'xlsx';

export type EstiloFilaHoja = 'normal' | 'titulo' | 'subtitulo' | 'cabecera' | 'seccion' | 'subtotal' | 'total' | 'nota' | 'pie';

/** importe: los ceros se ven en blanco; importeConCero: el 0,00 se ve; fecha: dd/mm/aaaa. */
export type FormatoCelda = 'importe' | 'importeConCero' | 'fecha';

export interface CeldaHoja {
  /** Texto, numero o fecha (Date en UTC: solo cuenta el dia). null: celda vacia con el estilo de la fila. */
  v: string | number | Date | null;
  formato?: FormatoCelda;
}

export interface ColumnaHoja {
  /** Ancho en caracteres. */
  ancho: number;
  /**
   * Alineacion de la columna, tambien la de su titulo, para que quede encima
   * de los datos: a la derecha los importes; a la izquierda las fechas (Excel
   * las pondria a la derecha, lejos del titulo). Sin ella, la de Excel.
   */
  alinear?: 'izquierda' | 'derecha';
  /** Texto ajustado en varias lineas si no cabe. */
  ajustar?: boolean;
}

export interface FilaHoja {
  celdas: CeldaHoja[];
  estilo?: EstiloFilaHoja;
  /** Sangria (niveles) de la celda de la columna `colSangria`. */
  sangria?: number;
  colSangria?: number;
  /** Combina toda la fila (titulos y notas al pie). */
  combinar?: boolean;
  /**
   * Alto en lineas. Solo hace falta en las filas combinadas: en las demas, sin
   * alto fijo, Excel ajusta el alto al abrir segun el texto ajustado.
   */
  lineas?: number;
}

export interface HojaExcel {
  nombre: string;
  columnas: ColumnaHoja[];
  filas: FilaHoja[];
  /** Fila (desde 0) con los titulos de columna: se inmoviliza, lleva el autofiltro y se repite al imprimir. */
  filaCabecera?: number;
  /** Ultima fila (desde 0) que entra en el autofiltro. */
  ultimaFilaDatos?: number;
  imprimir?: { apaisado?: boolean; pie?: string };
  propiedades?: { titulo?: string; empresa?: string };
}

// ---------- Estilos ----------

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CABECERA_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const FORMATOS: Record<FormatoCelda, number> = { importe: 164, importeConCero: 165, fecha: 166 };
const NUM_FMTS =
  '<numFmts count="3">' +
  '<numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00;&quot;&quot;"/>' +
  '<numFmt numFmtId="165" formatCode="#,##0.00;-#,##0.00"/>' +
  '<numFmt numFmtId="166" formatCode="dd/mm/yyyy"/>' +
  '</numFmts>';

const fuente = (o: { b?: boolean; sz: number; color?: string }) =>
  `<font>${o.b ? '<b/>' : ''}<sz val="${o.sz}"/>${o.color ? `<color rgb="FF${o.color}"/>` : '<color theme="1"/>'}<name val="Calibri"/><family val="2"/><scheme val="minor"/></font>`;
// 0 normal, 1 negrita, 2 titulo, 3 gris (nota), 4 pie pequeño gris
const FUENTES = [fuente({ sz: 11 }), fuente({ b: true, sz: 11, color: '0F172A' }), fuente({ b: true, sz: 14, color: '0F172A' }), fuente({ sz: 11, color: '475569' }), fuente({ sz: 9, color: '64748B' })];

const relleno = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`;
// 0 y 1 los exige Excel; 2 cabecera, 3 total, 4 seccion
const RELLENOS = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>', relleno('E2E8F0'), relleno('D1FAE5'), relleno('F1F5F9')];

const borde = (lado: 'top' | 'bottom' | null, estilo = 'thin', rgb = '000000') => {
  const l = (n: string) => (lado === n ? `<${n} style="${estilo}"><color rgb="FF${rgb}"/></${n}>` : `<${n}/>`);
  return `<border>${l('left')}${l('right')}${l('top')}${l('bottom')}<diagonal/></border>`;
};
// 0 sin borde, 1 bajo la cabecera, 2 sobre el subtotal, 3 sobre el total
const BORDES = [borde(null), borde('bottom', 'thin', '0F172A'), borde('top', 'thin', '94A3B8'), borde('top', 'medium', '047857')];

const POR_ESTILO: Record<EstiloFilaHoja, { fuente: number; relleno: number; borde: number }> = {
  normal: { fuente: 0, relleno: 0, borde: 0 },
  titulo: { fuente: 2, relleno: 0, borde: 0 },
  subtitulo: { fuente: 3, relleno: 0, borde: 0 },
  cabecera: { fuente: 1, relleno: 2, borde: 1 },
  seccion: { fuente: 1, relleno: 4, borde: 0 },
  subtotal: { fuente: 1, relleno: 0, borde: 2 },
  total: { fuente: 1, relleno: 3, borde: 3 },
  nota: { fuente: 3, relleno: 0, borde: 0 },
  pie: { fuente: 4, relleno: 0, borde: 0 },
};

interface Xf {
  fuente: number;
  relleno: number;
  borde: number;
  formato: number;
  alinear: '' | 'left' | 'right';
  ajustar: boolean;
  sangria: number;
  arriba: boolean;
}

function xfXml(x: Xf): string {
  const alin: string[] = [];
  if (x.alinear) alin.push(`horizontal="${x.alinear}"`);
  else if (x.sangria) alin.push('horizontal="left"');
  if (x.arriba) alin.push('vertical="top"');
  if (x.ajustar) alin.push('wrapText="1"');
  if (x.sangria) alin.push(`indent="${x.sangria}"`);
  const atr =
    `numFmtId="${x.formato}" fontId="${x.fuente}" fillId="${x.relleno}" borderId="${x.borde}" xfId="0"` +
    `${x.formato ? ' applyNumberFormat="1"' : ''}${x.fuente ? ' applyFont="1"' : ''}${x.relleno ? ' applyFill="1"' : ''}${x.borde ? ' applyBorder="1"' : ''}` +
    `${alin.length ? ' applyAlignment="1"' : ''}`;
  return alin.length ? `<xf ${atr}><alignment ${alin.join(' ')}/></xf>` : `<xf ${atr}/>`;
}

// ---------- Utilidades ----------

/** Quita los caracteres que no admite XML y escapa los especiales. */
export function escaparXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function letraColumna(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Numero de serie de Excel de un dia (sistema 1900). */
function serieExcel(d: Date): number {
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

/** Nombre de hoja valido: sin []:*?/\, sin comillas al principio o al final y como mucho 31 caracteres. */
export function nombreHoja(nombre: string): string {
  const limpio = nombre.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).replace(/^'+|'+$/g, '').trim();
  return limpio || 'Informe';
}

/** Texto del pie de pagina: el & es un codigo de Excel y se dobla. */
const textoPie = (s: string) => escaparXml(s.replace(/&/g, '&&').slice(0, 200));

// ---------- Escritura ----------

export function escribirHojaExcel(h: HojaExcel): Buffer {
  const ncols = Math.max(1, h.columnas.length);
  const ultimaCol = letraColumna(ncols - 1);
  const hoja = nombreHoja(h.nombre);
  const hojaRef = `'${hoja.replace(/'/g, "''")}'`;

  // Estilos de celda (cellXfs) segun se usan; el 0 es el normal.
  const xfs: Xf[] = [{ fuente: 0, relleno: 0, borde: 0, formato: 0, alinear: '', ajustar: false, sangria: 0, arriba: false }];
  const indiceXf = new Map<string, number>([[JSON.stringify(xfs[0]), 0]]);
  const xf = (x: Xf): number => {
    const k = JSON.stringify(x);
    let i = indiceXf.get(k);
    if (i === undefined) {
      i = xfs.push(x) - 1;
      indiceXf.set(k, i);
    }
    return i;
  };

  const filasXml: string[] = [];
  const combinadas: string[] = [];
  h.filas.forEach((f, r) => {
    const estilo = f.estilo ?? 'normal';
    const base = POR_ESTILO[estilo];
    const fila = r + 1;
    const datos = estilo === 'normal' || estilo === 'nota' || estilo === 'seccion' || estilo === 'subtotal' || estilo === 'total';
    const celdas: string[] = [];
    // Las filas con fondo o borde llevan el estilo en todas sus columnas.
    const todas = estilo === 'cabecera' || estilo === 'seccion' || estilo === 'subtotal' || estilo === 'total' || !!f.combinar;
    const hasta = todas ? ncols : f.celdas.length;
    for (let c = 0; c < hasta; c++) {
      const celda = f.celdas[c] ?? { v: null };
      const col = h.columnas[c] ?? { ancho: 10 };
      const ref = `${letraColumna(c)}${fila}`;
      const v = celda.v;
      const esFecha = v instanceof Date && !Number.isNaN(v.getTime());
      const esNumero = typeof v === 'number' && Number.isFinite(v);
      const formato = esFecha ? FORMATOS.fecha : esNumero && celda.formato ? FORMATOS[celda.formato] : 0;
      const s = xf({
        ...base,
        // En una nota (la fila «Saldo inicial»), el texto en gris y la cifra en tinta normal, como en el PDF.
        fuente: estilo === 'nota' && (esNumero || esFecha) ? POR_ESTILO.normal.fuente : base.fuente,
        formato,
        alinear: !f.combinar && col.alinear && (datos || estilo === 'cabecera') ? (col.alinear === 'derecha' ? 'right' : 'left') : '',
        ajustar: (!!col.ajustar && (datos || estilo === 'cabecera')) || (!!f.combinar && (f.lineas ?? 1) > 1),
        sangria: c === (f.colSangria ?? -1) ? Math.min(15, f.sangria ?? 0) : 0,
        arriba: datos || !!f.combinar,
      });
      const atrS = s ? ` s="${s}"` : '';
      if (esFecha) celdas.push(`<c r="${ref}"${atrS}><v>${serieExcel(v as Date)}</v></c>`);
      else if (esNumero) celdas.push(`<c r="${ref}"${atrS}><v>${v}</v></c>`);
      else if (typeof v === 'string' && v !== '') {
        const t = escaparXml(v.slice(0, 32_767));
        celdas.push(`<c r="${ref}"${atrS} t="inlineStr"><is><t xml:space="preserve">${t}</t></is></c>`);
      } else if (s) celdas.push(`<c r="${ref}"${atrS}/>`);
    }
    const lineas = Math.max(1, f.lineas ?? 1);
    const alto = estilo === 'titulo' ? 21 : lineas > 1 ? Math.ceil(lineas * (estilo === 'pie' ? 12.5 : 15)) : 0;
    filasXml.push(`<row r="${fila}"${alto ? ` ht="${alto}" customHeight="1"` : ''}>${celdas.join('')}</row>`);
    if (f.combinar && ncols > 1) combinadas.push(`A${fila}:${ultimaCol}${fila}`);
  });

  const cab = h.filaCabecera;
  const hayCabecera = cab !== undefined && cab >= 0 && cab < h.filas.length;
  const finDatos = hayCabecera ? Math.max(cab!, Math.min(h.ultimaFilaDatos ?? cab!, h.filas.length - 1)) : 0;
  const rangoFiltro = hayCabecera ? `A${cab! + 1}:${ultimaCol}${finDatos + 1}` : '';
  const ultimaFila = Math.max(1, h.filas.length);

  const vista = hayCabecera
    ? `<sheetView workbookViewId="0" tabSelected="1"><pane ySplit="${cab! + 1}" topLeftCell="A${cab! + 2}" activePane="bottomLeft" state="frozen"/>` +
      `<selection pane="bottomLeft" activeCell="A${cab! + 2}" sqref="A${cab! + 2}"/></sheetView>`
    : '<sheetView workbookViewId="0" tabSelected="1"/>';
  const cols = h.columnas
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(1, Math.round((c.ancho + 0.71) * 100) / 100)}" customWidth="1"/>`)
    .join('');
  // Un espacio tras &8 si el texto empieza por una cifra: «&83D…» seria letra de tamaño 83.
  const pie = h.imprimir?.pie ? `&amp;L&amp;8${/^\d/.test(h.imprimir.pie) ? ' ' : ''}${textoPie(h.imprimir.pie)}` : '';
  const hojaXml =
    CABECERA_XML +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>' +
    `<dimension ref="A1:${ultimaCol}${ultimaFila}"/>` +
    `<sheetViews>${vista}</sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${filasXml.join('')}</sheetData>` +
    (rangoFiltro ? `<autoFilter ref="${rangoFiltro}"/>` : '') +
    (combinadas.length ? `<mergeCells count="${combinadas.length}">${combinadas.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '') +
    '<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.7" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="9" orientation="${h.imprimir?.apaisado ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>` +
    `<headerFooter><oddFooter>${pie}&amp;R&amp;8Página &amp;P de &amp;N</oddFooter></headerFooter>` +
    '</worksheet>';

  const nombres = [
    ...(rangoFiltro ? [`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${escaparXml(hojaRef)}!$A$${cab! + 1}:$${ultimaCol}$${finDatos + 1}</definedName>`] : []),
    ...(hayCabecera ? [`<definedName name="_xlnm.Print_Titles" localSheetId="0">${escaparXml(hojaRef)}!$${cab! + 1}:$${cab! + 1}</definedName>`] : []),
  ];
  const libroXml =
    CABECERA_XML +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000"/></bookViews>' +
    `<sheets><sheet name="${escaparXml(hoja)}" sheetId="1" r:id="rId1"/></sheets>` +
    (nombres.length ? `<definedNames>${nombres.join('')}</definedNames>` : '') +
    '</workbook>';

  const estilosXml =
    CABECERA_XML +
    `<styleSheet xmlns="${NS_MAIN}">` +
    NUM_FMTS +
    `<fonts count="${FUENTES.length}">${FUENTES.join('')}</fonts>` +
    `<fills count="${RELLENOS.length}">${RELLENOS.join('')}</fills>` +
    `<borders count="${BORDES.length}">${BORDES.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.map(xfXml).join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    '</styleSheet>';

  const ahora = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coreXml =
    CABECERA_XML +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    (h.propiedades?.titulo ? `<dc:title>${escaparXml(h.propiedades.titulo)}</dc:title>` : '') +
    '<dc:creator>conta-api</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${ahora}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${ahora}</dcterms:modified>` +
    '</cp:coreProperties>';
  const appXml =
    CABECERA_XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>conta-api</Application>' +
    (h.propiedades?.empresa ? `<Company>${escaparXml(h.propiedades.empresa)}</Company>` : '') +
    '</Properties>';

  const tipos =
    CABECERA_XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>';
  const rels =
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
  const relsLibro =
    CABECERA_XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const zip = XLSX.CFB.utils.cfb_new();
  const poner = (ruta: string, xml: string) => XLSX.CFB.utils.cfb_add(zip, ruta, Buffer.from(xml, 'utf8'));
  poner('[Content_Types].xml', tipos);
  poner('_rels/.rels', rels);
  poner('docProps/core.xml', coreXml);
  poner('docProps/app.xml', appXml);
  poner('xl/workbook.xml', libroXml);
  poner('xl/_rels/workbook.xml.rels', relsLibro);
  poner('xl/styles.xml', estilosXml);
  poner('xl/worksheets/sheet1.xml', hojaXml);
  return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }) as Uint8Array);
}
