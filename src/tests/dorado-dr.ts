/**
 * Ayudas de los tests dorados de ficheros AEAT: comprueban un fichero generado
 * contra la tabla de campos del diseno de registro OFICIAL (src/domain/aeat).
 * No es un test: lo importan los *.dorado*.test.ts.
 */
import { expect } from '@jest/globals';
import { erroresRegistroDr, leerRegistroDr, registroDe, type DisenoDr, type RegistroDr } from '../aeat/common/disenoRegistro';

export type CamposLeidos = Record<string, string | number>;

/** Valores de un registro por id de campo (importes en euros; el resto, texto sin relleno). */
export function camposDe(registro: RegistroDr, linea: string): CamposLeidos {
  return Object.fromEntries(leerRegistroDr(registro, linea).map((c) => [c.id, c.valor]));
}

/** Texto exacto de las posiciones desde-hasta (1-based, ambas incluidas). */
export const posiciones = (linea: string, desde: number, hasta: number) => linea.slice(desde - 1, hasta);

/**
 * Lineas de un fichero de registros de 500 (349, 180): separadas por CRLF, con
 * CRLF final y sin lineas vacias. Cada una cumple el diseno del registro que
 * le toca (`queRegistro` decide cual por su contenido).
 */
export function comprobarFicheroPorLineas(diseno: DisenoDr, fichero: string, queRegistro: (linea: string, i: number) => string): Array<{ registro: string; linea: string; campos: CamposLeidos }> {
  expect(fichero.endsWith('\r\n')).toBe(true);
  expect(fichero.slice(0, -2).includes('\n')).toBe(fichero.slice(0, -2).includes('\r\n'));
  const lineas = fichero.slice(0, -2).split('\r\n');
  return lineas.map((linea, i) => {
    const id = queRegistro(linea, i);
    const registro = registroDe(diseno, id);
    expect({ i, id, longitud: linea.length }).toEqual({ i, id, longitud: registro.longitud });
    expect({ i, id, errores: erroresRegistroDr(registro, linea) }).toEqual({ i, id, errores: [] });
    // Solo caracteres de ISO-8859-1 (el fichero se envia en latin1).
    expect(/^[\x20-\x7eÇÑ]*$/.test(linea)).toBe(true);
    return { registro: id, linea, campos: camposDe(registro, linea) };
  });
}

/**
 * Fichero de longitud fija sin saltos entre paginas (202): trozos consecutivos
 * con la longitud de cada registro, en el orden dado, y CRLF final.
 */
export function comprobarFicheroPorTrozos(diseno: DisenoDr, fichero: string, orden: string[]): Record<string, { linea: string; campos: CamposLeidos }> {
  expect(fichero.endsWith('\r\n')).toBe(true);
  const cuerpo = fichero.slice(0, -2);
  const total = orden.reduce((a, id) => a + registroDe(diseno, id).longitud, 0);
  expect(cuerpo.length).toBe(total);
  expect(/^[\x20-\x7eÇÑ]*$/.test(cuerpo)).toBe(true);
  const out: Record<string, { linea: string; campos: CamposLeidos }> = {};
  let pos = 0;
  for (const id of orden) {
    const registro = registroDe(diseno, id);
    const linea = cuerpo.slice(pos, pos + registro.longitud);
    pos += registro.longitud;
    expect({ id, errores: erroresRegistroDr(registro, linea) }).toEqual({ id, errores: [] });
    out[id] = { linea, campos: camposDe(registro, linea) };
  }
  return out;
}
