/**
 * Motor de los ficheros de la AEAT a partir de las tablas OFICIALES de diseño
 * de registro (src/domain/aeat/*.json, sacadas tal cual de los xlsx/pdf de la
 * sede). Cada registro o página se construye desde su lista de campos: los
 * numéricos (Num, N) salen a ceros, los alfanuméricos (An, A) a blancos y las
 * constantes (etiquetas <T..>, modelo, página, fin de registro) con su valor.
 * Después se escriben los datos por casilla o por posición.
 *
 * Lo usan el 347, el 390 y el 200: el fichero y las casillas de la pantalla
 * salen de la misma página construida (`casillas()`).
 */
import { badRequest } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';

export type TipoCampoAeat = 'A' | 'An' | 'Num' | 'N';

export interface CampoOficial {
  n?: number;
  pos: number;
  len: number;
  tipo: TipoCampoAeat;
  desc: string;
  valid?: string;
  contenido?: string;
  casilla?: string;
  constante?: string;
  /** Solo 347: subcampo especial (nif ajustado a la derecha, signo, importe). */
  formato?: 'nif' | 'signo' | 'importe';
  /** Solo 347: tramo de blancos. */
  blancos?: boolean;
}

export interface PaginaOficial {
  hoja: string;
  longitud: number;
  campos: CampoOficial[];
}


// ---------------------------------------------------------------------------
// Normalización de textos (Nota 3.2 del 390, reglas del 347 y del 200)
// ---------------------------------------------------------------------------

/**
 * Texto para un campo alfanumérico: mayúsculas, sin vocales acentuadas y sin
 * caracteres especiales, CONSERVANDO la Ñ y la Ç (existen en ISO-8859-1 y la
 * AEAT las admite). Puntos, comas y apóstrofos se quitan ("S.L." -> "SL"); lo
 * demás que no sea letra, número o blanco pasa a blanco; los
 * blancos seguidos se juntan.
 */
