/**
 * Validador de cifras de las respuestas de la IA.
 *
 * Se sacan importes, porcentajes, fechas y números de 3 o más cifras, también
 * los escritos con «mil» o «millones» («2 millones de euros») y con palabras
 * («tres mil euros», «el veintiuno por ciento»). Solo valen los que aparecen en
 * la pregunta o en las fichas que se enviaron, más los códigos de modelo y los
 * años 2024-2028. La fecha de hoy solo vale como fecha («hoy, 7 de octubre»):
 * su día y su mes no respaldan un porcentaje ni un importe. Si alguna cifra no
 * tiene respaldo, la respuesta se descarta entera (sin regenerar).
 */
import { sinTildes } from '../../utils/texto';
import { MODELOS } from './huecos/otros';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «1.234,56» → «1234.56»; «21» → «21»; «0,5» → «0.5». */
function canonico(numero: string): string {
  let n = numero.trim();
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(n)) n = n.replace(/\./g, '');
  n = n.replace(',', '.');
  const v = Number(n);
  return Number.isFinite(v) ? String(v) : n;
}

/** Número en cifras con «mil» o «millones» detrás: «1,5 millones» → 1500000. */
function conMultiplicador(numero: string, multiplicador: string): string {
  const base = Number(canonico(numero));
  const factor = multiplicador.startsWith('mil') && multiplicador !== 'mil' ? 1_000_000 : 1000;
  return Number.isFinite(base) ? String(Math.round(base * factor * 100) / 100) : `${numero} ${multiplicador}`;
}

// ---------- Números escritos con palabras ----------

const VALOR_PALABRA: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700, setecientas: 700,
  ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
const PALABRAS_NUMERO = `(?:${[...Object.keys(VALOR_PALABRA), 'mil', 'millon', 'millones'].sort((a, b) => b.length - a.length).join('|')})`;
/** Secuencia de palabras de número («tres mil quinientos», «dos millones»), con «y» entre ellas. */
const RE_NUMERO_PALABRAS = new RegExp(`\\b${PALABRAS_NUMERO}(?:(?: y)? ${PALABRAS_NUMERO})*\\b`, 'g');

/** «tres mil quinientos» → 3500; «dos millones» → 2000000. */
export function valorPalabras(texto: string): number | null {
  let total = 0;
  let actual = 0;
  let alguna = false;
  for (const p of texto.split(' ')) {
    if (p === 'y') continue;
    if (p === 'mil') {
      actual = (actual || 1) * 1000;
      total += actual;
      actual = 0;
    } else if (p === 'millon' || p === 'millones') {
      total = (total + (actual || 1)) * 1_000_000;
      actual = 0;
    } else if (VALOR_PALABRA[p] !== undefined) {
      actual += VALOR_PALABRA[p];
    } else {
      return null;
    }
    alguna = true;
  }
  return alguna ? total + actual : null;
}

export interface CifraEncontrada {
  tipo: 'importe' | 'porcentaje' | 'fecha' | 'numero';
  texto: string;
  valor: string;
}

const UNIDAD = '(?:€|eur\\b|euros?\\b|%|por ciento\\b)';

