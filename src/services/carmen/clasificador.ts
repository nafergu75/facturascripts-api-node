/**
 * Clasificador de preguntas de datos (paso 5 del enrutador).
 *
 * puntuación = 0,6 × reglas + 0,4 × kNN (+0,10 si la página actual es del área)
 *  - reglas: 1 si están todos los grupos de conceptos obligatorios; si solo
 *    parte, la mitad de esa fracción al cuadrado; 0 si aparece un excluyente o
 *    falta un grupo de señales (['__cliente']);
 *  - kNN: similitud coseno TF-IDF de n-gramas de caracteres (3 a 5) contra las
 *    frases de ejemplo de cada intención (la mejor).
 *
 * Decisión (en el enrutador):
 *  - ≥ 0,55 y margen ≥ 0,15 sobre la segunda: se ejecuta;
 *  - 0,35-0,55, o margen menor: se pregunta con botones;
 *  - ≥ 0,35: la pregunta es de datos y nunca llega a la IA.
 */
import { plano } from '../../utils/texto';
import { contieneFrase, normalizar, olvidarCorrecciones } from './normalizar';
import { registrarVocabulario } from './vocabulario';
import { extraerPeriodo } from './huecos/periodo';
import { extraerNumeroFactura } from './huecos/otros';
import { INTENCIONES, type Intencion } from './intenciones/catalogo';

export const UMBRAL_EJECUTAR = 0.55;
export const MARGEN_EJECUTAR = 0.15;
export const UMBRAL_DATOS = 0.35;
const PESO_REGLAS = 0.6;
const PESO_KNN = 0.4;
const EXTRA_PAGINA = 0.1;

/** Señales de huecos encontrados en la pregunta ('__periodo', '__cliente'...). */
export type Senales = ReadonlySet<string>;

// ---------- Vocabulario: palabras de ejemplos y conceptos ----------

registrarVocabulario(
  INTENCIONES.flatMap((i) => [...i.ejemplos, ...i.conceptos.obligatorios.flat(), ...(i.conceptos.excluyentes ?? [])])
    // Los prefijos ('cobr*') no son palabras: no se corrige hacia ellos.
    .filter((t) => !t.startsWith('__') && !t.endsWith('*'))
    .flatMap((t) => plano(t).replace(/[^a-zñ0-9 ]/g, ' ').split(' ')),
);
olvidarCorrecciones();

// ---------- Reglas ----------

function presente(texto: string, senales: Senales, termino: string): boolean {
  return termino.startsWith('__') ? senales.has(termino) : contieneFrase(texto, termino);
}

export function puntuacionReglas(intencion: Intencion, texto: string, senales: Senales): number {
  const { obligatorios, excluyentes = [] } = intencion.conceptos;
  if (excluyentes.some((t) => presente(texto, senales, t))) return 0;
  if (!obligatorios.length) return 0;
  // Un grupo hecho solo de señales (p. ej. ['__cliente']) es imprescindible: sin él, 0.
  if (obligatorios.some((g) => g.every((t) => t.startsWith('__')) && !g.some((t) => senales.has(t)))) return 0;
  const cumplidos = obligatorios.filter((grupo) => grupo.some((t) => presente(texto, senales, t))).length;
  // Cumplir solo parte de los grupos cuenta poco: «¿cuánto cuesta un abogado?» no es de datos.
  const fraccion = cumplidos / obligatorios.length;
  return fraccion < 1 ? (fraccion * fraccion) / 2 : 1;
}

// ---------- kNN con TF-IDF de n-gramas de caracteres ----------

function ngramas(texto: string): Map<string, number> {
  const t = ` ${texto} `;
  const m = new Map<string, number>();
  for (let n = 3; n <= 5; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const g = t.slice(i, i + n);
      if (g.trim().length < 2) continue;
      m.set(g, (m.get(g) ?? 0) + 1);
    }
  }
  return m;
}

type Vector = Map<string, number>;

/** Texto que se clasifica: sin el periodo ni el número de factura (son huecos, no intención). */
export function textoParaClasificar(texto: string, hoy: string): string {
  let t = texto;
  const p = extraerPeriodo(t, hoy);
  if (p) t = p.resto;
  const num = extraerNumeroFactura(t);
  if (num) t = t.replace(new RegExp(`(^| )${num.toLowerCase().replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}( |$)`), ' ');
  return t.replace(/\s+/g, ' ').trim();
}

