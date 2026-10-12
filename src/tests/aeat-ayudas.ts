/**
 * Ayudas de los tests de ficheros de la AEAT: atajos sobre las funciones que
 * usan la pantalla y la descarga (no hay otro generador). Sustituyen a los
 * generadores antiguos de impuestosExport.service, retirados en B7.
 */
import type { DatosModelo111, DatosModelo115, DatosModelo303, PeriodoFiscal } from '../domain/impuestos.model';
import { casillasDeDatos111, casillasDeDatos115, construirDeclaracion, ficheroDeclaracion, type OpcionesDeclaracion } from '../services/aeatRetenciones/declaracion';
import { montarBorrador303, pagina1Borrador303, pagina3Borrador303, type ContextoEmpresa303 } from '../services/modelo303.service';
import { filasRegimenGeneral303 } from '../domain/impuestos.model';
import { badRequest } from '../utils/http-errors';

/** Sociedad de territorio comun en regimen general, sin REDEME, SII ni criterio de caja. */
export const contexto303 = (nif = '', razonSocial = ''): ContextoEmpresa303 => ({ nif, razonSocial, redeme: false, sii: false, criterioCaja: false, iban: null });

/** Pagina 3 del 303 (informacion adicional y resultado) de unos datos. */
export const pagina3Modelo303 = (datos: DatosModelo303): string => pagina3Borrador303(montarBorrador303(datos, contexto303()));

/** Pagina 1 del 303 de unos datos; 400 si hay ventas a un tipo sin fila en el regimen general. */
export function pagina1Modelo303(nif: string, periodo: PeriodoFiscal, datos: DatosModelo303, razonSocial = ''): string {
  const { sinFila } = filasRegimenGeneral303(datos.ivaDevengado);
  if (sinFila.length) {
    throw badRequest(`No se puede generar el fichero del 303: hay ventas al ${sinFila.map((d) => `${d.tipo} %`).join(', ')}, que no tiene fila en el régimen general. Revisa esas facturas.`);
  }
  return pagina1Borrador303(montarBorrador303({ ...datos, periodo }, contexto303(nif, razonSocial)));
}

/** Fichero del 111 con la declaracion de la pantalla. */
export function fichero111(nif: string, periodo: PeriodoFiscal, datos: DatosModelo111, opts: { denominacion?: string; opciones?: OpcionesDeclaracion } = {}): string {
  return ficheroDeclaracion(
    construirDeclaracion('111', { nif, denominacion: opts.denominacion ?? '', ejercicio: periodo.ejercicio, periodo: periodo.periodo, casillas: casillasDeDatos111(datos), opciones: opts.opciones }),
  );
}

/** Fichero del 115 con la declaracion de la pantalla. */
export function fichero115(nif: string, periodo: PeriodoFiscal, datos: DatosModelo115, opts: { razonSocial?: string; opciones?: OpcionesDeclaracion } = {}): string {
  return ficheroDeclaracion(
    construirDeclaracion('115', { nif, denominacion: opts.razonSocial ?? '', ejercicio: periodo.ejercicio, periodo: periodo.periodo, casillas: casillasDeDatos115(datos), opciones: opts.opciones }),
  );
}
