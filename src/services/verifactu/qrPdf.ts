/**
 * Bloque del QR de VERI*FACTU en el PDF de la factura (spec verifactu, 5.2;
 * Orden HAC/1177/2024, art. 21; documento tecnico del QR v0.5.0, apdo. 3):
 *
 *   «QR tributario:»            (encima, en negrita)
 *   [ 6 mm en blanco ]
 *   [ QR de 35 x 35 mm, nivel M ]
 *   [ 6 mm en blanco ]
 *   «Factura verificable en la sede electrónica de la AEAT»  (debajo, partida)
 *
 * Los modulos se dibujan como rectangulos vectoriales con pdf-lib (sin
 * imagenes: vale para PDF/A-2b). La letra de los dos textos la decide cada
 * plantilla (igual o mayor que la de sus datos). Va solo en la primera pagina.
 */
import { rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { matrizQr, tramosQr } from './qr';

const mm = (x: number) => (x * 72) / 25.4;

/** Lado del QR: 35 mm (la norma admite de 30 a 40). */
export const LADO_QR_PT = mm(35);
/** Zona en blanco recomendada alrededor del QR. */
export const MARGEN_QR_PT = mm(6);
/** Zona en blanco minima (2 mm). */
export const MARGEN_QR_MIN_PT = mm(2);
export const TITULO_QR = 'QR tributario:';
export const LEYENDA_QR = 'Factura verificable en la sede electrónica de la AEAT';
/** Ancho del bloque con el margen recomendado. */
export const ANCHO_BLOQUE_QR = LADO_QR_PT + 2 * MARGEN_QR_PT;

const NEGRO = rgb(0, 0, 0);
const BLANCO = rgb(1, 1, 1);

export interface FuentesQr {
  normal: PDFFont;
  negrita: PDFFont;
}

/** Caja en puntos de pdf-lib (origen abajo a la izquierda). */
export interface Caja {
  x: number;
  y: number;
  ancho: number;
  alto: number;
}

export interface MedidaBloqueQr {
  ancho: number;
  alto: number;
  margen: number;
  /** Alto de una linea de texto (titulo y leyenda). */
  linea: number;
  lineasLeyenda: string[];
}

/** Parte un texto por palabras para que cada linea quepa en `ancho`. */
function partirPalabras(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  const lineas: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/\s+/).filter(Boolean)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (!actual || fuente.widthOfTextAtSize(prueba, tam) <= ancho) actual = prueba;
    else {
      lineas.push(actual);
      actual = palabra;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

/**
 * Medidas del bloque con la letra `tam`. El ancho es el QR con su margen
 * (133,2 pt) o, si no cabe en `anchoMax`, el QR con el margen que quepa
 * (nunca menos de 2 mm).
 */
export function medirBloqueQr(f: FuentesQr & { tam: number; anchoMax?: number }): MedidaBloqueQr {
  const anchoMax = f.anchoMax ?? ANCHO_BLOQUE_QR;
  const margen = Math.max(MARGEN_QR_MIN_PT, Math.min(MARGEN_QR_PT, (anchoMax - LADO_QR_PT) / 2));
  const ancho = LADO_QR_PT + 2 * margen;
  const linea = f.tam * 1.2;
  const lineasLeyenda = partirPalabras(LEYENDA_QR, f.normal, f.tam, ancho);
  return { ancho, alto: linea + ancho + lineasLeyenda.length * linea, margen, linea, lineasLeyenda };
}

export interface CajasBloqueQr {
  /** El QR (sin la zona en blanco). */
  cajaQr: Caja;
  /** El QR con su zona en blanco. */
  cajaBlanca: Caja;
  /** «QR tributario:». */
  cajaTitulo: Caja;
  /** La leyenda (todas sus lineas). */
  cajaLeyenda: Caja;
  /** El bloque entero. */
  cajaBloque: Caja;
  medida: MedidaBloqueQr;
}

/**
 * Donde va cada parte del bloque centrado en `xCentro`, con su borde de arriba
 * en `yArriba` (coordenadas de pdf-lib). Sin dibujar: la usan el dibujo, las
 * plantillas (para colocar lo demas) y los tests.
 */
export function calcularBloqueQr(o: FuentesQr & { xCentro: number; yArriba: number; tam: number; anchoMax?: number }): CajasBloqueQr {
  const medida = medirBloqueQr(o);
  const { ancho, margen, linea, lineasLeyenda } = medida;
  const x0 = o.xCentro - ancho / 2;
  const cajaTitulo: Caja = { x: x0, y: o.yArriba - linea, ancho, alto: linea };
  const cajaBlanca: Caja = { x: x0, y: cajaTitulo.y - ancho, ancho, alto: ancho };
  const cajaQr: Caja = { x: x0 + margen, y: cajaBlanca.y + margen, ancho: LADO_QR_PT, alto: LADO_QR_PT };
  const cajaLeyenda: Caja = { x: x0, y: cajaBlanca.y - lineasLeyenda.length * linea, ancho, alto: lineasLeyenda.length * linea };
  return { cajaQr, cajaBlanca, cajaTitulo, cajaLeyenda, cajaBloque: { x: x0, y: o.yArriba - medida.alto, ancho, alto: medida.alto }, medida };
}

/**
 * Dibuja el bloque (ver calcularBloqueQr) y devuelve sus cajas. La zona en
 * blanco se pinta de blanco: tapa la marca de agua que haya debajo.
 */
export function dibujarBloqueQr(
  page: PDFPage,
  o: FuentesQr & { xCentro: number; yArriba: number; url: string; tam: number; anchoMax?: number; color?: RGB },
): CajasBloqueQr {
  const cajas = calcularBloqueQr(o);
  const { linea, lineasLeyenda } = cajas.medida;
  const color = o.color ?? NEGRO;
  // Linea base de un texto que ocupa una linea con su borde de arriba en `arriba`.
  const base = (arriba: number, fuente: PDFFont) => arriba - (linea - fuente.heightAtSize(o.tam)) / 2 - fuente.heightAtSize(o.tam, { descender: false });
  const centrado = (s: string, fuente: PDFFont, arriba: number) =>
    page.drawText(s, { x: o.xCentro - fuente.widthOfTextAtSize(s, o.tam) / 2, y: base(arriba, fuente), size: o.tam, font: fuente, color });

  centrado(TITULO_QR, o.negrita, o.yArriba);
  const b = cajas.cajaBlanca;
  page.drawRectangle({ x: b.x, y: b.y, width: b.ancho, height: b.alto, color: BLANCO });
  const m = matrizQr(o.url);
  const modulo = LADO_QR_PT / m.n;
  const arribaQr = cajas.cajaQr.y + LADO_QR_PT;
  for (const t of tramosQr(m)) {
    page.drawRectangle({ x: cajas.cajaQr.x + t.col * modulo, y: arribaQr - (t.fila + 1) * modulo, width: t.largo * modulo, height: modulo, color });
  }
  lineasLeyenda.forEach((l, i) => centrado(l, o.normal, b.y - i * linea));
  return cajas;
}

/** Marca de agua de las facturas del entorno de pruebas (y de las empresas de pruebas). */
export const MARCA_PRUEBAS = 'PRUEBAS – SIN VALIDEZ';
