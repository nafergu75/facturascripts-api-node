/**
 * Huella (hash) de los registros de VERI*FACTU (spec verifactu, 3.5).
 *
 * Fuente: AEAT, «Detalle de las especificaciones técnicas para generación de
 * la huella o hash de los registros de facturación», v0.1.2 de 27/08/2024,
 * apartados 3 a 6, y Orden HAC/1177/2024, art. 13:
 *  - alta: 8 pares nombre=valor en este orden; anulacion: 5;
 *  - separados por «&»; un campo vacio o ausente queda como «nombre=»
 *    (en el primer registro, «Huella=&...»);
 *  - cada valor sin espacios al principio ni al final (los de en medio se quedan);
 *  - UTF-8, SHA-256 y hexadecimal en MAYUSCULAS de 64 caracteres.
 *
 * Los valores tienen que ser el texto EXACTO que va en el registro (el de
 * services/verifactu/formato.ts): la v0.1.2 dice que la AEAT trata igual
 * «123.1» y «123.10», pero SHA-256 no, asi que la app escribe siempre el mismo.
 */
import { createHash } from 'crypto';

const t = (v: string | null | undefined): string => (v ?? '').trim();

export interface CamposHuellaAlta {
  idEmisor: string;
  numSerie: string;
  /** dd-mm-aaaa */
  fecha: string;
  tipoFactura: string;
  cuotaTotal: string;
  importeTotal: string;
  /** '' en el primer registro de la cadena. */
  huellaAnterior: string;
  fechaHoraHuso: string;
}

export interface CamposHuellaAnulacion {
  idEmisor: string;
  numSerie: string;
  fecha: string;
  huellaAnterior: string;
  fechaHoraHuso: string;
}

/** Cadena de un registro de alta (apdo. 3.a de la especificacion). */
export function cadenaAlta(r: CamposHuellaAlta): string {
  return (
    `IDEmisorFactura=${t(r.idEmisor)}&NumSerieFactura=${t(r.numSerie)}&FechaExpedicionFactura=${t(r.fecha)}` +
    `&TipoFactura=${t(r.tipoFactura)}&CuotaTotal=${t(r.cuotaTotal)}&ImporteTotal=${t(r.importeTotal)}` +
    `&Huella=${t(r.huellaAnterior)}&FechaHoraHusoGenRegistro=${t(r.fechaHoraHuso)}`
  );
}

/** Cadena de un registro de anulacion (apdo. 3.b). */
export function cadenaAnulacion(r: CamposHuellaAnulacion): string {
  return (
    `IDEmisorFacturaAnulada=${t(r.idEmisor)}&NumSerieFacturaAnulada=${t(r.numSerie)}` +
    `&FechaExpedicionFacturaAnulada=${t(r.fecha)}&Huella=${t(r.huellaAnterior)}&FechaHoraHusoGenRegistro=${t(r.fechaHoraHuso)}`
  );
}

/** SHA-256 de la cadena en UTF-8, en hexadecimal y mayusculas (apdo. 5). */
export function huella(cadena: string): string {
  return createHash('sha256').update(cadena, 'utf8').digest('hex').toUpperCase();
}

/** true si es una huella con el formato de salida: 64 caracteres [0-9A-F]. */
export function esHuella(texto: unknown): texto is string {
  return typeof texto === 'string' && /^[0-9A-F]{64}$/.test(texto);
}
