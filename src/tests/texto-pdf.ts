/**
 * Lee los textos de un PDF hecho con pdf-lib (los informes contables), con su
 * posicion, para comprobar en los tests que cada cifra cae bajo su titulo de
 * columna. No es un lector general de PDF: entiende lo que escribe pdf-lib con
 * fuentes incrustadas (Tf, Tm y <hex> Tj, con su ToUnicode y sus anchos /W).
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export interface TextoPdf {
  pagina: number;
  texto: string;
  /** Borde izquierdo, borde derecho y linea base, en puntos. */
  x: number;
  derecha: number;
  y: number;
  tam: number;
}

interface FuentePdf {
  unicode: Map<number, string>;
  anchos: Map<number, number>;
  porDefecto: number;
}

const hexATexto = (h: string) => String.fromCodePoint(...(h.match(/.{4}/g) ?? []).map((x) => parseInt(x, 16)));

function leerFuente(doc: PDFDocument, dict: PDFDict): FuentePdf {
  const unicode = new Map<number, string>();
  const tu = dict.lookup(PDFName.of('ToUnicode'));
  if (tu instanceof PDFRawStream) {
    const cmap = Buffer.from(decodePDFRawStream(tu).decode()).toString('latin1');
    for (const bloque of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      for (const m of bloque.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) unicode.set(parseInt(m[1], 16), hexATexto(m[2]));
    }
    for (const bloque of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      for (const m of bloque.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const [a, b, c] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
        for (let g = a; g <= b; g++) unicode.set(g, String.fromCodePoint(c + g - a));
      }
    }
  }
  const anchos = new Map<number, number>();
  let porDefecto = 1000;
  const descendientes = dict.lookup(PDFName.of('DescendantFonts'));
  const cid = descendientes instanceof PDFArray ? descendientes.lookup(0) : null;
  if (cid instanceof PDFDict) {
    const dw = cid.lookup(PDFName.of('DW'));
    if (dw instanceof PDFNumber) porDefecto = dw.asNumber();
    const w = cid.lookup(PDFName.of('W'));
    if (w instanceof PDFArray) {
      const el = w.asArray().map((e) => doc.context.lookup(e));
      for (let i = 0; i < el.length; ) {
        const inicio = (el[i] as PDFNumber).asNumber();
        const siguiente = el[i + 1];
        if (siguiente instanceof PDFArray) {
          siguiente.asArray().forEach((x, j) => anchos.set(inicio + j, (doc.context.lookup(x) as PDFNumber).asNumber()));
          i += 2;
        } else {
          const fin = (siguiente as PDFNumber).asNumber();
          const ancho = (el[i + 2] as PDFNumber).asNumber();
          for (let g = inicio; g <= fin; g++) anchos.set(g, ancho);
          i += 3;
        }
      }
    }
  }
  return { unicode, anchos, porDefecto };
}

export async function textosDePdf(pdf: Uint8Array): Promise<TextoPdf[]> {
  const doc = await PDFDocument.load(pdf);
  const salida: TextoPdf[] = [];
  doc.getPages().forEach((pagina, i) => {
    const fuentes = new Map<string, FuentePdf>();
    const dictFuentes = pagina.node.Resources()?.lookup(PDFName.of('Font'));
    if (dictFuentes instanceof PDFDict) {
      for (const [nombre, ref] of dictFuentes.entries()) {
        const f = doc.context.lookup(ref);
        if (f instanceof PDFDict) fuentes.set(nombre.asString().replace(/^\//, ''), leerFuente(doc, f));
      }
    }
    const contenido = pagina.node.Contents();
    const flujos = contenido instanceof PDFArray ? contenido.asArray().map((r) => doc.context.lookup(r)) : [contenido];
    const texto = flujos
      .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
      .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1'))
      .join('\n');
    let fuente: FuentePdf | undefined;
    let tam = 0;
    let x = 0;
    let y = 0;
    const ops = /\/([^\s/]+)\s+([\d.]+)\s+Tf|([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm|<([0-9A-Fa-f]*)>\s*Tj/g;
    for (const m of texto.matchAll(ops)) {
      if (m[1]) {
        fuente = fuentes.get(m[1]);
        tam = Number(m[2]);
      } else if (m[3] !== undefined) {
        x = Number(m[7]);
        y = Number(m[8]);
      } else if (m[9] !== undefined && fuente) {
        const glifos = (m[9].match(/.{4}/g) ?? []).map((h) => parseInt(h, 16));
        const t = glifos.map((g) => fuente!.unicode.get(g) ?? '').join('');
        const ancho = glifos.reduce((s, g) => s + (fuente!.anchos.get(g) ?? fuente!.porDefecto), 0) * (tam / 1000);
        salida.push({ pagina: i + 1, texto: t, x, derecha: x + ancho, y, tam });
      }
    }
  });
  return salida;
}

/** Los textos de cada linea (misma pagina y misma altura), de izquierda a derecha. */
export function lineasDePdf(textos: TextoPdf[]): TextoPdf[][] {
  const mapa = new Map<string, TextoPdf[]>();
  for (const t of textos) {
    const k = `${t.pagina}|${t.y.toFixed(1)}`;
    mapa.set(k, [...(mapa.get(k) ?? []), t]);
  }
  return [...mapa.values()]
    .sort((a, b) => a[0].pagina - b[0].pagina || b[0].y - a[0].y)
    .map((l) => l.sort((a, b) => a.x - b.x));
}
