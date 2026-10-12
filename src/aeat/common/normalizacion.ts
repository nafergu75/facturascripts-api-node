/**
 * Normalización de los datos que van a los ficheros de la AEAT: una sola
 * función para cada cosa, la misma en todos los modelos (303, 111, 115, 190,
 * 347, 349, 180, 202, 390 y 200).
 *
 *  - textoAeat: campos A y An. Mayúsculas, sin vocales acentuadas ni
 *    diéresis, conservando la Ñ y la Ç (el fichero va en ISO-8859-1 y la AEAT
 *    las admite). Los puntos y los apóstrofos se quitan ("S.L." -> "SL"), el
 *    resto de signos pasan a blanco y los blancos seguidos se juntan. Cada
 *    diseño puede admitir algún carácter más (el 180 admite ". / -" en la
 *    numeración de la vía; el 200, el correo electrónico).
 *  - nifAeat / errorNifDeclarante / motivoNifNoValido: limpieza y carácter de
 *    control de DNI, NIE y CIF (utils/nif.ts, el validador de toda la app).
 *  - nifDerecha: NIF de 9 posiciones a la derecha con ceros (informativas).
 *  - separarNifIva: país (código del NIF-IVA, EL para Grecia) y número de un
 *    operador de otro Estado de la UE (349).
 *  - ibanAeat: IBAN sin blancos, comprobado con el mod-97.
 *  - importeAeat: importe en céntimos con la longitud del campo; con signo
 *    (campos N), una 'N' en la primera posición si es negativo.
 *  - telefonoAeat: 9 cifras sin el prefijo 34.
 */
import { normalizarNif, validarNifEspanol } from '../../utils/nif';
import { validateIban } from '../../utils/validateIban';
import { normalizarPais, PAISES_UE, prefijoNifIvaUe } from '../../domain/tipo-operacion.model';

/** Caracteres de más que admite el campo, además de letras, cifras y blancos. */
export interface OpcionesTextoAeat {
  admite?: string;
}

/** ". / -": numeración de la vía y calificador del 180 ("S/N", "KM."). */
export const ADMITE_LITERAL = './-';
/** Correo electrónico (página 1 del 200, registro de tipo 1 del 190). */
export const ADMITE_CORREO = '@._-';

const escapar = (s: string) => s.replace(/[\\\]^-]/g, '\\$&');

/**
 * Texto para un campo A o An de cualquier diseño. "Muñoz & Cía., S.L." ->
 * "MUÑOZ CIA SL"; "Façana d'Or" -> "FAÇANA DOR".
 */
