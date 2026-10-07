import axios from 'axios';
import { AsyncLocalStorage } from 'async_hooks';
import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
import {
  comprobarTipoManual,
  fechaObservacionEsperada,
  tipoCruzado,
  validarFormatoTipoCambio,
  type FuenteTipoCambio,
} from '../domain/divisas';

/**
 * Tipos de cambio de referencia del BCE (unidades de cada moneda por 1 EUR).
 *
 * Orden de busqueda para un devengo (fecha de la operacion o de emision):
 *  1. Fecha de observacion esperada D: ultimo dia habil TARGET <= devengo (si
 *     el devengo es hoy y en Madrid no son las 16:30, el dia habil anterior).
 *  2. Memoria del proceso (10 minutos) y cache en BD exacta (TipoCambioBce, D).
 *  3. API del BCE: ultima observacion con fecha <= D (nunca se pide una fecha
 *     exacta: en dias sin dato devuelve 200 vacio).
 *  4. Respaldo: Frankfurter con providers=ECB (el mismo dato del BCE).
 *  5. Solo para borradores y proformas: el ultimo de la cache de los 7 dias
 *     anteriores, marcado como provisional. Una factura que se emite NUNCA usa
 *     un tipo viejo: sin fuente, se pide el tipo a mano.
 *
 * Las llamadas llevan timeout de 4 s y no envian ningun dato del usuario (solo
 * la moneda y la fecha). No se llama nunca dentro de una transaccion de BD.
 */

const TIMEOUT_MS = 4000;
const MEMO_MS = 10 * 60 * 1000;
const MEMO_FALLO_MS = 60 * 1000;
const DIAS_CACHE_VIEJA = 7;

export const URL_BCE = 'https://data-api.ecb.europa.eu/service/data/EXR';
export const URL_FRANKFURTER = 'https://api.frankfurter.dev/v2/rates';

export interface ObservacionBce {
  moneda: string;
  /** Fecha REAL de la observacion (AAAA-MM-DD). */
  fecha: string;
  unidadesPorEur: number;
  origen: 'ECB_API' | 'FRANKFURTER_ECB' | 'CACHE';
  /** true: de la cache de dias anteriores (solo vale como orientativo). */
  vieja: boolean;
}

// ---------------------------------------------------------------------------
// Nunca dentro de una transaccion
// ---------------------------------------------------------------------------

const enTransaccion = new AsyncLocalStorage<boolean>();

/**
 * Ejecuta `fn` marcado como "dentro de una transaccion de BD": si algo intenta
 * consultar el tipo de cambio por la red ahi dentro, falla (una llamada lenta
 * dejaria la transaccion y sus bloqueos abiertos hasta 8 s). El tipo se
 * resuelve SIEMPRE antes de abrir la transaccion.
 */
export function marcarTransaccion<T>(fn: () => Promise<T>): Promise<T> {
  return enTransaccion.run(true, fn);
}

function exigirFueraDeTransaccion(): void {
  if (enTransaccion.getStore()) {
    throw new Error('El tipo de cambio no se consulta dentro de una transacción: resuélvelo antes.');
  }
}

// ---------------------------------------------------------------------------
// Fuentes
// ---------------------------------------------------------------------------

/** Separa una linea CSV respetando las comillas ("a, b" es un solo campo). */
function camposCsv(linea: string): string[] {
  const campos: string[] = [];
  let actual = '';
  let comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (comillas) {
      if (c === '"' && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else if (c === '"') comillas = false;
      else actual += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') {
      campos.push(actual);
      actual = '';
    } else actual += c;
  }
  campos.push(actual);
  return campos;
}

/**
 * Lee el CSV del BCE (format=csvdata) por cabecera: TIME_PERIOD y OBS_VALUE de
 * la primera fila. Cuerpo vacio o sin filas = sin dato.
 */
