/**
 * Numero fiscal de un cliente o proveedor segun su pais.
 *
 * Cada pais llama a su numero fiscal de una forma: NIF en Espana, NIF-IVA (VAT)
 * en el resto de la UE, RNC en la Republica Dominicana, EIN en EE. UU... Esta
 * es la tabla del servidor (mensajes de los lectores, altas y PDF de la
 * factura). La de las pantallas es la misma, en web/lib/fiscal.ts. El numero
 * de la propia empresa no pasa por aqui: es espanol (NIF).
 *
 * Tambien estan aqui las formas de un NIF espanol y de los NIF-IVA de cada
 * Estado de la UE sin su prefijo, para saber si un numero leido "parece" de un
 * pais. Solo la forma: el NIF espanol se valida con su control en utils/nif.ts.
 */
import { esPaisUe, normalizarPais } from './tipo-operacion.model';
import { normalizarNif } from '../utils/nif';

export type IdiomaNumeroFiscal = 'es' | 'en';

/** Paises con un nombre propio para su numero fiscal (fuera de la UE). */
const NOMBRE_POR_PAIS: Readonly<Record<string, string>> = {
  DO: 'RNC',
  US: 'EIN',
  MX: 'RFC',
  AR: 'CUIT',
  CL: 'RUT',
  UY: 'RUT',
  CO: 'NIT',
  PE: 'RUC',
  EC: 'RUC',
  VE: 'RIF',
  BR: 'CNPJ',
  MA: 'ICE',
  GB: 'VAT number',
  CH: 'UID (VAT)',
};

export const NUMERO_FISCAL_ESPANA = 'NIF';
export const NUMERO_FISCAL_UE = 'NIF-IVA (VAT)';
export const NUMERO_FISCAL_GENERICO = 'Número fiscal (Tax ID)';

/**
 * Como se llama el numero fiscal de un tercero de ese pais: «NIF» (Espana o
 * sin pais), «NIF-IVA (VAT)» (resto de la UE), «RNC», «EIN»... y, si no hay
 * uno propio, «Número fiscal (Tax ID)». En ingles (PDF de las empresas de
 * fuera), «VAT No.» en la UE y «Tax ID» si no hay uno propio.
 */
export function nombreNumeroFiscal(pais: string | null | undefined, idioma: IdiomaNumeroFiscal = 'es'): string {
  const p = normalizarPais(pais);
  if (!p || p === 'ES') return NUMERO_FISCAL_ESPANA;
  if (esPaisUe(p)) return idioma === 'en' ? 'VAT No.' : NUMERO_FISCAL_UE;
  return NOMBRE_POR_PAIS[p] ?? (idioma === 'en' ? 'Tax ID' : NUMERO_FISCAL_GENERICO);
}

/** El mismo nombre, para ir dentro de una frase: «Falta el RNC del cliente», «Falta el número fiscal (Tax ID) del cliente». */
export function numeroFiscalEnFrase(pais: string | null | undefined): string {
  const n = nombreNumeroFiscal(pais);
  return n === NUMERO_FISCAL_GENERICO ? 'número fiscal (Tax ID)' : n;
}

/** Nombre del pais en castellano ('FR' -> 'Francia'); el codigo si no se conoce. */
export function nombrePaisEs(pais: string | null | undefined): string {
  const c = normalizarPais(pais);
  if (!/^[A-Z]{2}$/.test(c)) return String(pais ?? '');
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(c) ?? c;
  } catch {
    return c;
  }
}

// ---------------------------------------------------------------------------
// Formas
// ---------------------------------------------------------------------------

/** DNI (8 cifras y letra), NIE o NIF especial (X, Y, Z, K, L, M) y CIF (letra, 7 cifras y control). */
const FORMA_NIF_ESPANOL = /^(\d{8}[A-Z]|[XYZKLM]\d{7}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])$/;

/** Tiene la forma de un NIF espanol (DNI, NIE o CIF), con o sin el prefijo ES. No mira el control. */
export function pareceNifEspanol(nif: string | null | undefined): boolean {
  return FORMA_NIF_ESPANOL.test(normalizarNif(nif));
}

/**
 * Forma del numero de un NIF-IVA de cada Estado, sin el prefijo (la que
 * publica la Comision en VIES). La clave es el prefijo: EL para Grecia. Sirve
 * para reconocer un numero leido sin prefijo y para avisar si no casa; si un
 * NIF-IVA vale o no lo decide la composicion del modelo 349
 * (aeat/common/normalizacion.ts, motivoNifIvaNoValido), que esta tabla respeta.
 */
const FORMA_NIF_IVA_UE: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  FI: /^\d{8}$/,
  FR: /^[0-9A-HJ-NP-Z]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  // Sin los antiguos con «+» o «*»: el 349 solo admite letras y cifras.
  IE: /^(\d{7}[A-W][A-I]?|\d[A-Z]\d{5}[A-W])$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

/** Prefijo del NIF-IVA de un Estado de la UE distinto de Espana ('GR' -> 'EL', 'FR' -> 'FR'), o null. */
export function prefijoNifIvaDePais(pais: string | null | undefined): string | null {
  const p = normalizarPais(pais);
  if (!p || p === 'ES' || !esPaisUe(p)) return null;
  return p === 'GR' ? 'EL' : p;
}

/** El numero (sin prefijo, ya sin espacios ni puntos) tiene la forma de un NIF-IVA de ese prefijo. */
export function tieneFormaNifIvaUe(prefijo: string, numero: string): boolean {
  const forma = FORMA_NIF_IVA_UE[prefijo.toUpperCase()];
  return !!forma && forma.test(numero.toUpperCase());
}
