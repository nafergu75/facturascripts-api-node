/**
 * Ficheros de la AEAT a partir de la tabla de campos del diseño de registro
 * OFICIAL (src/domain/aeat/*.json). La misma tabla sirve para escribir cada
 * registro, para leerlo de vuelta (lo que se enseña en pantalla sale del propio
 * fichero) y para comprobarlo (los tests dorados y una última comprobación
 * antes de entregar el fichero).
 *
 * Tipos de campo, según los diseños de la AEAT:
 *  - Num: solo cifras, a la derecha y con ceros a la izquierda. Con
 *    `decimales`, el importe va sin coma (2 decimales implícitos). Sin signo:
 *    un negativo es un error (el signo, si lo hay, va en otro campo).
 *  - N: numérico con signo (202): un negativo lleva una 'N' en la 1.ª posición.
 *  - A: alfabético, An: alfanumérico. A la izquierda y con blancos a la
 *    derecha, en mayúsculas, sin vocales acentuadas ni caracteres especiales
 *    (la Ñ y la Ç se mantienen: el fichero va en ISO-8859-1).
 *  - Blanco: reservado, siempre en blanco.
 *  - `constante`: el valor fijo que exige el diseño.
 *  - `literal`: An que admite además '.', '/' y '-' (p. ej. "S/N" o "KM." en
 *    el tipo de numeración del 180).
 */

import { ADMITE_LITERAL, ErrorImporteAeat, importeAeat, textoAeat } from './normalizacion';

export type TipoCampoDr = 'Num' | 'N' | 'An' | 'A' | 'Blanco';

export interface CampoDr {
  pos: number;
  lon: number;
  tipo: TipoCampoDr;
  id: string;
  descripcion: string;
  constante?: string;
  decimales?: number;
  /** Numero de casilla del formulario ([01], [17]...), si lo tiene. */
  casilla?: string;
  literal?: boolean;
}

export interface RegistroDr {
  id: string;
  nombre: string;
  longitud: number;
  campos: CampoDr[];
}

export interface DisenoDr {
  modelo: string;
  nombre: string;
  norma: string;
  fichero: string;
  ejercicios: string;
  comprobadoEnSede: string;
  url: string;
  codificacion: string;
  separador: string;
  registros: RegistroDr[];
}

export type ValorDr = string | number | null | undefined;

/** Error de programacion o de datos al componer un registro (no deberia llegar al usuario). */
export class ErrorDisenoRegistro extends Error {}

export function registroDe(diseno: DisenoDr, id: string): RegistroDr {
  const r = diseno.registros.find((x) => x.id === id);
  if (!r) throw new ErrorDisenoRegistro(`El diseño del ${diseno.modelo} no tiene el registro "${id}".`);
  return r;
}

const enCampo = (c: CampoDr) => `${c.id} (posiciones ${c.pos}-${c.pos + c.lon - 1})`;

/** Valor de un campo con la longitud exacta del diseno. */
export function formatearCampoDr(c: CampoDr, valor: ValorDr): string {
  if (c.constante !== undefined) {
    if (c.constante.length !== c.lon) throw new ErrorDisenoRegistro(`La constante de ${enCampo(c)} no tiene ${c.lon} caracteres.`);
    return c.constante;
  }
  switch (c.tipo) {
    case 'Blanco':
      return ' '.repeat(c.lon);
    case 'Num':
    case 'N': {
      if (valor === null || valor === undefined || valor === '') return '0'.repeat(c.lon);
      if (typeof valor === 'number' || c.decimales) {
        try {
          return importeAeat(valor, c.lon, { signo: c.tipo === 'N', decimales: c.decimales ?? 0, etiqueta: enCampo(c) });
        } catch (e) {
          throw e instanceof ErrorImporteAeat ? new ErrorDisenoRegistro(e.message) : e;
        }
      }
      const cifras = String(valor).trim();
      if (!/^\d+$/.test(cifras)) throw new ErrorDisenoRegistro(`${enCampo(c)}: "${valor}" no son solo cifras.`);
      if (cifras.length > c.lon) throw new ErrorDisenoRegistro(`${enCampo(c)}: ${valor} no cabe en ${c.lon} posiciones.`);
      return cifras.padStart(c.lon, '0');
    }
    case 'A':
    case 'An': {
      const t = textoAeat(valor, { admite: c.literal ? ADMITE_LITERAL : '' });
      if (c.tipo === 'A' && /[^A-ZÑÇ ]/.test(t)) throw new ErrorDisenoRegistro(`${enCampo(c)} es alfabético y lleva "${t}".`);
      // Los codigos cortos (clave, pais, marcas) no se recortan: un valor que no cabe es un error.
      if (t.length > c.lon && c.lon <= 2) throw new ErrorDisenoRegistro(`${enCampo(c)}: "${t}" no cabe en ${c.lon} posiciones.`);
      return t.slice(0, c.lon).padEnd(c.lon, ' ');
    }
  }
}