export function parsearCsvBce(texto: string): { fecha: string; valor: number } | null {
  const lineas = String(texto ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lineas.length < 2) return null;
  const cabecera = camposCsv(lineas[0]).map((c) => c.trim());
  const iFecha = cabecera.indexOf('TIME_PERIOD');
  const iValor = cabecera.indexOf('OBS_VALUE');
  if (iFecha < 0 || iValor < 0) return null;
  const fila = camposCsv(lineas[1]);
  const fecha = String(fila[iFecha] ?? '').trim();
  const valor = Number(String(fila[iValor] ?? '').trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(valor) || valor <= 0) return null;
  return { fecha, valor };
}

/** URL del BCE: ultima observacion con fecha <= fechaFin. */
export function urlBce(moneda: string, fechaFin: string): string {
  return `${URL_BCE}/D.${moneda}.EUR.SP00.A?endPeriod=${fechaFin}&lastNObservations=1&format=csvdata`;
}

/** URL de Frankfurter, siempre con providers=ECB (sin el da otro valor). */
export function urlFrankfurter(moneda: string, fecha: string): string {
  return `${URL_FRANKFURTER}?date=${fecha}&base=EUR&quotes=${moneda}&providers=ECB`;
}

async function consultarBce(moneda: string, fechaFin: string): Promise<{ fecha: string; valor: number } | null> {
  const r = await axios.get(urlBce(moneda, fechaFin), {
    timeout: TIMEOUT_MS,
    responseType: 'text',
    headers: { Accept: 'text/csv' },
  });
  const obs = parsearCsvBce(typeof r.data === 'string' ? r.data : String(r.data ?? ''));
  return obs && obs.fecha <= fechaFin ? obs : null;
}

async function consultarFrankfurter(moneda: string, fecha: string): Promise<{ fecha: string; valor: number } | null> {
  const r = await axios.get(urlFrankfurter(moneda, fecha), { timeout: TIMEOUT_MS, responseType: 'json' });
  const datos: unknown = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  const filas = Array.isArray(datos) ? datos : [];
  const fila = filas.find((x) => x && typeof x === 'object' && (x as { quote?: string }).quote === moneda) as
    | { date?: string; rate?: number }
    | undefined;
  const valor = Number(fila?.rate);
  const fechaReal = String(fila?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaReal) || fechaReal > fecha || !Number.isFinite(valor) || valor <= 0) return null;
  return { fecha: fechaReal, valor };
}

// ---------------------------------------------------------------------------
// Memoria del proceso y cache en BD
// ---------------------------------------------------------------------------

const memo = new Map<string, { hasta: number; obs: ObservacionBce | null }>();

/** Vacia la memoria del proceso (tests). */
export function limpiarMemoTiposCambio(): void {
  memo.clear();
}

function desdeMemo(clave: string): { obs: ObservacionBce | null } | undefined {
  const m = memo.get(clave);
  if (!m) return undefined;
  if (m.hasta < Date.now()) {
    memo.delete(clave);
    return undefined;
  }
  return { obs: m.obs };
}

function restarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

