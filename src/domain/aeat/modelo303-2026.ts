/**
 * Modelo 303 con el diseño de registro OFICIAL de la AEAT para las
 * presentaciones a partir del ejercicio 2026 (versión 1.01, DR303e26v101.xlsx).
 *
 * Las posiciones, longitudes, tipos y constantes NO se escriben a mano: salen
 * de la tabla `dr303-2026.json`, transcrita hoja a hoja del Excel de la AEAT
 * (scripts/aeat/dr303-a-json.js). Aquí solo está el motor que compone cada
 * página a partir de esa tabla, con las reglas generales del diseño:
 *  - An: letras, números y blancos, alineado a la izquierda y relleno con blancos.
 *  - A: letras y blancos.
 *  - Num: solo números, alineado a la derecha y relleno con ceros (sin signo).
 *  - N: como Num, y si es negativo lleva una N en la primera posición.
 *  - Importes con 2 decimales implícitos (céntimos).
 *
 * El fichero es una cadena continua: cabecera <T3030EEEEPP0000><AUX>...</AUX>,
 * las páginas y el cierre </T3030EEEEPP0000>, sin saltos de línea.
 */
import disenoJson from './dr303-2026.json';
import { badRequest } from '../../utils/http-errors';

export type TipoCampoAeat = 'A' | 'An' | 'Num' | 'N';
export type PaginaDr303 = 'cabecera' | '01' | '02' | '03' | '04' | '05' | 'DID';

export interface CampoDr303 {
  /** Nº de campo en la hoja. */
  n: number;
  /** Posición inicial (1 = primera); null en el cierre del fichero (va al final). */
  pos: number | null;
  /** Longitud; null si es variable (el contenido del fichero). */
  lon: number | null;
  tipo: TipoCampoAeat;
  comp?: string;
  descripcion: string;
  validacion: string;
  contenido: string;
  /** Casilla del formulario ([01], [27]...), si el campo es una casilla. */
  casilla?: string;
  /** Literal que el diseño fija para el campo. */
  constante?: string;
  reservado?: boolean;
}

export interface PaginaDiseno303 {
  hoja: string;
  longitud: number | null;
  campos: CampoDr303[];
  notas: string[];
}

export const DR303_2026 = disenoJson as unknown as {
  modelo: string;
  version: string;
  paginas: Record<PaginaDr303, PaginaDiseno303>;
};

export function paginaDiseno303(pagina: PaginaDr303): PaginaDiseno303 {
  return DR303_2026.paginas[pagina];
}

/** Campo de una casilla ([01], [71]...) en una página. */
export function campoDeCasilla303(pagina: PaginaDr303, casilla: string): CampoDr303 {
  const campo = paginaDiseno303(pagina).campos.find((c) => c.casilla === casilla);
  if (!campo) throw new Error(`La casilla [${casilla}] no está en la página ${pagina} del diseño del 303.`);
  return campo;
}

/** Casillas de una página, en el orden del diseño. */
export function casillasDePagina303(pagina: PaginaDr303): string[] {
  return paginaDiseno303(pagina)
    .campos.filter((c) => c.casilla)
    .map((c) => c.casilla as string);
}

// ---------------------------------------------------------------------------
// Texto para campos An (letras, números y blancos)
// ---------------------------------------------------------------------------

/**
 * Texto apto para un campo An: mayúsculas, sin tildes (la Ñ y la Ç se
 * conservan: el fichero va en ISO-8859-1), sin signos (los puntos se quitan y
 * el resto pasa a blanco) y sin blancos repetidos. "Ejemplo, S.L." -> "EJEMPLO SL".
 */
