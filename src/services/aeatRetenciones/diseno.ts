/**
 * Diseños de registro oficiales de la AEAT de los modelos 111, 115 y 190,
 * cargados de las tablas JSON de src/domain/aeat (transcritas de los ficheros
 * que publica la AEAT: dr111e16v18.xls, DR115e15v13.xls y
 * DISENOS_LOGICOS_190_2025.pdf), y el codificador que compone cada registro a
 * partir de esas tablas. Las posiciones, longitudes, tipos y constantes salen
 * de la tabla: el codigo solo da los valores.
 *
 * Reglas de formato comunes a los tres diseños:
 * - An y A: letras, numeros y blancos, en mayusculas y sin vocales acentuadas
 *   (la Ñ y la Ç se conservan: el fichero va en ISO-8859-1), alineados a la
 *   izquierda y rellenos de blancos. Los NIF del 190 van a la derecha con ceros.
 * - Num: solo cifras, a la derecha y con ceros. Los importes, en centimos
 *   (dos decimales implicitos). Si no cabe, error: nunca se trunca una cifra.
 * - N (importe con signo): los negativos llevan una N en la primera posicion.
 */
import dr111Json from '../../domain/aeat/dr111-v2.json';
import dr115Json from '../../domain/aeat/dr115-v13.json';
import dr190Json from '../../domain/aeat/dr190-2025.json';
import { badRequest } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { errorNifDeclarante, ErrorImporteAeat, importeAeat, textoAeat } from '../../aeat/common/normalizacion';

export type TipoCampoDr = 'An' | 'A' | 'Num' | 'N';

export interface CampoDr {
  /** Numero de orden del campo en el diseño oficial. */
  n: number;
  /** Posicion inicial (1 = primera). */
  pos: number;
  lon: number;
  tipo: TipoCampoDr;
  desc: string;
  /** Contenido fijo del campo. */
  constante?: string;
  /** Nombre del valor que lo rellena (identificacion, opciones...). */
  clave?: string;
  /** Casilla del formulario que lo rellena ('01'...). */
  casilla?: string;
  /** Importe con dos decimales implicitos. */
  decimales?: number;
  /** Valores admitidos (solo informativo y para los tests). */
  valores?: string[];
  /** Reservado: siempre en blanco. */
  blancos?: boolean;
  /** NIF del 190: a la derecha y con ceros a la izquierda. */
  alinear?: 'derecha';
  /** Texto libre (correo electronico): admite @, punto, guion... */
  libre?: boolean;
  obligatorio?: boolean;
}

export interface RegistroDr {
  id: string;
  hoja: string;
  longitud: number;
  campos: CampoDr[];
}

export interface FilaFormularioDr {
  rotulo: string;
  casillas: string[];
}

export interface DisenoDr {
  modelo: string;
  fuente: string;
  version: string;
  comprobadoEnSede: string;
  ejercicio?: number;
  pendiente?: string;
  nombreFichero?: string;
  notas: string[];
  registros: RegistroDr[];
  formulario: {
    titulo: string;
    bloques?: Array<{ titulo: string; filas: FilaFormularioDr[] }>;
    columnas?: string[];
    total?: Array<{ casilla: string; rotulo: string }>;
    resumen?: Array<{ casilla: string; rotulo: string; campo: string }>;
  };
}

export const DR111 = dr111Json as unknown as DisenoDr;
export const DR115 = dr115Json as unknown as DisenoDr;
export const DR190 = dr190Json as unknown as DisenoDr;

/** Registro de un diseño por su id ('cabecera', 'M11101', 'tipo2'...). */
export function registroDr(diseno: DisenoDr, id: string): RegistroDr {
  const r = diseno.registros.find((x) => x.id === id);
  if (!r) throw new Error(`El diseño del ${diseno.modelo} no tiene el registro ${id}`);
  return r;
}

