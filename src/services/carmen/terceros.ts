/**
 * Búsqueda de clientes, proveedores y bancos por nombre dentro de la pregunta.
 *
 * Se busca EN MEMORIA, nunca con `contains` en la BD: TiDB (utf8mb4_bin)
 * distingue mayúsculas y tildes y «perez» no encontraría a «PÉREZ». El índice
 * de cada empresa se guarda 5 minutos por instancia y se refresca una vez si
 * no hay coincidencia (por si el cliente se dio de alta después).
 *
 * Puntuación de un candidato: la mayor entre Jaro-Winkler, Dice de trigramas y
 * el extra por prefijos («const perez» → CONSTRUCCIONES PÉREZ); un NIF exacto
 * vale 1.
 *  - ≥ 0,88 y con 0,08 de margen sobre el segundo: se usa.
 *  - 0,60-0,88, o empate: se pregunta con botones.
 *  - < 0,60: no se encuentra.
 */
import { prisma } from '../../config/database';
import { plano } from '../../utils/texto';
import { PALABRAS_VACIAS, esPalabraDelDominio } from './vocabulario';
import { RE_NIF } from './huecos/otros';

export type RolTercero = 'cliente' | 'proveedor' | 'banco';

export interface Tercero {
  id: string;
  rol: RolTercero;
  /** Nombre tal cual (para enseñarlo al usuario; nunca va a la IA). */
  nombre: string;
  /** Nombre normalizado sin forma jurídica, en palabras. */
  tokens: string[];
  nif?: string;
}

export interface CandidatoTercero {
  tercero: Tercero;
  puntuacion: number;
}

export type ResultadoTercero =
  | { tipo: 'unico'; tercero: Tercero; puntuacion: number; trozo: string }
  | { tipo: 'dudas'; candidatos: CandidatoTercero[]; trozo: string }
  | { tipo: 'ninguno'; trozo: string; parecidos: CandidatoTercero[] };

export const UMBRAL_USAR = 0.88;
export const MARGEN_USAR = 0.08;
export const UMBRAL_DUDA = 0.6;

const FORMAS_JURIDICAS = new Set(['sl', 'slu', 'sa', 'sau', 'scoop', 'coop', 'cb', 'sc', 'sll', 'slne', 'sal', 'slp', 'sad', 'sociedad', 'limitada', 'anonima']);

/** «Construcciones Pérez, S.L.» → ['construcciones', 'perez']. */
export function tokensNombre(nombre: string): string[] {
  const t = plano(nombre)
    .replace(/\b(s)\.\s?(l|a|c)\.(\s?(u|p)\.)?/g, (m) => m.replace(/[.\s]/g, ''))
    .replace(/\bs\.?\s?coop\.?/g, 'scoop')
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
  const tokens = t.split(' ').filter(Boolean);
  // Formas de dos letras sueltas: «s l», «s a», «c b».
  const limpios: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const par = tokens[i] + (tokens[i + 1] ?? '');
    if (tokens[i].length === 1 && FORMAS_JURIDICAS.has(par)) {
      i++;
      continue;
    }
    if (FORMAS_JURIDICAS.has(tokens[i])) continue;
    limpios.push(tokens[i]);
  }
  return limpios.length ? limpios : tokens;
}

/** «Banco Sabadell» → ['sabadell']: «banco» o «caja» no distinguen a un banco de otro. */
export function tokensBanco(nombre: string): string[] {
  const tokens = tokensNombre(nombre);
  const propios = tokens.filter((t) => !['banco', 'banc', 'caja', 'caixa', 'cuenta', 'de', 'del', 'la', 'el'].includes(t));
  return propios.length ? propios : tokens;
}

// ---------- Similitudes (puras) ----------

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const ventana = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const marcaA = new Array<boolean>(a.length).fill(false);
  const marcaB = new Array<boolean>(b.length).fill(false);
  let coinciden = 0;
  for (let i = 0; i < a.length; i++) {
    const ini = Math.max(0, i - ventana);
    const fin = Math.min(i + ventana + 1, b.length);
    for (let j = ini; j < fin; j++) {
      if (marcaB[j] || a[i] !== b[j]) continue;
      marcaA[i] = marcaB[j] = true;
      coinciden++;
      break;
    }
  }
  if (!coinciden) return 0;
  let transp = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!marcaA[i]) continue;
    while (!marcaB[k]) k++;
    if (a[i] !== b[k]) transp++;
    k++;
  }
  const jaro = (coinciden / a.length + coinciden / b.length + (coinciden - transp / 2) / coinciden) / 3;
  let prefijo = 0;
  while (prefijo < 4 && prefijo < a.length && prefijo < b.length && a[prefijo] === b[prefijo]) prefijo++;
  return jaro + prefijo * 0.1 * (1 - jaro);
}