export function textoAn303(valor: string): string {
  return (valor ?? '')
    .toUpperCase()
    .replace(/Ñ/g, '\u0001')
    .replace(/Ç/g, '\u0002')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ')
    .replace(/\u0002/g, 'Ç')
    .replace(/\./g, '')
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NIF para el fichero: mayúsculas, sin blancos ni signos. */
export function nifAn303(nif: string): string {
  return (nif ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------------
// Formato de un campo
// ---------------------------------------------------------------------------

/** Valor de un campo: número (importe en euros; en Num/N va en céntimos), texto, o null = en blanco. */
export type ValorCampo303 = number | string | null;

const etiqueta = (pagina: PaginaDr303, c: CampoDr303) => (c.casilla ? `la casilla [${c.casilla}]` : `el campo ${c.n} de la página ${pagina}`);

function formatearCampo(pagina: PaginaDr303, c: CampoDr303, valor: ValorCampo303): string {
  const lon = c.lon as number;
  if (valor === null) return ' '.repeat(lon);
  if (typeof valor === 'number') {
    if (c.tipo !== 'Num' && c.tipo !== 'N') throw new Error(`${etiqueta(pagina, c)} es de texto y se le ha pasado un número.`);
    const centimos = Math.round(valor * 100);
    if (centimos < 0 && c.tipo === 'Num') {
      throw badRequest(
        `El 303 no admite un importe negativo en ${etiqueta(pagina, c)} (${valor.toFixed(2)} €): revisa las facturas del periodo.`,
      );
    }
    const digitos = String(Math.abs(centimos));
    const espacio = centimos < 0 ? lon - 1 : lon;
    if (digitos.length > espacio) throw badRequest(`El importe de ${etiqueta(pagina, c)} (${valor.toFixed(2)} €) no cabe en el fichero del 303.`);
    return (centimos < 0 ? 'N' : '') + digitos.padStart(espacio, '0');
  }
  if (valor.length > lon) throw new Error(`"${valor}" no cabe en ${etiqueta(pagina, c)} (${lon} posiciones).`);
  return c.tipo === 'Num' || c.tipo === 'N' ? valor.padStart(lon, '0') : valor.padEnd(lon, ' ');
}

/** Contenido por defecto: blancos en texto y reservados, ceros en los numéricos. */
function porDefecto(c: CampoDr303): string {
  const lon = c.lon as number;
  if (c.reservado || c.tipo === 'A' || c.tipo === 'An') return ' '.repeat(lon);
  return '0'.repeat(lon);
}

export interface ValoresPagina303 {
  /** Importes por casilla (euros): '01' -> 1000. */
  casillas?: Record<string, number>;
  /** Valores por Nº de campo del diseño (identificación, indicadores, IBAN...). */
  campos?: Record<number, ValorCampo303>;
}

/**
 * Compone una página del 303 siguiendo el diseño: cada campo, en su posición y
 * con su longitud, toma (por este orden) el valor explícito de `campos`, la
 * constante del diseño, el importe de su casilla o el contenido por defecto.
 */
export function componerPagina303(pagina: Exclude<PaginaDr303, 'cabecera'>, valores: ValoresPagina303 = {}): string {
  const diseno = paginaDiseno303(pagina);
  const casillas = valores.casillas ?? {};
  const campos = valores.campos ?? {};
  let out = '';
  for (const c of diseno.campos) {
    let texto: string;
    if (campos[c.n] !== undefined) texto = formatearCampo(pagina, c, campos[c.n]);
    else if (c.constante !== undefined) texto = c.constante;
    else if (c.casilla && casillas[c.casilla] !== undefined) texto = formatearCampo(pagina, c, casillas[c.casilla]);
    else texto = porDefecto(c);
    if (texto.length !== c.lon) throw new Error(`El campo ${c.n} de la página ${pagina} sale con ${texto.length} posiciones y el diseño pide ${c.lon}.`);
    out += texto;
  }
  if (out.length !== diseno.longitud) throw new Error(`La página ${pagina} del 303 sale con ${out.length} posiciones y el diseño pide ${diseno.longitud}.`);
  return out;
}

/** Datos del programa que van en la cabecera (Nota 1 de DP30300). */
export interface SoftwareAeat {
  /** Versión del programa (4 posiciones An). */
  versionPrograma: string;
  /** NIF de la entidad desarrolladora (9 posiciones An); en blanco si no se conoce. */
  nifEmpresaDesarrollo: string;
}

/** Cabecera del fichero (DP30300, 328 posiciones): <T3030EEEEPP0000><AUX>...</AUX>. */
export function componerCabecera303(ejercicio: number, periodo: string, software: SoftwareAeat): string {
  const diseno = paginaDiseno303('cabecera');
  const valores: Record<number, string> = {
    4: String(ejercicio).padStart(4, '0'),
    5: periodo,
    9: textoAn303(software.versionPrograma).replace(/ /g, '').slice(0, 4),
    11: nifAn303(software.nifEmpresaDesarrollo).slice(0, 9),
  };
  let out = '';
  for (const c of diseno.campos) {
    if (c.pos === null || c.lon === null) continue; // contenido y cierre: fuera de la cabecera
    const v = valores[c.n];
    out += v !== undefined ? v.padEnd(c.lon, ' ') : c.constante ?? ' '.repeat(c.lon);
  }
  return out;
}

/** Cierre del fichero (18 posiciones): </T + 303 + 0 + ejercicio + periodo + 0000>. */
export function cierre303(ejercicio: number, periodo: string): string {
  return `</T3030${String(ejercicio).padStart(4, '0')}${periodo}0000>`;
}
