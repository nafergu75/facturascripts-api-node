/**
 * Perfil fiscal y de documento de una empresa a partir de su pais (puro).
 *
 *  - Empresa espanola (pais ES): facturas con IVA, en espanol, fechas
 *    DD/MM/AAAA e importes 1.234,56.
 *  - Empresa de otro pais (tambien de la UE): sin IVA ni IRPF en la app,
 *    facturas en ingles. EE. UU.: MM/DD/YYYY; resto (Hong Kong...): DD/MM/YYYY;
 *    importes 1,234.56. Si una extranjera tiene establecimiento permanente en
 *    Espana, se configura con pais ES.
 *
 * La unica fuente para saber si la empresa es espanola es esta (y el servicio
 * perfilEmpresa.service.ts, que la lee de LegalConfig).
 */

export type Idioma = 'es' | 'en';

export interface FormatoDocumento {
  idioma: Idioma;
  /** Orden de la fecha en el documento. */
  fecha: 'DMA' | 'MDA';
  separadorMiles: '.' | ',';
  separadorDecimal: ',' | '.';
}

/** Pais vacio o sin informar = Espana (las empresas anteriores no tenian pais). */
export function esPaisEspana(pais: string | null | undefined): boolean {
  const p = String(pais ?? '').trim().toUpperCase();
  return p === '' || p === 'ES' || p === 'ESP';
}

/** Regimen de impuestos de las facturas: IVA espanol o ninguno. */
export function regimenIvaPorPais(pais: string | null | undefined): 'ES' | 'NINGUNO' {
  return esPaisEspana(pais) ? 'ES' : 'NINGUNO';
}

/** Idioma de las facturas: espanol en Espana; ingles en el resto. */
export function idiomaPorPais(pais: string | null | undefined): Idioma {
  return esPaisEspana(pais) ? 'es' : 'en';
}

export function formatoPorPais(pais: string | null | undefined): FormatoDocumento {
  if (esPaisEspana(pais)) return { idioma: 'es', fecha: 'DMA', separadorMiles: '.', separadorDecimal: ',' };
  const p = String(pais).trim().toUpperCase();
  return { idioma: 'en', fecha: p === 'US' || p === 'USA' ? 'MDA' : 'DMA', separadorMiles: ',', separadorDecimal: '.' };
}

/** 1234.5 -> '1.234,50' (ES) o '1,234.50' (EN). Sin Intl: el PDF usa una fuente en subconjunto. */
export function formatearNumero(n: number, formato: FormatoDocumento, decimales = 2): string {
  const signo = n < 0 ? '-' : '';
  const [entero, dec] = Math.abs(n).toFixed(decimales).split('.');
  const miles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, formato.separadorMiles);
  return `${signo}${miles}${dec !== undefined ? formato.separadorDecimal + dec : ''}`;
}

/**
 * Importe con su moneda. En espanol, detras: '1.234,56 €' (EUR) o '1.234,56 USD'.
 * En ingles, el codigo delante: 'USD 1,234.56'. Siempre ASCII salvo el euro, y
 * sin ambiguedad entre dolares.
 */
export function formatearImporte(n: number, moneda: string, formato: FormatoDocumento): string {
  const num = formatearNumero(n, formato);
  if (formato.idioma === 'es') return `${num} ${moneda === 'EUR' ? '€' : moneda}`;
  return `${moneda} ${num}`;
}

/** 'AAAA-MM-DD' -> 'DD/MM/AAAA' o 'MM/DD/AAAA' segun el formato. */
export function formatearFecha(fechaIso: string | null | undefined, formato: FormatoDocumento): string {
  const f = String(fechaIso ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(f);
  if (!m) return f;
  const [, a, mes, d] = m;
  return formato.fecha === 'MDA' ? `${mes}/${d}/${a}` : `${d}/${mes}/${a}`;
}