function trigramas(s: string): Map<string, number> {
  const t = `  ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function diceTrigramas(a: string, b: string): number {
  const ta = trigramas(a);
  const tb = trigramas(b);
  let comunes = 0;
  let total = 0;
  for (const [g, n] of ta) {
    comunes += Math.min(n, tb.get(g) ?? 0);
    total += n;
  }
  for (const n of tb.values()) total += n;
  return total ? (2 * comunes) / total : 0;
}

/**
 * Extra por prefijos: cada palabra de la consulta (3 letras o más) es el
 * principio de una palabra del nombre, en orden. Si cubre todo el nombre vale
 * 1; si cubre parte, 0,6 + 0,4 × la parte cubierta.
 */
export function puntuacionPrefijos(consulta: string[], nombre: string[]): number {
  if (!consulta.length || consulta.some((p) => p.length < 3)) return 0;
  let j = 0;
  let cubiertas = 0;
  for (const p of consulta) {
    while (j < nombre.length && !nombre[j].startsWith(p)) j++;
    if (j >= nombre.length) return 0;
    cubiertas++;
    j++;
  }
  return cubiertas === nombre.length ? 1 : 0.6 + 0.4 * (cubiertas / nombre.length);
}

/**
 * Jaro-Winkler es generoso entre una palabra corta y un nombre largo («ruiz»
 * frente a «construcciones perez» da 0,63; «contratar», 0,76): si comparten pocos
 * trigramas (Dice < 0,3), cuenta
 * solo tres cuartas partes.
 */
export function puntuar(consulta: string[], nombre: string[]): number {
  const a = consulta.join(' ');
  const b = nombre.join(' ');
  const dice = diceTrigramas(a, b);
  const jw = jaroWinkler(a, b) * (dice >= 0.3 ? 1 : 0.75);
  return Math.max(jw, dice, puntuacionPrefijos(consulta, nombre));
}

// ---------- Trozos candidatos de la pregunta ----------

/**
 * Trozos de la pregunta que pueden ser un nombre: secuencias de palabras que no
 * son vacías ni del dominio («cuanto me debe construcciones perez» →
 * ['construcciones perez']).
 */
export function trozosCandidatos(textoBase: string): string[][] {
  const trozos: string[][] = [];
  let actual: string[] = [];
  for (const p of textoBase.split(' ')) {
    const util = p.length >= 2 && /[a-zñ]/.test(p) && !PALABRAS_VACIAS.has(p) && !esPalabraDelDominio(p);
    if (util) actual.push(p);
    else if (actual.length) {
      trozos.push(actual);
      actual = [];
    }
  }
  if (actual.length) trozos.push(actual);
  return trozos;
}

/** Busca el mejor tercero para la pregunta en un índice dado (puro). */
export function buscarEnIndice(textoBase: string, indice: Tercero[], roles?: RolTercero[]): ResultadoTercero | null {
  const candidatosIndice = roles ? indice.filter((t) => roles.includes(t.rol)) : indice;
  if (!candidatosIndice.length) return null;

  // NIF exacto.
  const nif = textoBase.match(RE_NIF)?.[1]?.toUpperCase();
  if (nif) {
    const porNif = candidatosIndice.filter((t) => t.nif === nif);
    if (porNif.length === 1) return { tipo: 'unico', tercero: porNif[0], puntuacion: 1, trozo: nif };
    if (porNif.length > 1) return { tipo: 'dudas', candidatos: porNif.map((tercero) => ({ tercero, puntuacion: 1 })), trozo: nif };
  }

  const trozos = trozosCandidatos(textoBase);
  if (!trozos.length) return null;

  let mejorTrozo = '';
  let puntuados: CandidatoTercero[] = [];
  let mejorPunt = -1;
  for (const trozo of trozos) {
    const porTercero = new Map<string, CandidatoTercero>();
    for (const tercero of candidatosIndice) {
      let max = 0;
      // Ventanas del trozo de hasta (palabras del nombre + 1).
      const tam = Math.min(trozo.length, tercero.tokens.length + 1);
      for (let n = 1; n <= tam; n++) {
        for (let i = 0; i + n <= trozo.length; i++) {
          const s = puntuar(trozo.slice(i, i + n), tercero.tokens);
          if (s > max) max = s;
        }
      }
      const clave = `${tercero.rol}:${tercero.id}`;
      const prev = porTercero.get(clave);
      if (!prev || prev.puntuacion < max) porTercero.set(clave, { tercero, puntuacion: max });
    }
    const lista = [...porTercero.values()].sort((x, y) => y.puntuacion - x.puntuacion);
    if (lista.length && lista[0].puntuacion > mejorPunt) {
      mejorPunt = lista[0].puntuacion;
      puntuados = lista;
      mejorTrozo = trozo.join(' ');
    }
  }
  if (!puntuados.length) return null;

  const [primero, segundo] = puntuados;
  const margen = primero.puntuacion - (segundo?.puntuacion ?? 0);
  if (primero.puntuacion >= UMBRAL_USAR && margen >= MARGEN_USAR) {
    return { tipo: 'unico', tercero: primero.tercero, puntuacion: primero.puntuacion, trozo: mejorTrozo };
  }
  if (primero.puntuacion >= UMBRAL_DUDA) {
    const candidatos = puntuados.filter((c) => c.puntuacion >= UMBRAL_DUDA && primero.puntuacion - c.puntuacion < 0.2).slice(0, 3);
    return { tipo: 'dudas', candidatos, trozo: mejorTrozo };
  }
  return { tipo: 'ninguno', trozo: mejorTrozo, parecidos: puntuados.slice(0, 3) };
}

// ---------- Índice por empresa (caché de 5 minutos) ----------

const CADUCIDAD_MS = 5 * 60_000;
const cache = new Map<string, { indice: Tercero[]; en: number }>();

async function cargarIndice(companyId: string): Promise<Tercero[]> {
  const [clientes, proveedores, bancos] = await Promise.all([
    prisma.customer.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true } }),
    prisma.supplier.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true } }),
    prisma.bankAccount.findMany({ where: { companyId, activa: true }, select: { id: true, bancoNombre: true, iban: true } }),
  ]);
  return [
    ...clientes.map((c) => ({ id: c.id, rol: 'cliente' as const, nombre: c.nombreFiscal, tokens: tokensNombre(c.nombreFiscal), nif: c.nifCif?.toUpperCase() })),
    ...proveedores.map((p) => ({ id: p.id, rol: 'proveedor' as const, nombre: p.nombreFiscal, tokens: tokensNombre(p.nombreFiscal), nif: p.nifCif?.toUpperCase() })),
    ...bancos
      .filter((b) => b.bancoNombre)
      .map((b) => ({ id: b.id, rol: 'banco' as const, nombre: `${b.bancoNombre} …${b.iban.replace(/\s/g, '').slice(-4)}`, tokens: tokensBanco(b.bancoNombre ?? '') })),
  ].filter((t) => t.tokens.length > 0);
}

export async function indiceTerceros(companyId: string, refrescar = false): Promise<Tercero[]> {
  const enCache = cache.get(companyId);
  if (!refrescar && enCache && Date.now() - enCache.en < CADUCIDAD_MS) return enCache.indice;
  const indice = await cargarIndice(companyId);
  if (cache.size > 500) cache.clear();
  cache.set(companyId, { indice, en: Date.now() });
  return indice;
}

/** Sin coincidencia, el índice se recarga como mucho una vez por minuto. */
const REFRESCO_MIN_MS = 60_000;

/** Busca un tercero en la pregunta; si no lo encuentra, refresca el índice (una vez por minuto como mucho). */
export async function buscarTercero(companyId: string, textoBase: string, roles?: RolTercero[]): Promise<ResultadoTercero | null> {
  if (!trozosCandidatos(textoBase).length && !RE_NIF.test(textoBase)) return null;
  const r = buscarEnIndice(textoBase, await indiceTerceros(companyId), roles);
  if (r && r.tipo !== 'ninguno') return r;
  const enCache = cache.get(companyId);
  if (enCache && Date.now() - enCache.en < REFRESCO_MIN_MS) return r;
  const refrescado = buscarEnIndice(textoBase, await indiceTerceros(companyId, true), roles);
  return refrescado ?? r;
}

/** Solo para tests. */
export function olvidarIndices(): void {
  cache.clear();
}
