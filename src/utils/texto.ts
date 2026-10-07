/**
 * Utilidades de texto compartidas.
 *
 * `sinTildes` quita tildes y diéresis (á→a, ü→u) pero conserva la ñ, que en
 * castellano es otra letra («año» no es «ano»).
 */
export function sinTildes(texto: string): string {
  return texto
    .replace(/ñ/g, '\u0000')
    .replace(/Ñ/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0000/g, 'ñ')
    .replace(/\u0001/g, 'Ñ');
}

/** Minúsculas, sin tildes y con los espacios colapsados. */
export function plano(texto: string): string {
  return sinTildes(texto.toLowerCase()).replace(/\s+/g, ' ').trim();
}

/** Número de palabras (separadas por espacios) de un texto. */
export function contarPalabras(texto: string): number {
  const t = texto.trim();
  return t ? t.split(/\s+/).length : 0;
}