class IndiceKnn {
  private idf = new Map<string, number>();
  private idfDesconocido = 1;
  private ejemplos: Array<{ intencion: string; vector: Vector }> = [];

  constructor(intenciones: Intencion[]) {
    // Fecha fija: solo sirve para quitar los periodos de los ejemplos.
    const docs = intenciones.flatMap((i) => i.ejemplos.map((e) => ({ intencion: i.id, grams: ngramas(textoParaClasificar(normalizar(e).texto, '2026-10-07')) })));
    const df = new Map<string, number>();
    for (const d of docs) for (const g of d.grams.keys()) df.set(g, (df.get(g) ?? 0) + 1);
    const n = docs.length;
    for (const [g, c] of df) this.idf.set(g, Math.log((n + 1) / (c + 1)) + 1);
    this.idfDesconocido = Math.log(n + 1) + 1;
    this.ejemplos = docs.map((d) => ({ intencion: d.intencion, vector: this.vectorizar(d.grams) }));
  }

  private vectorizar(grams: Map<string, number>): Vector {
    const v: Vector = new Map();
    let norma = 0;
    for (const [g, tf] of grams) {
      const w = (1 + Math.log(tf)) * (this.idf.get(g) ?? this.idfDesconocido);
      v.set(g, w);
      norma += w * w;
    }
    norma = Math.sqrt(norma) || 1;
    for (const [g, w] of v) v.set(g, w / norma);
    return v;
  }

  /** Mejor similitud con los ejemplos de cada intención. */
  similitudes(texto: string): Map<string, number> {
    const q = this.vectorizar(ngramas(texto));
    const out = new Map<string, number>();
    for (const e of this.ejemplos) {
      let dot = 0;
      for (const [g, w] of q) {
        const we = e.vector.get(g);
        if (we) dot += w * we;
      }
      if (dot > (out.get(e.intencion) ?? 0)) out.set(e.intencion, dot);
    }
    return out;
  }
}

let knn: IndiceKnn | null = null;
const indiceKnn = () => (knn ??= new IndiceKnn(INTENCIONES));

// ---------- Clasificación ----------

export interface Puntuacion {
  intencion: Intencion;
  puntuacion: number;
  reglas: number;
  knn: number;
}

/**
 * Puntúa todas las intenciones, de mayor a menor. Las reglas miran el texto
 * normalizado sin el nombre del tercero; el kNN, además, sin el periodo ni el
 * número de factura (textoParaClasificar), igual que sus ejemplos.
 */
export function clasificar(texto: string, senales: Senales, paginaActual?: string, hoy = '2026-10-07'): Puntuacion[] {
  const sims = indiceKnn().similitudes(textoParaClasificar(texto, hoy));
  return INTENCIONES.map((intencion) => {
    const reglas = puntuacionReglas(intencion, texto, senales);
    const vecino = sims.get(intencion.id) ?? 0;
    const enPagina = !!paginaActual && (intencion.paginas ?? []).some((p) => paginaActual === p || paginaActual.startsWith(`${p}/`));
    const puntuacion = Math.min(1, PESO_REGLAS * reglas + PESO_KNN * vecino + (enPagina && reglas > 0 ? EXTRA_PAGINA : 0));
    return { intencion, puntuacion, reglas, knn: vecino };
  }).sort((a, b) => b.puntuacion - a.puntuacion);
}

export type DecisionClasificador =
  | { tipo: 'ejecutar'; mejor: Puntuacion; ranking: Puntuacion[] }
  | { tipo: 'dudas'; ranking: Puntuacion[] }
  | { tipo: 'nada'; ranking: Puntuacion[] };

export function decidir(ranking: Puntuacion[]): DecisionClasificador {
  const [primera, segunda] = ranking;
  if (!primera || primera.puntuacion < UMBRAL_DATOS) return { tipo: 'nada', ranking };
  const margen = primera.puntuacion - (segunda?.puntuacion ?? 0);
  if (primera.puntuacion >= UMBRAL_EJECUTAR && margen >= MARGEN_EJECUTAR) return { tipo: 'ejecutar', mejor: primera, ranking };
  return { tipo: 'dudas', ranking };
}
