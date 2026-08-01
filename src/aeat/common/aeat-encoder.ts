/**
 * Nucleo reutilizable para construir lineas de ancho fijo de ficheros AEAT.
 *
 * Reglas AEAT:
 *  - N (numerico): solo digitos, alineado a la DERECHA, relleno de CEROS a la
 *    izquierda. Importes con `decimales` se multiplican por 10^decimales (sin
 *    separador). Los NEGATIVOS llevan 'N' en la 1a posicion.
 *  - A / AN (alfa / alfanumerico): alineado a la IZQUIERDA, relleno de BLANCOS a
 *    la derecha. Truncado si excede.
 */
export type CampoTipo = 'A' | 'N' | 'AN';

export interface CampoDiseno {
  nombre: string;
  posicionInicio: number; // 1-based
  longitud: number;
  tipo: CampoTipo;
  decimales?: number; // para importes tipo 'N'
}

/** Formatea un valor a string de longitud exacta segun el diseno del campo. */
export function formatearCampo(valor: string | number | null | undefined, diseno: CampoDiseno): string {
  const { longitud, tipo, decimales } = diseno;

  if (tipo === 'N') {
    const num = typeof valor === 'number' ? valor : Number(valor ?? 0);
    const n = Number.isFinite(num) ? num : 0;
    const factor = Math.pow(10, decimales ?? 0);
    const entero = Math.round(Math.abs(n) * factor);
    const digits = String(entero);
    if (n < 0) {
      // negativo: 'N' + ceros + digitos, longitud total = longitud
      return ('N' + digits.padStart(longitud - 1, '0')).slice(-longitud);
    }
    return digits.padStart(longitud, '0').slice(-longitud);
  }

  // A / AN -> texto alineado a la izquierda, blancos a la derecha, truncado
  const s = valor === null || valor === undefined ? '' : String(valor);
  return s.slice(0, longitud).padEnd(longitud, ' ');
}

/**
 * Construye una linea de ancho fijo colocando cada campo en su posicion. La
 * longitud final = max(posicionInicio + longitud - 1) de los campos.
 */
export function construirLineaDesdeCampos(
  campos: { diseno: CampoDiseno; valor: string | number | null | undefined }[],
): string {
  const total = campos.reduce((max, c) => Math.max(max, c.diseno.posicionInicio + c.diseno.longitud - 1), 0);
  const buf: string[] = new Array(total).fill(' ');
  for (const { diseno, valor } of campos) {
    const formateado = formatearCampo(valor, diseno);
    for (let i = 0; i < diseno.longitud; i++) {
      buf[diseno.posicionInicio - 1 + i] = formateado[i];
    }
  }
  return buf.join('');
}

/** Longitud total esperada de un conjunto de campos (para validar el registro). */
export function longitudRegistro(campos: CampoDiseno[]): number {
  return campos.reduce((max, c) => Math.max(max, c.posicionInicio + c.longitud - 1), 0);
}