/**
 * Registro de ancho fijo con los valores indicados por id de campo. Los que no
 * se indican van a ceros (numericos) o a blancos. Un id que no existe en el
 * diseno es un error (asi una errata no deja un campo vacio sin avisar).
 */
export function componerRegistroDr(registro: RegistroDr, valores: Record<string, ValorDr>): string {
  const ids = new Set(registro.campos.map((c) => c.id));
  const sobran = Object.keys(valores).filter((k) => !ids.has(k));
  if (sobran.length) throw new ErrorDisenoRegistro(`El registro ${registro.id} no tiene los campos: ${sobran.join(', ')}.`);
  const linea = registro.campos.map((c) => formatearCampoDr(c, valores[c.id])).join('');
  if (linea.length !== registro.longitud) {
    throw new ErrorDisenoRegistro(`El registro ${registro.id} mide ${linea.length} y el diseño dice ${registro.longitud}.`);
  }
  const errores = erroresRegistroDr(registro, linea);
  if (errores.length) throw new ErrorDisenoRegistro(`El registro ${registro.id} no cumple el diseño: ${errores.join(' ')}`);
  return linea;
}

export interface CampoLeidoDr {
  id: string;
  pos: number;
  lon: number;
  tipo: TipoCampoDr;
  descripcion: string;
  casilla?: string;
  /** Tal como esta en el fichero. */
  crudo: string;
  /** Importe en euros (Num/N con decimales) o el texto sin blancos de relleno. */
  valor: string | number;
}

/** Lee un registro con su diseno: lo que se ve en pantalla es lo que lleva el fichero. */
export function leerRegistroDr(registro: RegistroDr, linea: string): CampoLeidoDr[] {
  return registro.campos
    .filter((c) => c.tipo !== 'Blanco')
    .map((c) => {
      const crudo = linea.slice(c.pos - 1, c.pos - 1 + c.lon);
      let valor: string | number = crudo.trim();
      if ((c.tipo === 'Num' || c.tipo === 'N') && c.decimales) {
        const negativo = crudo.startsWith('N');
        valor = (negativo ? -1 : 1) * (Number(crudo.replace(/^N/, '')) / 10 ** c.decimales);
      }
      return { id: c.id, pos: c.pos, lon: c.lon, tipo: c.tipo, descripcion: c.descripcion, ...(c.casilla ? { casilla: c.casilla } : {}), crudo, valor };
    });
}

/** Lo que incumple el diseno en un registro ya escrito (vacio si cumple). */
export function erroresRegistroDr(registro: RegistroDr, linea: string): string[] {
  const errores: string[] = [];
  if (linea.length !== registro.longitud) errores.push(`Mide ${linea.length} y el diseño dice ${registro.longitud}.`);
  for (const c of registro.campos) {
    const v = linea.slice(c.pos - 1, c.pos - 1 + c.lon);
    let ok = true;
    if (c.constante !== undefined) ok = v === c.constante;
    else if (c.tipo === 'Blanco') ok = /^ *$/.test(v);
    else if (c.tipo === 'Num') ok = /^\d+$/.test(v);
    else if (c.tipo === 'N') ok = /^(N\d+|\d+)$/.test(v);
    else if (c.tipo === 'A') ok = /^[A-ZÑÇ ]*$/.test(v) && !/^ +[^ ]/.test(v);
    else ok = (c.literal ? /^[A-Z0-9ÑÇ ./-]*$/ : /^[A-Z0-9ÑÇ ]*$/).test(v) && !/^ +[^ ]/.test(v);
    if (!ok) errores.push(`${enCampo(c)}: "${v}" no es ${c.constante !== undefined ? `la constante "${c.constante}"` : `un campo ${c.tipo} válido`}.`);
  }
  return errores;
}

/** Comprueba la tabla: los campos cubren el registro entero, sin huecos ni solapes. */
export function erroresTablaDr(registro: RegistroDr): string[] {
  const errores: string[] = [];
  let pos = 1;
  for (const c of registro.campos) {
    if (c.pos !== pos) errores.push(`${registro.id}: ${c.id} empieza en ${c.pos} y debería empezar en ${pos}.`);
    if (c.constante !== undefined && c.constante.length !== c.lon) errores.push(`${registro.id}: la constante de ${c.id} no mide ${c.lon}.`);
    pos = c.pos + c.lon;
  }
  if (pos - 1 !== registro.longitud) errores.push(`${registro.id}: los campos suman ${pos - 1} y el registro mide ${registro.longitud}.`);
  return errores;
}
