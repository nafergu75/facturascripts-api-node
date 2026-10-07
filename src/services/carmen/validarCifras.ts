/**
 * Validador de cifras de las respuestas de la IA.
 *
 * Se sacan importes, porcentajes, fechas y números de 3 o más cifras. Solo
 * valen los que aparecen en la pregunta o en las fichas que se enviaron, más los
 * códigos de modelo, los años 2024-2028 y los trimestres. Si alguna cifra no
 * tiene respaldo, la respuesta se descarta entera (sin regenerar).
 */
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

export interface CifraEncontrada {
  tipo: 'importe' | 'porcentaje' | 'fecha' | 'numero';
  texto: string;
  valor: string;
}

/** Cifras de un texto, con su valor canónico para comparar. */
export function extraerCifras(texto: string): CifraEncontrada[] {
  const t = texto.toLowerCase();
  const out: CifraEncontrada[] = [];
  const usados: Array<[number, number]> = [];
  const libre = (i: number, f: number) => !usados.some(([a, b]) => i < b && f > a);
  const anotar = (re: RegExp, tipo: CifraEncontrada['tipo'], valor: (m: RegExpExecArray) => string) => {
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const ini = m.index;
      const fin = ini + m[0].length;
      if (!libre(ini, fin)) continue;
      usados.push([ini, fin]);
      out.push({ tipo, texto: m[0].trim(), valor: valor(m) });
    }
  };
  // Fechas: 20/10/2026, 20-10, «20 de octubre (de 2026)».
  anotar(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, 'fecha', (m) => `${Number(m[1])}-${Number(m[2])}`);
  anotar(new RegExp(`\\b(\\d{1,2}) de (${MESES.join('|')})(?: de (\\d{4}))?`, 'g'), 'fecha', (m) => `${Number(m[1])}-${MESES.indexOf(m[2]) + 1}`);
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

export function validarCifras(respuesta: string, referencias: string[]): ResultadoValidacion {
  const ok = permitidos(referencias);
  const sinRespaldo = extraerCifras(respuesta)
    .filter((c) => !siempreValida(c) && !ok.has(`${c.tipo === 'fecha' ? 'f' : 'n'}:${c.valor}`))
    .map((c) => c.texto);
  return { ok: sinRespaldo.length === 0, sinRespaldo };
}