/** Cifras de un texto, con su valor canónico para comparar. */
export function extraerCifras(texto: string): CifraEncontrada[] {
  // Minúsculas y sin tildes («millón», «dieciséis»): las posiciones no cambian.
  const t = sinTildes(texto.toLowerCase());
  const out: CifraEncontrada[] = [];
  const usados: Array<[number, number]> = [];
  const libre = (i: number, f: number) => !usados.some(([a, b]) => i < b && f > a);
  const anotar = (re: RegExp, tipo: CifraEncontrada['tipo'] | ((m: RegExpExecArray) => CifraEncontrada['tipo'] | null), valor: (m: RegExpExecArray) => string | null) => {
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const ini = m.index;
      const fin = ini + m[0].length;
      if (!libre(ini, fin)) continue;
      const tp = typeof tipo === 'function' ? tipo(m) : tipo;
      const v = valor(m);
      if (!tp || v === null) continue;
      usados.push([ini, fin]);
      out.push({ tipo: tp, texto: m[0].trim(), valor: v });
    }
  };
  // Fechas: 20/10/2026, 20-10, «20 de octubre (de 2026)».
  anotar(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, 'fecha', (m) => `${Number(m[1])}-${Number(m[2])}`);
  anotar(new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})(?: de (\\d{4}))?`, 'g'), 'fecha', (m) => `${Number(m[1])}-${MESES.indexOf(m[2]) + 1}`);
  // Cifras con «mil» o «millones»: «2 millones de euros», «300 mil», «1,5 millones».
  anotar(/(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s(mil(?:lon(?:es)?)?)\b(?: de euros?| euros?| €)?/g, 'importe', (m) => conMultiplicador(m[1], m[2]));
  // Números con palabras: con «mil»/«millones», o con una unidad detrás («tres mil euros», «veintiuno por ciento»).
  anotar(
    new RegExp(`${RE_NUMERO_PALABRAS.source}(?:\\s?(?:de )?(${UNIDAD}))?`, 'g'),
    (m) => {
      const conMil = /\b(mil|millon|millones)\b/.test(m[0]);
      if (!m[1] && !conMil) return null;
      return m[1] && /%|ciento/.test(m[1]) ? 'porcentaje' : 'importe';
    },
    (m) => {
      const palabras = m[0].replace(new RegExp(`\\s?(?:de )?${UNIDAD}$`), '').trim();
      const v = valorPalabras(palabras);
      return v === null ? null : String(v);
    },
  );
  // Porcentajes: 21 %, 10,5%, 15 por ciento.
  anotar(/(\d+(?:[.,]\d+)?)\s?(?:%|por ciento)/g, 'porcentaje', (m) => canonico(m[1]));
  // Importes: 3.005,06 €, 1000 euros.
  anotar(/(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)\s?(?:€|eur\b|euros?)/g, 'importe', (m) => canonico(m[1]));
  // Números de 3 o más cifras (con o sin puntos de miles).
  anotar(/\b(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d{3,}(?:,\d+)?)\b/g, 'numero', (m) => canonico(m[1]));
  return out;
}

/** Valores permitidos: las cifras que aparecen en los textos de referencia. */
function permitidos(referencias: string[]): Set<string> {
  const set = new Set<string>();
  for (const r of referencias) {
    for (const c of extraerCifras(r)) set.add(`${c.tipo === 'fecha' ? 'f' : 'n'}:${c.valor}`);
    // Cualquier número suelto de la referencia también vale como número o importe.
    for (const m of r.matchAll(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)) set.add(`n:${canonico(m[0])}`);
  }
  return set;
}

function siempreValida(c: CifraEncontrada): boolean {
  if (c.tipo === 'fecha') return false;
  if ((MODELOS as readonly string[]).includes(c.valor)) return true;
  const n = Number(c.valor);
  if (c.tipo === 'numero' && Number.isInteger(n) && n >= 2024 && n <= 2028) return true;
  return false;
}

export interface ResultadoValidacion {
  ok: boolean;
  sinRespaldo: string[];
}

export interface OpcionesValidacion {
  /** Fechas AAAA-MM-DD que valen solo como fecha (la de hoy). */
  fechas?: string[];
}

export function validarCifras(respuesta: string, referencias: string[], opciones: OpcionesValidacion = {}): ResultadoValidacion {
  const ok = permitidos(referencias);
  for (const f of opciones.fechas ?? []) ok.add(`f:${Number(f.slice(8, 10))}-${Number(f.slice(5, 7))}`);
  const sinRespaldo = extraerCifras(respuesta)
    .filter((c) => !siempreValida(c) && !ok.has(`${c.tipo === 'fecha' ? 'f' : 'n'}:${c.valor}`))
    .map((c) => c.texto);
  return { ok: sinRespaldo.length === 0, sinRespaldo };
}