export function textoAeat(valor: unknown, opciones: OpcionesTextoAeat = {}): string {
  const admite = opciones.admite ?? '';
  const quitar = new RegExp(`[${escapar(".'´`".split('').filter((c) => !admite.includes(c)).join(''))}]`, 'g');
  const fuera = new RegExp(`[^A-Z0-9ÑÇ ${escapar(admite)}]`, 'g');
  return String(valor ?? '')
    .toUpperCase()
    .replace(/Ñ/g, '\u0001')
    .replace(/Ç/g, '\u0002')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ')
    .replace(/\u0002/g, 'Ç')
    .replace(quitar, '')
    .replace(fuera, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NIF español limpio: mayúsculas, sin signos ni el prefijo ES, con los ceros que Excel quita. */
export function nifAeat(valor: unknown): string {
  return normalizarNif(valor);
}

/** Persona física: NIF que empieza por cifra (DNI) o por K, L, M, X, Y o Z. */
export function esPersonaFisica(nif: unknown): boolean {
  return /^[0-9KLMXYZ]/.test(normalizarNif(nif));
}

/**
 * Por qué un NIF no vale para un fichero de la AEAT (letra o dígito de
 * control incluidos), o null si vale. Con `persona`, un CIF de sociedad
 * tampoco vale (trabajadores, cónyuges).
 */
export function motivoNifNoValido(valor: unknown, opts: { persona?: boolean } = {}): string | null {
  const nif = normalizarNif(valor);
  if (!nif) return 'falta';
  const r = validarNifEspanol(nif);
  if (r.valido) return opts.persona && r.tipo === 'CIF' ? 'es el NIF de una sociedad, no el de una persona' : null;
  if (r.tipo === 'CIF') return 'el dígito de control no corresponde a sus cifras';
  if (r.tipo) return 'la letra no corresponde a sus cifras';
  return 'no tiene la forma de un NIF español (8 cifras y una letra; X, Y o Z, 7 cifras y una letra; o una letra, 7 cifras y el control)';
}

/** NIF válido (con su control) o false. */
export const nifAeatValido = (valor: unknown): boolean => motivoNifNoValido(valor) === null;

/**
 * Errores por la persona de contacto y el teléfono que faltan (B3), con dónde
 * se rellenan; vacío si están. La única comprobación: la usan los borradores
 * y los generadores de los ficheros que los llevan (347, 349, 180, 190, 200).
 */
export function erroresContactoAeat(d: { personaContacto?: string | null; telefono?: string | null }): string[] {
  const errores: string[] = [];
  if (!textoAeat(d.personaContacto)) {
    errores.push('Falta la persona de contacto con Hacienda (apellidos y nombre). Rellénala en Datos de la empresa, apartado Contacto.');
  }
  if (!telefonoAeat(d.telefono)) {
    errores.push('Falta el teléfono de contacto con Hacienda (9 cifras). Rellénalo en Datos de la empresa, apartado Contacto.');
  }
  return errores;
}

/** Error del NIF de la empresa que declara, con el NIF y dónde se corrige; null si vale. */
export function errorNifDeclarante(valor: unknown): string | null {
  const nif = normalizarNif(valor);
  if (!nif) return 'Falta el NIF de la empresa. Rellénalo en Registro Mercantil > Datos para la memoria y vuelve a descargar el fichero.';
  const motivo = motivoNifNoValido(nif);
  return motivo ? `El NIF de la empresa (${nif}) no es válido: ${motivo}. Corrígelo en Registro Mercantil > Datos para la memoria.` : null;
}

/** NIF de 9 posiciones a la derecha y con ceros a la izquierda (vacío si no hay). */
export function nifDerecha(valor: unknown, lon = 9): string {
  const n = normalizarNif(valor);
  return n ? n.slice(-lon).padStart(lon, '0') : '';
}

/**
 * País (código del NIF-IVA: EL para Grecia) y número de un operador de otro
 * Estado de la UE. Si el NIF lleva el prefijo de un Estado, ese; si no, el país
 * de la ficha. null si no es un operador de otro Estado de la UE.
 */
export function separarNifIva(nif: unknown, paisFicha?: string | null): { pais: string; numero: string } | null {
  const limpio = String(nif ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!limpio) return null;
  const pref = prefijoNifIvaUe(limpio);
  if (pref) {
    if (pref.prefijo === 'ES') return null;
    return { pais: pref.prefijo, numero: limpio.slice(2) };
  }
  const pais = normalizarPais(paisFicha);
  if (!pais || pais === 'ES' || !PAISES_UE.has(pais)) return null;
  return { pais: pais === 'GR' ? 'EL' : pais, numero: limpio };
}

/**
 * Composición del NIF-IVA de cada Estado (número sin el código de país), tal
 * como la da el diseño de registro del modelo 349 (Orden HAC, anexo, registro
 * de tipo 2, «Composición del NIF comunitario de los distintos Estados»):
 * longitudes admitidas y si solo lleva cifras. XI (Irlanda del Norte) sigue la
 * regla de GB.
 */
const COMPOSICION_NIF_IVA: Readonly<Record<string, { nombre: string; longitudes: number[]; numerico: boolean }>> = {
  DE: { nombre: 'Alemania', longitudes: [9], numerico: true },
  AT: { nombre: 'Austria', longitudes: [9], numerico: false },
  BE: { nombre: 'Bélgica', longitudes: [10], numerico: true },
  BG: { nombre: 'Bulgaria', longitudes: [9, 10], numerico: true },
  CY: { nombre: 'Chipre', longitudes: [9], numerico: false },
  HR: { nombre: 'Croacia', longitudes: [11], numerico: true },
  DK: { nombre: 'Dinamarca', longitudes: [8], numerico: true },
  SI: { nombre: 'Eslovenia', longitudes: [8], numerico: true },
  EE: { nombre: 'Estonia', longitudes: [9], numerico: true },
  FI: { nombre: 'Finlandia', longitudes: [8], numerico: true },
  FR: { nombre: 'Francia', longitudes: [11], numerico: false },
  EL: { nombre: 'Grecia', longitudes: [9], numerico: true },
  GB: { nombre: 'Reino Unido', longitudes: [5, 9, 12], numerico: false },
  XI: { nombre: 'Irlanda del Norte', longitudes: [5, 9, 12], numerico: false },
  NL: { nombre: 'Países Bajos', longitudes: [12], numerico: false },
  HU: { nombre: 'Hungría', longitudes: [8], numerico: true },
  IT: { nombre: 'Italia', longitudes: [11], numerico: true },
  IE: { nombre: 'Irlanda', longitudes: [8, 9], numerico: false },
  LV: { nombre: 'Letonia', longitudes: [11], numerico: true },
  LT: { nombre: 'Lituania', longitudes: [9, 12], numerico: true },
  LU: { nombre: 'Luxemburgo', longitudes: [8], numerico: true },
  MT: { nombre: 'Malta', longitudes: [8], numerico: true },
  PL: { nombre: 'Polonia', longitudes: [10], numerico: true },
  PT: { nombre: 'Portugal', longitudes: [9], numerico: true },
  CZ: { nombre: 'República Checa', longitudes: [8, 9, 10], numerico: true },
  SK: { nombre: 'República Eslovaca', longitudes: [10], numerico: true },
  RO: { nombre: 'Rumanía', longitudes: [2, 3, 4, 5, 6, 7, 8, 9, 10], numerico: true },
  SE: { nombre: 'Suecia', longitudes: [12], numerico: true },
};

/**
 * Por qué el número de un NIF-IVA no tiene la composición de su Estado (texto
 * para la persona), o null si la tiene o el Estado no está en la tabla. No
 * consulta VIES: solo la forma.
 */
export function motivoNifIvaNoValido(pais: string, numero: string): string | null {
  const regla = COMPOSICION_NIF_IVA[pais];
  if (!regla) return null;
  const n = String(numero ?? '').toUpperCase();
  const tipo = regla.numerico ? 'cifras' : 'letras o cifras';
  const longitudes =
    regla.longitudes.length > 3
      ? `de ${regla.longitudes[0]} a ${regla.longitudes[regla.longitudes.length - 1]}`
      : regla.longitudes.join(regla.longitudes.length === 2 ? ' o ' : ', ').replace(/, (\d+)$/, ' o $1');
  const forma = `${longitudes} ${tipo} detrás de ${pais}`;
  if (!(regla.numerico ? /^\d+$/ : /^[A-Z0-9]+$/).test(n) || !regla.longitudes.includes(n.length)) {
    return `en ${regla.nombre} el NIF-IVA lleva ${forma}, y ${pais}${n} tiene ${n.length} ${n.length === 1 ? 'carácter' : 'caracteres'}${regla.numerico && /\D/.test(n) ? ' con letras' : ''}`;
  }
  return null;
}

/** IBAN sin blancos y en mayúsculas si pasa el mod-97; null si falta o no vale. */
export function ibanAeat(valor: unknown): string | null {
  const iban = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!iban) return null;
  const r = validateIban(iban);
  return r.valid ? (r.normalized ?? iban) : null;
}

/** Error de un importe que no se puede escribir (lo convierte cada motor en su error). */
export class ErrorImporteAeat extends Error {
  constructor(
    message: string,
    readonly motivo: 'negativo' | 'no-cabe' | 'no-numero',
  ) {
    super(message);
  }
}

/**
 * Importe con la longitud del campo, en céntimos (o con los decimales que
 * diga el diseño) y a la derecha con ceros. Con `signo` (campos N), un
 * negativo lleva una 'N' en la primera posición; sin él (campos Num), un
 * negativo es un error. Nunca se recorta una cifra: si no cabe, error.
 */
export function importeAeat(valor: unknown, lon: number, opts: { signo?: boolean; decimales?: number; etiqueta?: string } = {}): string {
  const etiqueta = opts.etiqueta ?? 'el importe';
  const n = valor === null || valor === undefined || valor === '' ? 0 : Number(valor);
  if (!Number.isFinite(n)) throw new ErrorImporteAeat(`${etiqueta}: "${String(valor)}" no es un número.`, 'no-numero');
  const unidades = Math.round(n * 10 ** (opts.decimales ?? 2));
  const negativo = unidades < 0;
  if (negativo && !opts.signo) throw new ErrorImporteAeat(`${etiqueta} no admite importes negativos (${n.toFixed(2)}).`, 'negativo');
  const cifras = String(Math.abs(unidades));
  const hueco = negativo ? lon - 1 : lon;
  if (cifras.length > hueco) throw new ErrorImporteAeat(`${etiqueta}: ${n.toFixed(2)} no cabe en ${lon} posiciones.`, 'no-cabe');
  return (negativo ? 'N' : '') + cifras.padStart(hueco, '0');
}

/** Solo las cifras de un teléfono español, sin el prefijo +34 / 0034 (9 cifras o vacío). */
export function telefonoAeat(telefono: unknown): string {
  let t = String(telefono ?? '').replace(/\D/g, '');
  if (t.length > 9 && t.startsWith('0034')) t = t.slice(4);
  else if (t.length > 9 && t.startsWith('34')) t = t.slice(2);
  return t.length === 9 ? t : '';
}
