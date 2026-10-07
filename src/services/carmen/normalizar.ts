/**
 * Normaliza la pregunta antes de clasificarla:
 *  - minúsculas, sin tildes y sin ¿?¡!;
 *  - importes en formato español a número («1.234,56 €» → «1234.56 euros»);
 *  - abreviaturas habituales (fra → factura, 1t → primer trimestre...);
 *  - corrección de faltas SOLO contra el vocabulario del dominio. Una palabra
 *    desconocida y sin parecido se deja tal cual (puede ser un nombre).
 *
 * Devuelve también el texto sin corregir (`base`), que es el que se usa para
 * buscar nombres de terceros: «Rosa» no debe convertirse en «cosa».
 */
import { sinTildes } from '../../utils/texto';
import { esPalabraDelDominio, registrarVocabulario, vocabulario } from './vocabulario';

export interface TextoNormalizado {
  original: string;
  /** Normalizado, sin corregir faltas. */
  base: string;
  /** Normalizado y corregido: es el que se clasifica. */
  texto: string;
  tokens: string[];
}

/** Abreviaturas por palabra completa (ya en minúsculas y sin tildes). */
export const ABREVIATURAS: Record<string, string> = {
  fra: 'factura',
  fras: 'facturas',
  fact: 'factura',
  facts: 'facturas',
  cli: 'cliente',
  clis: 'clientes',
  prov: 'proveedor',
  provs: 'proveedores',
  pyg: 'perdidas y ganancias',
  hda: 'hacienda',
  ss: 'seguridad social',
  q: 'que',
  k: 'que',
  xq: 'porque',
  pq: 'porque',
  porq: 'porque',
  tb: 'tambien',
  tmb: 'tambien',
  cta: 'cuenta',
  ctas: 'cuentas',
  mov: 'movimiento',
  movs: 'movimientos',
  num: 'numero',
  'nº': 'numero',
  imp: 'impuesto',
  irpf: 'irpf',
  '1t': 'primer trimestre',
  t1: 'primer trimestre',
  '1tr': 'primer trimestre',
  '2t': 'segundo trimestre',
  t2: 'segundo trimestre',
  '2tr': 'segundo trimestre',
  '3t': 'tercer trimestre',
  t3: 'tercer trimestre',
  '3tr': 'tercer trimestre',
  '4t': 'cuarto trimestre',
  t4: 'cuarto trimestre',
  '4tr': 'cuarto trimestre',
  '1er': 'primer',
  '1º': 'primer',
  '2º': 'segundo',
  '3er': 'tercer',
  '3º': 'tercer',
  '4º': 'cuarto',
};

/** «1.234,56» o «1234,5» → «1234.56» / «1234.5». Respeta fechas (15/12) y números de factura (2026-0045). */
function importesANumero(texto: string): string {
  return texto
    .replace(/(?<![\d/.,-])(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?(?![\d/-])/g, (_m, ent: string, dec?: string) =>
      `${ent.replace(/\./g, '')}${dec ? `.${dec}` : ''}`,
    )
    .replace(/(?<![\d/.,-])(\d+),(\d{1,2})(?![\d/-])/g, '$1.$2');
}

/** Distancia de Damerau-Levenshtein (alineamiento óptimo), cortando si pasa de `max`. */
export function distanciaEdicion(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let minFila = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const coste = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + coste);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < minFila) minFila = v;
    }
    if (minFila > max) return max + 1;
  }
  return d[a.length][b.length];
}

// Las palabras de las abreviaturas son del dominio («cuarto trimestre» no se corrige).
registrarVocabulario(Object.values(ABREVIATURAS).flatMap((v) => v.split(' ')));

const cacheCorreccion = new Map<string, string>();

/**
 * Corrige una palabra contra el vocabulario: distancia 1 hasta 7 letras y 2 en
 * las de 8 o más, y solo si hay un único candidato más cercano. Con distancia 2
 * la primera letra tiene que coincidir. Si no, la palabra se queda como está:
 * con distancia 2 en palabras cortas, «García» acababa en «gracias» y
 * «siendo» en «asiento».
 */
export function corregirPalabra(palabra: string): string {
  if (palabra.length < 4 || !/^[a-zñ]+$/.test(palabra) || esPalabraDelDominio(palabra)) return palabra;
  const enCache = cacheCorreccion.get(palabra);
  if (enCache !== undefined) return enCache;
  const max = palabra.length <= 7 ? 1 : 2;
  let mejor: string | null = null;
  let mejorDist = max + 1;
  let empate = false;
  for (const candidata of vocabulario()) {
    if (candidata.length < 3 || Math.abs(candidata.length - palabra.length) > max) continue;
    let dist = distanciaEdicion(palabra, candidata, max);
    if (dist === 2 && candidata[0] !== palabra[0]) dist = max + 1;
    if (dist < mejorDist) {
      mejor = candidata;
      mejorDist = dist;
      empate = false;
    } else if (dist === mejorDist && dist <= max) {
      empate = true;
    }
  }
  const resultado = mejor && mejorDist <= max && !empate ? mejor : palabra;
  if (cacheCorreccion.size > 5000) cacheCorreccion.clear();
  cacheCorreccion.set(palabra, resultado);
  return resultado;
}

/** Vacía la caché de correcciones (al ampliar el vocabulario). */
export function olvidarCorrecciones(): void {
  cacheCorreccion.clear();
}

/** Minúsculas, sin tildes, importes como número y sin signos de puntuación sueltos. */
export function normalizarBase(texto: string): string {
  let t = sinTildes(texto.toLowerCase());
  t = importesANumero(t);
  t = t.replace(/€/g, ' euros ');
  t = t.replace(/[¿?¡!;:"'«»()[\]{}<>*_=+|\\]/g, ' ');
  // Comas y puntos que no van entre cifras separan palabras.
  t = t.replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ');
  t = t
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => ABREVIATURAS[tok] ?? tok)
    .join(' ');
  return t.replace(/\s+/g, ' ').trim();
}

export function normalizar(texto: string): TextoNormalizado {
  const base = normalizarBase(texto);
  const tokens = base.split(' ').filter(Boolean).map(corregirPalabra);
  return { original: texto, base, texto: tokens.join(' '), tokens };
}

/** Busca una frase (palabras completas) o un prefijo terminado en '*' dentro de un texto normalizado. */
export function contieneFrase(texto: string, frase: string): boolean {
  if (frase.endsWith('*')) {
    const raiz = frase.slice(0, -1);
    return new RegExp(`(^| )${escaparRegex(raiz)}`).test(texto);
  }
  return new RegExp(`(^| )${escaparRegex(frase)}( |$)`).test(texto);
}

export function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
