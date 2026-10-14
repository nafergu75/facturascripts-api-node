/**
 * QR de VERI*FACTU (spec verifactu, 5.1; documento tecnico del QR v0.5.0 de la
 * AEAT, apdos. 4 a 6). Funciones puras.
 *
 * La URL de cotejo lleva solo nif, numserie, fecha e importe, en ese orden, y
 * se toman SIEMPRE del registro de alta guardado (nunca de la factura en el
 * momento). El host sale del entorno del registro: PRODUCCION -> www2 de la
 * AEAT; PRUEBAS -> prewww2. Nunca se añaden formato ni idioma.
 *
 * Cada valor se codifica como el URLEncoder.encode(v, "UTF-8") de Java (el que
 * usa la AEAT en sus ejemplos): espacio -> «+», y «! ' ( ) ~» en %XX.
 */
import QRCode from 'qrcode';
import type { EntornoVerifactu } from './cadena';

export const HOST_COTEJO: Record<EntornoVerifactu, string> = {
  PRODUCCION: 'https://www2.agenciatributaria.gob.es',
  PRUEBAS: 'https://prewww2.aeat.es',
};
export const RUTA_COTEJO = '/wlpl/TIKE-CONT/ValidarQR';

/** Codificacion de URLEncoder.encode(v, "UTF-8") de Java: deja A-Z a-z 0-9 . - * _ y el espacio pasa a «+». */
export function codificarComoJava(v: string): string {
  return encodeURIComponent(v)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Lo que hace falta del registro de alta guardado. */
export interface RegistroCotejo {
  entorno: string;
  idEmisor: string;
  numSerie: string;
  /** dd-mm-aaaa */
  fechaExpedicion: string;
  /** Texto exacto del registro, con dos decimales (p. ej. «241.40»). */
  importeTotal: string;
}

const NUM_SERIE = /^[\x20-\x7E]{1,60}$/;
const FECHA = /^\d{2}-\d{2}-\d{4}$/;
const IMPORTE = /^-?\d{1,12}\.\d{2}$/;

/** URL de cotejo del QR de una factura con registro de alta. Lanza si el registro no tiene la forma de la AEAT. */
export function urlCotejo(r: RegistroCotejo): string {
  const host = (HOST_COTEJO as Record<string, string | undefined>)[r.entorno];
  if (!host) throw new Error(`QR de VERI*FACTU: entorno desconocido (${r.entorno}).`);
  if (typeof r.idEmisor !== 'string' || r.idEmisor.length !== 9) throw new Error('QR de VERI*FACTU: el NIF del emisor tiene que tener 9 caracteres.');
  if (!NUM_SERIE.test(r.numSerie ?? '')) throw new Error('QR de VERI*FACTU: el número de factura no es válido para la AEAT.');
  if (!FECHA.test(r.fechaExpedicion ?? '')) throw new Error('QR de VERI*FACTU: la fecha tiene que ser dd-mm-aaaa.');
  if (!IMPORTE.test(r.importeTotal ?? '')) throw new Error('QR de VERI*FACTU: el importe tiene que llevar punto y dos decimales.');
  const q = [
    ['nif', r.idEmisor],
    ['numserie', r.numSerie],
    ['fecha', r.fechaExpedicion],
    ['importe', r.importeTotal],
  ]
    .map(([k, v]) => `${k}=${codificarComoJava(v)}`)
    .join('&');
  return `${host}${RUTA_COTEJO}?${q}`;
}

/** Matriz del QR (ISO/IEC 18004) con corrección de errores M: `n` modulos por lado. */
export interface MatrizQr {
  n: number;
  oscuro: (fila: number, col: number) => boolean;
}

export function matrizQr(url: string): MatrizQr {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const m = qr.modules;
  return { n: m.size, oscuro: (fila, col) => m.get(fila, col) === 1 };
}

/** Tramo de modulos oscuros seguidos de una fila. */
export interface TramoQr {
  fila: number;
  col: number;
  largo: number;
}

/** Une los modulos oscuros contiguos de cada fila (un rectangulo por tramo al dibujar). */
export function tramosQr(m: MatrizQr): TramoQr[] {
  const tramos: TramoQr[] = [];
  for (let fila = 0; fila < m.n; fila++) {
    let inicio = -1;
    for (let col = 0; col <= m.n; col++) {
      const o = col < m.n && m.oscuro(fila, col);
      if (o && inicio < 0) inicio = col;
      if (!o && inicio >= 0) {
        tramos.push({ fila, col: inicio, largo: col - inicio });
        inicio = -1;
      }
    }
  }
  return tramos;
}