async function guardarEnCache(moneda: string, fecha: string, valor: number, origen: 'ECB_API' | 'FRANKFURTER_ECB'): Promise<void> {
  try {
    await prisma.tipoCambioBce.upsert({
      where: { moneda_fecha: { moneda, fecha } },
      update: {},
      create: { moneda, fecha, unidadesPorEur: valor, origen },
    });
  } catch (err) {
    // La cache no es imprescindible: el tipo ya se ha obtenido.
    console.error('tiposCambio: no se pudo guardar en la cache', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Unidades de `moneda` por 1 EUR para un devengo. null si no hay dato de ese
 * dia y, con `permitirVieja`, tampoco de los 7 dias anteriores.
 */
export async function obtenerUnidadesPorEur(
  moneda: string,
  devengo: string,
  { permitirVieja = false, ahora = new Date() }: { permitirVieja?: boolean; ahora?: Date } = {},
): Promise<ObservacionBce | null> {
  const d = fechaObservacionEsperada(devengo, ahora);
  if (moneda === 'EUR') return { moneda, fecha: d, unidadesPorEur: 1, origen: 'CACHE', vieja: false };

  const clave = `${moneda}|${d}`;
  const enMemo = desdeMemo(clave);
  let obs: ObservacionBce | null | undefined = enMemo?.obs;

  if (enMemo === undefined) {
    const exacta = await prisma.tipoCambioBce.findUnique({ where: { moneda_fecha: { moneda, fecha: d } } });
    if (exacta) {
      obs = { moneda, fecha: exacta.fecha, unidadesPorEur: Number(exacta.unidadesPorEur), origen: 'CACHE', vieja: false };
    } else {
      exigirFueraDeTransaccion();
      obs = null;
      for (const [consulta, origen] of [
        [consultarBce, 'ECB_API'],
        [consultarFrankfurter, 'FRANKFURTER_ECB'],
      ] as const) {
        try {
          const r = await consulta(moneda, d);
          if (r) {
            await guardarEnCache(moneda, r.fecha, r.valor, origen);
            obs = { moneda, fecha: r.fecha, unidadesPorEur: r.valor, origen, vieja: false };
            break;
          }
        } catch (err) {
          console.error(`tiposCambio: ${origen} no responde`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    memo.set(clave, { hasta: Date.now() + (obs ? MEMO_MS : MEMO_FALLO_MS), obs });
  }

  if (obs) return obs;
  if (!permitirVieja) return null;
  const vieja = await prisma.tipoCambioBce.findFirst({
    where: { moneda, fecha: { lte: d, gte: restarDias(d, DIAS_CACHE_VIEJA) } },
    orderBy: { fecha: 'desc' },
  });
  return vieja ? { moneda, fecha: vieja.fecha, unidadesPorEur: Number(vieja.unidadesPorEur), origen: 'CACHE', vieja: true } : null;
}

/**
 * Tipo de referencia "unidades de `moneda` por 1 de `monedaCuenta`". Con moneda
 * de cuenta EUR es el del BCE tal cual; si no, el cruzado con las dos
 * observaciones del MISMO dia.
 */
export async function tipoReferencia(
  monedaCuenta: string,
  moneda: string,
  devengo: string,
  opciones: { permitirVieja?: boolean; ahora?: Date } = {},
): Promise<{ tipoCambio: number; fecha: string; vieja: boolean } | null> {
  if (monedaCuenta === 'EUR') {
    const r = await obtenerUnidadesPorEur(moneda, devengo, opciones);
    return r ? { tipoCambio: r.unidadesPorEur, fecha: r.fecha, vieja: r.vieja } : null;
  }
  // Cruzado: primero la que no es EUR del documento (o la de cuenta si el documento va en EUR).
  const base = await obtenerUnidadesPorEur(moneda === 'EUR' ? monedaCuenta : moneda, devengo, opciones);
  if (!base) return null;
  const rDoc = moneda === 'EUR' ? 1 : base.unidadesPorEur;
  let rCuenta = base.unidadesPorEur;
  if (moneda !== 'EUR') {
    // La de cuenta del mismo dia que la del documento.
    const otra = await obtenerUnidadesPorEur(monedaCuenta, base.fecha, { ...opciones, permitirVieja: false });
    if (!otra || otra.fecha !== base.fecha) return null;
    rCuenta = otra.unidadesPorEur;
  }
  return { tipoCambio: tipoCruzado(rDoc, rCuenta), fecha: base.fecha, vieja: base.vieja };
}

/**
 * Referencia para comprobar un tipo indicado a mano (o el que sale de lo
 * recibido en el banco) en una fecha: el del BCE de ese dia (o de los 7
 * anteriores); si no se puede obtener, el ultimo guardado en la cache, como
 * referencia APROXIMADA. null si no hay ninguno (entonces el dominio usa un
 * tipo orientativo fijo): nunca se deja de comprobar un tipo manual.
 */
export async function referenciaParaComprobar(
  monedaCuenta: string,
  moneda: string,
  fecha: string,
  ahora?: Date,
): Promise<{ tipoCambio: number; aproximado: boolean } | null> {
  const ref = await tipoReferencia(monedaCuenta, moneda, fecha, { permitirVieja: true, ahora }).catch(() => null);
  if (ref) return { tipoCambio: ref.tipoCambio, aproximado: false };
  try {
    const hasta = fechaObservacionEsperada(fecha, ahora);
    const ultimo = async (m: string): Promise<number | null> => {
      if (m === 'EUR') return 1;
      const fila = await prisma.tipoCambioBce.findFirst({ where: { moneda: m, fecha: { lte: hasta, gte: '1999-01-01' } }, orderBy: { fecha: 'desc' } });
      return fila ? Number(fila.unidadesPorEur) : null;
    };
    const [doc, cuenta] = [await ultimo(moneda), await ultimo(monedaCuenta)];
    if (doc && cuenta) return { tipoCambio: tipoCruzado(doc, cuenta), aproximado: true };
  } catch {
    // Sin cache: se comprueba con el orientativo.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolver el tipo de una factura
// ---------------------------------------------------------------------------

export interface TipoResuelto {
  /** null solo con fuente PENDIENTE. */
  tipoCambio: number | null;
  fechaTipoCambio: string | null;
  fuente: FuenteTipoCambio;
  /** true: orientativo (cache de dias anteriores); se fija al emitir. */
  provisional: boolean;
  aviso?: string;
}

const ddmmaaaa = (f: string): string => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

export function mensajeSinTipo(moneda: string, devengo: string): string {
  return `No se ha podido obtener el tipo del BCE para ${moneda} a ${ddmmaaaa(devengo)}: indícalo a mano.`;
}

/**
 * Decide el tipo de cambio de una factura (fuera de cualquier transaccion):
 *  - misma moneda que la de cuenta: PAR (1); un tipo manual distinto de 1 -> 400;
 *  - con tipo manual: MANUAL, comprobado contra el BCE del devengo si se conoce
 *    (invertido o fuera de [BCE/2, BCE×2] -> 400; desviado > 0,5 % -> aviso);
 *  - si no, BCE del devengo. Al emitir (`definitivo`) nunca vale uno viejo: si
 *    no hay, fuente PENDIENTE y tipo null (quien llama da el 400 con
 *    `mensajeSinTipo`). En borradores y proformas vale el de los 7 dias
 *    anteriores, como provisional.
 */
export async function resolverTipoCambio(opc: {
  monedaCuenta: string;
  moneda: string;
  devengo: string;
  manual?: unknown;
  definitivo: boolean;
  ahora?: Date;
}): Promise<TipoResuelto> {
  const { monedaCuenta, moneda, devengo, definitivo, ahora } = opc;
  const hayManual = opc.manual !== undefined && opc.manual !== null && opc.manual !== '';

  if (moneda === monedaCuenta) {
    if (hayManual && validarFormatoTipoCambio(opc.manual) !== 1) {
      throw badRequest(`La factura está en ${moneda}, la moneda de la contabilidad: el tipo de cambio es 1.`);
    }
    return { tipoCambio: 1, fechaTipoCambio: null, fuente: 'PAR', provisional: false };
  }

  if (hayManual) {
    const manual = validarFormatoTipoCambio(opc.manual);
    // Sin el BCE de esa fecha se compara con el ultimo guardado o con uno orientativo: un tipo invertido o absurdo no pasa.
    const ref = await referenciaParaComprobar(monedaCuenta, moneda, devengo, ahora);
    const { aviso } = comprobarTipoManual(manual, ref?.tipoCambio ?? null, monedaCuenta, moneda, { aproximado: ref?.aproximado });
    return { tipoCambio: manual, fechaTipoCambio: devengo, fuente: 'MANUAL', provisional: false, ...(aviso ? { aviso } : {}) };
  }

  const ref = await tipoReferencia(monedaCuenta, moneda, devengo, { permitirVieja: !definitivo, ahora });
  if (!ref) {
    return { tipoCambio: null, fechaTipoCambio: null, fuente: 'PENDIENTE', provisional: true, aviso: mensajeSinTipo(moneda, devengo) };
  }
  return {
    tipoCambio: ref.tipoCambio,
    fechaTipoCambio: ref.fecha,
    fuente: 'BCE',
    provisional: ref.vieja,
    ...(ref.vieja
      ? { aviso: `Tipo orientativo del BCE del ${ddmmaaaa(ref.fecha)} (no se ha podido consultar el del día): se fija al emitir.` }
      : {}),
  };
}
