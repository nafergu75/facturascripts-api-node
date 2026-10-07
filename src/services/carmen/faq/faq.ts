/**
 * Capa 2 de Carmen: fichas verificadas (sin IA, sin coste).
 */
import { plano } from '../../../utils/texto';
import { olvidarCorrecciones } from '../normalizar';
import { registrarVocabulario } from '../vocabulario';
import type { CuerpoRespuesta } from '../tipos';
import { IndiceBM25 } from './bm25';
import { FICHAS, type FichaFAQ } from './faq.data';

export const UMBRAL_FAQ = 0.65;
export const MARGEN_FAQ = 0.1;
export const UMBRAL_FAQ_DUDA = 0.4;

// Las palabras de las fichas entran en el vocabulario de corrección de faltas.
registrarVocabulario(
  FICHAS.flatMap((f) => [f.pregunta, ...f.variantes, ...f.etiquetas])
    .flatMap((t) => plano(t).replace(/[^a-zñ0-9 ]/g, ' ').split(' ')),
);
olvidarCorrecciones();

/** Verificada, vigente hoy y sin pasar de su fecha de revisión. */
export function fichaServible(f: FichaFAQ, hoy: string): boolean {
  if (!f.verificada) return false;
  if (f.vigenteDesde && f.vigenteDesde > hoy) return false;
  if (f.vigenteHasta && f.vigenteHasta < hoy) return false;
  return f.revisarAntes > hoy;
}

/** Bloques que valen también para una empresa no establecida en España. */
const BLOQUES_COMUNES = new Set<FichaFAQ['bloque']>(['app', 'contabilidad']);
/** Pregunta, etiquetas o pantalla de IVA, AEAT, modelos, IRPF o nóminas: solo para empresas establecidas en España. */
const SOLO_ESPANA = /\b(iva|aeat|irpf|n[oó]minas?|hacienda)\b|\bmodelos? \d{3}\b|\b(303|111|115|190|200|347|349|390)\b|\/fiscal\b/i;
/** Respuesta que explica el IVA español (cuentas 472/477), la AEAT o nóminas (mencionar el IVA como un campo más no basta). */
const RESPUESTA_SOLO_ESPANA = /\b(aeat|irpf|n[oó]minas?|hacienda)\b|\bmodelos? \d{3}\b|\biva (repercutido|soportado)\b/i;

/**
 * ¿Sirve la ficha para esta empresa? A una empresa no establecida en España no
 * se le ofrecen fichas de IVA, IRPF, Sociedades, facturación española, normas
 * de la AEAT ni nóminas: solo las de uso de la app y de contabilidad que no
 * hablan de ello.
 */
export function fichaParaEmpresa(f: FichaFAQ, espanola: boolean): boolean {
  if (espanola) return true;
  if (!BLOQUES_COMUNES.has(f.bloque)) return false;
  return !SOLO_ESPANA.test([f.pregunta, ...f.etiquetas, f.enlaceApp?.href ?? ''].join(' ')) && !RESPUESTA_SOLO_ESPANA.test(f.respuesta);
}

let indice: { dia: string; bm25: IndiceBM25 } | null = null;

function indiceDelDia(hoy: string): IndiceBM25 {
  if (!indice || indice.dia !== hoy) {
    const servibles = FICHAS.filter((f) => fichaServible(f, hoy));
    indice = {
      dia: hoy,
      // La pregunta y cada variante son documentos sueltos (para poder coincidir exactamente); las etiquetas, otro.
      bm25: new IndiceBM25(servibles.map((f) => ({ id: f.id, textos: [f.pregunta, ...f.variantes, f.etiquetas.join(' ')] }))),
    };
  }
  return indice.bm25;
}

export interface FichaPuntuada {
  ficha: FichaFAQ;
  puntuacion: number;
}

export function buscarFichas(pregunta: string, hoy: string, max = 3, espanola = true): FichaPuntuada[] {
  return indiceDelDia(hoy)
    .buscar(pregunta, espanola ? max : FICHAS.length)
    .map((r) => ({ ficha: FICHAS.find((f) => f.id === r.id)!, puntuacion: r.puntuacion }))
    .filter((r) => r.ficha && r.puntuacion > 0 && fichaParaEmpresa(r.ficha, espanola))
    .slice(0, max);
}

export function fichaPorId(id: string, hoy: string, espanola = true): FichaFAQ | null {
  const f = FICHAS.find((x) => x.id === id);
  return f && fichaServible(f, hoy) && fichaParaEmpresa(f, espanola) ? f : null;
}

/** Respuesta con una ficha: el texto, su fuente y la fecha en que se verificó. */
export function respuestaFicha(f: FichaFAQ): CuerpoRespuesta {
  return {
    origen: 'faq',
    texto: f.respuesta,
    fuente: { titulo: f.fuente.titulo, url: f.fuente.url, verificadaEl: f.verificadaEl },
    ...(f.enlaceApp ? { enlaces: [f.enlaceApp] } : {}),
  };
}

export { FICHAS };
