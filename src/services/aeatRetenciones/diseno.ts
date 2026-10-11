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
import { normalizarNif, validarNifEspanol } from '../../utils/nif';
import { validateIban } from '../../utils/validateIban';

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

/**
 * Texto para un campo An o A: mayusculas, sin acentos, solo letras, cifras y
 * blancos (la Ñ y la Ç se quedan), sin blancos dobles. "Mi Empresa, S.L." ->
 * "MI EMPRESA S L"; "Muñoz & Cía" -> "MUÑOZ CIA".
 */
export function sanearAN(valor: unknown): string {
  return String(valor ?? '')
    .toUpperCase()
    .replace(/Ñ/g, '\u0000')
    .replace(/Ç/g, '\u0001')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\u0000/g, 'Ñ')
    .replace(/\u0001/g, 'Ç')
    .replace(/[^A-Z0-9ÑÇ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persona fisica: NIF que empieza por cifra (DNI) o por K, L, M, X, Y o Z. */
export function esPersonaFisica(nif: string): boolean {
  return /^[0-9KLMXYZ]/.test(normalizarNif(nif));
}

/**
 * Por que un NIF no vale para un fichero de la AEAT (letra o digito de control
 * incluidos), o null si vale. Con `persona`, un CIF de sociedad tampoco vale
 * (trabajadores y conyuges del 190).
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

/** Error del NIF de la empresa declarante (111, 115 y 190), con el NIF y donde se corrige; null si vale. */
export function errorNifDeclarante(valor: unknown): string | null {
  const nif = normalizarNif(valor);
  if (!nif) return 'Falta el NIF de la empresa. Rellénalo en Registro Mercantil > Datos para la memoria y vuelve a descargar el fichero.';
  const motivo = motivoNifNoValido(nif);
  return motivo ? `El NIF de la empresa (${nif}) no es válido: ${motivo}. Corrígelo en Registro Mercantil > Datos para la memoria.` : null;
}

/** NIF del declarante normalizado y validado; error claro si falta o no es valido. */
export function nifDeclarante(valor: unknown): string {
  const error = errorNifDeclarante(valor);
  if (error) throw badRequest(error);
  return normalizarNif(valor);
}

/** IBAN sin espacios y en mayusculas, o null si no es valido. */
export function ibanNormalizado(valor: unknown): string | null {
  const iban = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!iban) return null;
  const r = validateIban(iban);
  return r.valid ? (r.normalized ?? iban) : null;
}

/** Periodo valido del 111 y del 115: '01'...'12' o '1T'...'4T' (no tienen periodo anual). */
export const PERIODO_111_115 = /^(0[1-9]|1[0-2]|[1-4]T)$/;

// ---------------------------------------------------------------------------
// Codificador
// ---------------------------------------------------------------------------

export type ValorDr = string | number | boolean | null | undefined;
export type ValoresDr = Record<string, ValorDr>;

const etiqueta = (registro: RegistroDr, c: CampoDr) => (c.casilla ? `casilla [${c.casilla}]` : `"${c.desc}"`) + ` (posición ${c.pos} del registro ${registro.id})`;

function cifras(registro: RegistroDr, c: CampoDr, valor: ValorDr): string {
  if (typeof valor === 'string' && /^\d+$/.test(valor.trim())) return valor.trim().replace(/^0+(?=\d)/, '');
  const n = Number(valor);
  if (!Number.isFinite(n)) throw badRequest(`El valor de la ${etiqueta(registro, c)} no es un número.`);
  return String(c.decimales ? Math.round(Math.abs(n) * 10 ** c.decimales) : Math.trunc(Math.abs(n)));
}

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
      const texto = c.libre ? String(valor).replace(/[^\x20-\x7e]/g, '').trim() : sanearAN(valor);
      if (c.alinear === 'derecha') {
        const v = texto.replace(/ /g, '');
        if (!v) return ' '.repeat(c.lon);
        if (v.length > c.lon) throw badRequest(`El valor "${v}" no cabe en la ${etiqueta(registro, c)}.`);
        return v.padStart(c.lon, '0');
      }
      return texto.slice(0, c.lon).padEnd(c.lon, ' ');
    }
    case 'Num': {
      if (vacio) return '0'.repeat(c.lon);
      if (typeof valor === 'number' && Math.round(valor * 10 ** (c.decimales ?? 0)) < 0) {
        throw badRequest(`La ${etiqueta(registro, c)} no admite importes negativos.`);
      }
      const d = cifras(registro, c, valor);
      if (d.length > c.lon) throw badRequest(`El importe de la ${etiqueta(registro, c)} no cabe en ${c.lon} cifras.`);
      return d.padStart(c.lon, '0');
    }
    case 'N': {
      if (vacio) return '0'.repeat(c.lon);
      const negativo = Math.round(Number(valor) * 10 ** (c.decimales ?? 0)) < 0;
      const d = cifras(registro, c, valor);
      const ancho = negativo ? c.lon - 1 : c.lon;
      if (d.length > ancho) throw badRequest(`El importe de la ${etiqueta(registro, c)} no cabe en ${c.lon} posiciones.`);
      return (negativo ? 'N' : '') + d.padStart(ancho, '0');
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
