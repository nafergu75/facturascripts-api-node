/**
 * Huecos sencillos que se sacan con expresiones regulares del texto normalizado:
 * modelo de Hacienda, número de factura, importe mínimo, NIF y sentido
 * (cobros o pagos).
 */

/** Modelos que Carmen reconoce. */
export const MODELOS = ['303', '111', '115', '130', '180', '190', '200', '202', '347', '349', '390'] as const;
export type CodigoModelo = (typeof MODELOS)[number];

const RE_MODELO = new RegExp(`(?<![\\d/.-])(${MODELOS.join('|')})(?![\\d/.-])`);

/** «el 303», «modelo 111». No cuenta si va detrás de «factura» o «número» (sería un número de factura). */
export function extraerModelo(texto: string): CodigoModelo | null {
  const m = texto.match(RE_MODELO);
  if (!m || m.index === undefined) return null;
  const antes = texto.slice(0, m.index).trim().split(' ').pop() ?? '';
  if (['factura', 'facturas', 'numero', 'n', 'no'].includes(antes)) return null;
  return m[1] as CodigoModelo;
}

/**
 * Número de factura: «factura 2026-0045», «la A-12», «fra 45». Se devuelve tal
 * cual (la búsqueda compara sin ceros a la izquierda).
 */
export function extraerNumeroFactura(texto: string): string | null {
  const tras = texto.match(/\b(?:factura|numero|n)\s+(?:numero\s+|n\s+)?([a-z]{0,4}-?\d[\d/-]*[a-z]?)\b/);
  if (tras && !/^(20\d{2})$/.test(tras[1]) && !(MODELOS as readonly string[]).includes(tras[1])) return tras[1].toUpperCase();
  // Sin «factura» delante: letras y cifras con guion (A-12) o año-guion-número (2026-0045).
  const suelto = texto.match(/(?<![\w/-])([a-z]{1,4}-\d{1,8}|20\d{2}-\d{1,8}|[a-z]{1,4}\d{2,8})(?![\w/-])/);
  if (suelto && !RE_NIF.test(suelto[1])) return suelto[1].toUpperCase();
  return null;
}

/** «más de 1000 euros», «de más de 500», «superiores a 2000». */
export function extraerImporteMinimo(texto: string): number | null {
  const m = texto.match(/\b(?:mas de|superiores? a|mayores? (?:de|a)|por encima de|>)\s*(\d+(?:\.\d+)?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** NIF, CIF o NIE con su letra o dígito de control (ya en mayúsculas o minúsculas). */
export const RE_NIF = /\b(\d{8}[A-HJ-NP-TV-Z]|[XYZ]\d{7}[A-HJ-NP-TV-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])\b/i;

export function extraerNif(texto: string): string | null {
  const m = texto.match(RE_NIF);
  return m ? m[1].toUpperCase() : null;
}

/** Cobros (dinero que entra) o pagos (dinero que sale), según los verbos. */
export function extraerSentido(texto: string): 'cobros' | 'pagos' | null {
  const cobros = /\b(cobr\w*|ingres\w*|ha entrado|han entrado|entrad[oa]s?|me han pagado|me ha pagado|recibid[oa]s?)\b/.test(texto);
  const pagos = /\b(he pagado|hemos pagado|pagad[oa]s?|pagos?|pagar|ha salido|han salido|salid[oa]s?|cargos?)\b/.test(texto);
  if (cobros && !pagos) return 'cobros';
  if (pagos && !cobros) return 'pagos';
  return null;
}