/** Campo de una casilla del formulario ('01'...). */
export function campoDeCasilla(registro: RegistroDr, casilla: string): CampoDr {
  const c = registro.campos.find((x) => x.casilla === casilla);
  if (!c) throw new Error(`El registro ${registro.id} no tiene la casilla ${casilla}`);
  return c;
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/** NIF del declarante normalizado y validado; error claro si falta o no es valido. */
export function nifDeclarante(valor: unknown): string {
  const error = errorNifDeclarante(valor);
  if (error) throw badRequest(error);
  return normalizarNif(valor);
}

/** Periodo valido del 111 y del 115: '01'...'12' o '1T'...'4T' (no tienen periodo anual). */
export const PERIODO_111_115 = /^(0[1-9]|1[0-2]|[1-4]T)$/;

// ---------------------------------------------------------------------------
// Codificador
// ---------------------------------------------------------------------------

export type ValorDr = string | number | boolean | null | undefined;
export type ValoresDr = Record<string, ValorDr>;

const etiqueta = (registro: RegistroDr, c: CampoDr) => (c.casilla ? `casilla [${c.casilla}]` : `"${c.desc}"`) + ` (posición ${c.pos} del registro ${registro.id})`;

/** Contenido de un campo segun su tipo (siempre de longitud c.lon). */
export function formatearCampoDr(registro: RegistroDr, c: CampoDr, valor: ValorDr): string {
  if (c.constante !== undefined) {
    if (c.constante.length !== c.lon) throw new Error(`Constante de longitud errónea en ${etiqueta(registro, c)}`);
    return c.constante;
  }
  if (c.blancos) return ' '.repeat(c.lon);
  const vacio = valor === null || valor === undefined || valor === '';
  switch (c.tipo) {
    case 'An':
    case 'A': {
      if (vacio || valor === false) return ' '.repeat(c.lon);
      const texto = c.libre ? String(valor).replace(/[^\x20-\x7e]/g, '').trim() : textoAeat(valor);
      if (c.alinear === 'derecha') {
        const v = texto.replace(/ /g, '');
        if (!v) return ' '.repeat(c.lon);
        if (v.length > c.lon) throw badRequest(`El valor "${v}" no cabe en la ${etiqueta(registro, c)}.`);
        return v.padStart(c.lon, '0');
      }
      return texto.slice(0, c.lon).padEnd(c.lon, ' ');
    }
    case 'Num':
    case 'N': {
      if (vacio) return '0'.repeat(c.lon);
      // Codigos y contadores que ya vienen en cifras ('0002'): tal cual, a la derecha.
      if (typeof valor === 'string' && /^\d+$/.test(valor.trim()) && !c.decimales) {
        const d = valor.trim().replace(/^0+(?=\d)/, '');
        if (d.length > c.lon) throw badRequest(`El valor de la ${etiqueta(registro, c)} no cabe en ${c.lon} cifras.`);
        return d.padStart(c.lon, '0');
      }
      try {
        return importeAeat(c.decimales ? valor : Math.trunc(Number(valor)), c.lon, { signo: c.tipo === 'N', decimales: c.decimales ?? 0, etiqueta: `La ${etiqueta(registro, c)}` });
      } catch (e) {
        if (!(e instanceof ErrorImporteAeat)) throw e;
        if (e.motivo === 'negativo') throw badRequest(`La ${etiqueta(registro, c)} no admite importes negativos.`);
        if (e.motivo === 'no-cabe') throw badRequest(`El importe de la ${etiqueta(registro, c)} no cabe en ${c.lon} ${c.tipo === 'N' ? 'posiciones' : 'cifras'}.`);
        throw badRequest(`El valor de la ${etiqueta(registro, c)} no es un número.`);
      }
    }
  }
}

/**
 * Compone un registro con su diseño: cada campo en su posicion, con el valor de
 * su clave o de su casilla. Lo que no tiene valor va a blancos (An, A) o a
 * ceros (Num, N), como manda el diseño.
 */
export function componerRegistroDr(registro: RegistroDr, valores: ValoresDr): string {
  let out = '';
  for (const c of registro.campos) {
    if (c.pos !== out.length + 1) throw new Error(`Diseño ${registro.id}: el campo ${c.n} no empieza donde acaba el anterior`);
    const nombre = c.clave ?? c.casilla;
    out += formatearCampoDr(registro, c, nombre ? valores[nombre] : undefined);
  }
  if (out.length !== registro.longitud) throw new Error(`Diseño ${registro.id}: ${out.length} posiciones en vez de ${registro.longitud}`);
  return out;
}

/** Valor de un campo en un registro ya compuesto (para leer y comprobar ficheros). */
export function leerCampoDr(registro: string, c: CampoDr): string {
  return registro.slice(c.pos - 1, c.pos - 1 + c.lon);
}