export function textoAeat(valor: string | null | undefined): string {
  return String(valor ?? '')
    .toUpperCase()
    .replace(/Ñ/g, '\u0001')
    .replace(/Ç/g, '\u0002')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ')
    .replace(/\u0002/g, 'Ç')
    .replace(/[.,'´`]/g, '') // "S.L." -> "SL"
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** NIF limpio (sin espacios, puntos ni guiones; sin prefijo ES), en mayúsculas. */
export function nifLimpio(nif: string | null | undefined): string {
  let n = String(nif ?? '').toUpperCase().replace(/[\s.\-/]/g, '');
  if (n.length > 9 && n.startsWith('ES')) n = n.slice(2);
  return n;
}

/** NIF de 9 posiciones ajustado a la derecha con ceros a la izquierda (347). */
export function nifAjustado(nif: string | null | undefined): string {
  const n = nifLimpio(nif);
  return n ? n.padStart(9, '0').slice(-9) : '';
}

/** NIF español con forma válida (9 caracteres, letras y cifras). No comprueba el dígito de control. */
export function nifConForma(nif: string | null | undefined): boolean {
  return /^[0-9A-Z]{9}$/.test(nifAjustado(nif)) && /\d/.test(nifAjustado(nif));
}

// ---------------------------------------------------------------------------
// Formateo de un valor según el tipo del campo
// ---------------------------------------------------------------------------

/** Importe en céntimos con signo 'N' (campo N) o sin signo (campo Num). */
export function formatearImporte(campo: Pick<CampoOficial, 'tipo' | 'len' | 'desc' | 'casilla'>, euros: number): string {
  const c = aCentimos(Number(euros) || 0);
  const abs = String(Math.abs(c));
  if (c < 0) {
    if (campo.tipo !== 'N') {
      throw badRequest(`La casilla ${campo.casilla ? `[${campo.casilla}]` : campo.desc} no admite importes negativos (${(c / 100).toFixed(2)} €).`);
    }
    if (abs.length > campo.len - 1) throw badRequest(`El importe ${(c / 100).toFixed(2)} € no cabe en la casilla ${campo.casilla ?? campo.desc}.`);
    return 'N' + abs.padStart(campo.len - 1, '0');
  }
  if (abs.length > campo.len) throw badRequest(`El importe ${(c / 100).toFixed(2)} € no cabe en la casilla ${campo.casilla ?? campo.desc}.`);
  return abs.padStart(campo.len, '0');
}

/** Entero sin signo alineado a la derecha con ceros. */
export function formatearEntero(campo: Pick<CampoOficial, 'len' | 'desc'>, n: number): string {
  const v = Math.trunc(Number(n) || 0);
  if (v < 0) throw badRequest(`El campo "${campo.desc}" no admite negativos.`);
  const s = String(v);
  if (s.length > campo.len) throw badRequest(`El valor ${v} no cabe en el campo "${campo.desc}".`);
  return s.padStart(campo.len, '0');
}

/** Texto alineado a la izquierda y relleno con blancos (normalizado). */
export function formatearTexto(campo: Pick<CampoOficial, 'len'>, s: string, normalizar = true): string {
  const t = normalizar ? textoAeat(s) : String(s ?? '');
  return t.slice(0, campo.len).padEnd(campo.len, ' ');
}

// ---------------------------------------------------------------------------
// Construcción de una página o registro
// ---------------------------------------------------------------------------

/**
 * Página o registro de ancho fijo construido desde su diseño oficial. Los
 * campos se buscan por casilla ('65', '00552') o por posición (número).
 */
export class RegistroAeat {
  private readonly buf: string[];
  /** Importes escritos por casilla, para la pantalla (mismos números que el fichero). */
  private readonly valores = new Map<string, number | string>();

  constructor(private readonly diseno: PaginaOficial, private readonly nombre = diseno.hoja) {
    this.buf = new Array(diseno.longitud).fill(' ');
    for (const c of diseno.campos) {
      if (c.constante !== undefined && c.pos) this.poner(c, c.constante.padEnd(c.len, ' ').slice(0, c.len));
      else if (c.tipo === 'Num' || c.tipo === 'N') this.poner(c, '0'.repeat(c.len));
    }
  }

  /** Campo por casilla ('65' o '00065' valen igual) o por posición. */
  campo(clave: string | number): CampoOficial {
    const c =
      typeof clave === 'number'
        ? this.diseno.campos.find((x) => x.pos === clave)
        : this.diseno.campos.find((x) => x.casilla !== undefined && Number(x.casilla) === Number(clave));
    if (!c) throw new Error(`El diseño ${this.nombre} no tiene ${typeof clave === 'number' ? `campo en la posición ${clave}` : `la casilla [${clave}]`}.`);
    return c;
  }

  private poner(c: CampoOficial, valor: string): void {
    if (valor.length !== c.len) throw new Error(`Valor de ${valor.length} para un campo de ${c.len} (${this.nombre} pos. ${c.pos}).`);
    for (let i = 0; i < c.len; i++) this.buf[c.pos - 1 + i] = valor[i];
  }

  /** Importe (2 decimales implícitos) en un campo N o Num. */
  importe(clave: string | number, euros: number): this {
    const c = this.campo(clave);
    if (c.tipo !== 'N' && c.tipo !== 'Num') throw new Error(`${this.nombre} pos. ${c.pos} no es numérico.`);
    this.poner(c, formatearImporte(c, euros));
    if (c.casilla) this.valores.set(c.casilla, Math.round((Number(euros) || 0) * 100) / 100);
    return this;
  }

  /** Entero (contadores, marcas 0/1, códigos numéricos, fechas). */
  entero(clave: string | number, n: number): this {
    const c = this.campo(clave);
    this.poner(c, formatearEntero(c, n));
    if (c.casilla) this.valores.set(c.casilla, Math.trunc(Number(n) || 0));
    return this;
  }

  /** Texto en un campo A o An (normalizado salvo que se pida lo contrario). */
  texto(clave: string | number, s: string | null | undefined, normalizar = true): this {
    const c = this.campo(clave);
    this.poner(c, formatearTexto(c, s ?? '', normalizar));
    if (c.casilla) this.valores.set(c.casilla, String(s ?? ''));
    return this;
  }

  /** Valor ya formateado con la longitud exacta del campo. */
  crudo(clave: string | number, valor: string): this {
    this.poner(this.campo(clave), valor);
    return this;
  }

  /** Casillas escritas: { '00552': 1234.56, ... }. */
  casillas(): Record<string, number | string> {
    return Object.fromEntries(this.valores);
  }

  toString(): string {
    return this.buf.join('');
  }
}

// ---------------------------------------------------------------------------
// Validación (la usan los tests dorados y, antes de servir, los generadores)
// ---------------------------------------------------------------------------

export interface ErrorDiseno {
  pos: number;
  len: number;
  desc: string;
  valor: string;
  motivo: string;
}

/**
 * Comprueba una línea contra su diseño: longitud, constantes, numéricos solo
 * con cifras (y 'N' inicial en los N), alfanuméricos solo con letras, cifras y
 * blancos (o los caracteres que admita el diseño) y tramos reservados en blanco.
 */
export function validarRegistro(diseno: PaginaOficial, linea: string, opciones: { alfanumericoLibre?: RegExp } = {}): ErrorDiseno[] {
  const errores: ErrorDiseno[] = [];
  if (linea.length !== diseno.longitud) {
    errores.push({ pos: 1, len: linea.length, desc: diseno.hoja, valor: '', motivo: `longitud ${linea.length}, el diseño dice ${diseno.longitud}` });
    return errores;
  }
  const an = opciones.alfanumericoLibre ?? /^[A-Z0-9ÑÇ ]*$/;
  for (const c of diseno.campos) {
    if (!c.pos || !c.len) continue;
    const v = linea.slice(c.pos - 1, c.pos - 1 + c.len);
    const mal = (motivo: string) => errores.push({ pos: c.pos, len: c.len, desc: c.desc, valor: v, motivo });
    if (c.constante !== undefined) {
      if (v !== c.constante.padEnd(c.len, ' ').slice(0, c.len)) mal(`constante "${c.constante}"`);
      continue;
    }
    const reservado =
      /reservado|blancos|dejar en blanco|sello electr/i.test(c.desc) || /^en blanco$/i.test(c.contenido ?? '') || c.blancos;
    if (reservado && c.tipo !== 'Num' && c.tipo !== 'N') {
      if (v.trim() !== '') mal('tiene que ir en blanco');
      continue;
    }
    // El correo electrónico de contacto (200) lleva @ y puntos.
    const patron = /correo electr/i.test(c.desc) ? /^[A-Za-z0-9@._\- ]*$/ : an;
    if (c.tipo === 'Num' && !/^\d+$/.test(v)) mal('numérico sin signo: solo cifras');
    else if (c.tipo === 'N' && !/^(N\d+|\d+)$/.test(v)) mal("numérico con signo: cifras con 'N' delante si es negativo");
    else if ((c.tipo === 'An' || c.tipo === 'A') && !patron.test(v)) mal('alfanumérico: solo letras, cifras y blancos');
    else if ((c.tipo === 'An' || c.tipo === 'A') && v !== v.trimStart() && v.trim() !== '') mal('alfanumérico alineado a la izquierda');
  }
  return errores;
}

/** Lanza un error 500 claro si el generador ha producido algo fuera del diseño (no debería pasar). */
export function exigirDiseno(diseno: PaginaOficial, linea: string, opciones?: { alfanumericoLibre?: RegExp }): void {
  const e = validarRegistro(diseno, linea, opciones);
  if (e.length) {
    const d = e.slice(0, 3).map((x) => `pos. ${x.pos} (${x.desc.slice(0, 60)}): ${x.motivo}`).join('; ');
    throw new Error(`El fichero no cumple el diseño de ${diseno.hoja}: ${d}`);
  }
}
