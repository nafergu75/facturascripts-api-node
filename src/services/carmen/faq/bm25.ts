/**
 * Búsqueda BM25 (k1 = 1,2; b = 0,75) sobre las fichas de la FAQ.
 *
 * Cada ficha aporta varios documentos (la pregunta y cada variante, con sus
 * etiquetas) y su puntuación es la del mejor. La puntuación se normaliza entre
 * 0 y 1 dividiéndola por la que tendría un documento de longitud media con
 * todas las palabras de la pregunta; las palabras que no aparecen en ninguna
 * ficha cuentan como muy raras, así que una pregunta que habla de otra cosa
 * puntúa bajo.
 */
import { normalizar } from '../normalizar';
import { PALABRAS_VACIAS } from '../vocabulario';

const K1 = 1.2;
const B = 0.75;

/** Raíz muy simple: quita el plural para que «facturas» y «factura» coincidan. */
export function raiz(palabra: string): string {
  if (palabra.length > 5 && /[lnrdzj]es$/.test(palabra)) return palabra.slice(0, -2);
  if (palabra.length > 3 && palabra.endsWith('s')) return palabra.slice(0, -1);
  return palabra;
}

export function terminos(texto: string): string[] {
  return normalizar(texto)
    .tokens.filter((t) => t.length > 1 && !PALABRAS_VACIAS.has(t))
    .map(raiz);
}

interface Doc {
  idFicha: string;
  tf: Map<string, number>;
  largo: number;
}

/** Tope de una ficha que no coincide exactamente: deja 0,10 de margen a la que sí. */
const TOPE_NO_EXACTA = 0.9;

export interface Resultado {
  id: string;
  puntuacion: number;
}

export class IndiceBM25 {
  private docs: Doc[] = [];
  private df = new Map<string, number>();
  private largoMedio = 1;

  constructor(documentos: Array<{ id: string; textos: string[] }>) {
    for (const d of documentos) {
      for (const texto of d.textos) {
        const ts = terminos(texto);
        if (!ts.length) continue;
        const tf = new Map<string, number>();
        ts.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
        this.docs.push({ idFicha: d.id, tf, largo: ts.length });
      }
    }
    for (const doc of this.docs) for (const t of doc.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.largoMedio = this.docs.reduce((s, d) => s + d.largo, 0) / Math.max(1, this.docs.length);
  }

  private idf(t: string): number {
    const n = this.docs.length;
    const df = this.df.get(t) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * Fichas ordenadas por puntuación normalizada (0-1). La referencia es un
   * documento con exactamente las palabras de la pregunta (una vez cada una):
   * ese puntúa 1; uno más largo o al que le faltan palabras, menos.
   */
  buscar(pregunta: string, max = 5): Resultado[] {
    const q = [...new Set(terminos(pregunta))];
    if (!q.length) return [];
    const factor = (K1 + 1) / (1 + K1 * (1 - B + (B * q.length) / this.largoMedio));
    const ideal = q.reduce((s, t) => s + this.idf(t) * factor, 0);
    if (ideal <= 0) return [];
    const porFicha = new Map<string, number>();
    for (const doc of this.docs) {
      let s = 0;
      for (const t of q) {
        const f = doc.tf.get(t);
        if (!f) continue;
        s += (this.idf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.largo) / this.largoMedio));
      }
      // Misma pregunta que la de la ficha (o una variante), palabra por palabra: 1.
      const exacta = doc.tf.size === q.length && q.every((t) => doc.tf.has(t));
      const puntuacion = exacta ? 1 : Math.min(TOPE_NO_EXACTA, s / ideal);
      if (puntuacion > (porFicha.get(doc.idFicha) ?? 0)) porFicha.set(doc.idFicha, puntuacion);
    }
    return [...porFicha.entries()]
      .map(([id, puntuacion]) => ({ id, puntuacion }))
      .sort((a, b) => b.puntuacion - a.puntuacion)
      .slice(0, max);
  }
}
