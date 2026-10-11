/**
 * Cliente REST de Azure Document Intelligence (prebuilt-invoice, api-version
 * 2024-11-30), con fetch nativo y sin SDK.
 *
 * Flujo asincrono documentado por Microsoft:
 *  1. POST :analyze con el archivo en base64 -> 202 + Operation-Location + Retry-After.
 *  2. GET analyzeResults/{resultId} -> notStarted | running | succeeded | failed...
 *  3. DELETE analyzeResults/{resultId} -> 204 (si no, Azure lo borra a las 24 h).
 *
 * Seguridad y privacidad:
 *  - Del Operation-Location solo se toma el resultId. Las URL se construyen
 *    siempre con el endpoint configurado: la clave nunca viaja a un host que
 *    venga en una cabecera.
 *  - Al log solo van el estado HTTP y los codigos de error. Nunca la clave, la
 *    URL con parametros, el contenido ni el texto de los mensajes de Azure.
 *  - Se decide por el estado HTTP, no por el texto: el cuerpo de los 401, 403 y
 *    429 es de la pasarela y no esta en el contrato de Document Intelligence.
 *  - Ninguna llamada sigue redirecciones (redirect: 'error'): fetch reenviaria
 *    la cabecera con la clave, y en un 307/308 tambien el documento, al host
 *    que diga Location.
 */
import { logger } from '../../config/logger';
import type { ConfigAzure } from '../../config/azure';
import type { CodigoFallo } from './tipos';

export const API_VERSION = '2024-11-30';
const MODELO = 'prebuilt-invoice';
/** El POST solo sube el archivo (5,4 MB en base64 como mucho) y Azure responde 202 sin analizar. */
export const TIEMPO_POST_MS = 10_000;
export const TIEMPO_GET_MS = 15_000;
/** Cortocircuito tras un 401 o un 403: una hora sin llamar a Azure en esta instancia. */
export const PAUSA_TRAS_RECHAZO_MS = 60 * 60 * 1000;

export interface FalloAzure {
  tipo: 'fallo';
  codigo: CodigoFallo;
  reintentable: boolean;
  /** Estado HTTP, si lo hubo (solo para el log y los tests). */
  http?: number;
}

export type ResultadoAnalizar = { tipo: 'aceptado'; resultId: string; retryAfterS: number } | FalloAzure;

export type ResultadoConsulta =
  | { tipo: 'pendiente'; retryAfterS: number | null }
  | { tipo: 'hecho'; analyzeResult: AnalyzeResult }
  | FalloAzure;

/** Lo minimo del AnalyzeResult que se usa (forma oficial 2024-11-30). */
export interface AnalyzeResult {
  apiVersion?: string;
  modelId?: string;
  content?: string;
  pages?: Array<{ pageNumber: number; barcodes?: Array<{ kind: string; value: string; confidence?: number }> }>;
  documents?: Array<{ docType?: string; confidence?: number; fields?: Record<string, DocumentField> }>;
}

export interface DocumentField {
  type?: string;
  valueString?: string;
  valueDate?: string;
  valueNumber?: number;
  valueInteger?: number;
  valueCurrency?: { amount?: number; currencyCode?: string; currencySymbol?: string };
  valueAddress?: Record<string, string | undefined>;
  valueArray?: DocumentField[];
  valueObject?: Record<string, DocumentField>;
  content?: string;
  confidence?: number;
  boundingRegions?: Array<{ pageNumber: number }>;
}

// ---------------------------------------------------------------------------
// Cortocircuito (memoria de la instancia; en serverless se pierde y no importa)
// ---------------------------------------------------------------------------

let azurePausadoHasta = 0;
let motivoPausa: CodigoFallo | null = null;

/** Motivo del cortocircuito si esta activo; null si se puede llamar a Azure. */
export function azurePausado(ahora = Date.now()): CodigoFallo | null {
  return ahora < azurePausadoHasta ? motivoPausa : null;
}

export function pausarAzure(motivo: CodigoFallo, ms = PAUSA_TRAS_RECHAZO_MS, ahora = Date.now()): void {
  azurePausadoHasta = ahora + ms;
  motivoPausa = motivo;
}

/** Solo para los tests. */
export function _reiniciarPausa(): void {
  azurePausadoHasta = 0;
  motivoPausa = null;
}

// ---------------------------------------------------------------------------
// URL y cabeceras
// ---------------------------------------------------------------------------

export function urlAnalizar(endpoint: string, opciones: { locale?: string } = {}): string {
  const locale = opciones.locale ? `&locale=${encodeURIComponent(opciones.locale)}` : '';
  return `${endpoint}/documentintelligence/documentModels/${MODELO}:analyze?_overload=analyzeDocument&api-version=${API_VERSION}&features=barcodes${locale}`;
}

export function urlResultado(endpoint: string, resultId: string): string {
  return `${endpoint}/documentintelligence/documentModels/${MODELO}/analyzeResults/${resultId}?api-version=${API_VERSION}`;
}

/** Solo el resultId (UUID) del Operation-Location; el host de la cabecera no se usa nunca. */
export function extraerResultId(operationLocation: string | null | undefined): string | null {
  const m = /\/analyzeResults\/([0-9a-fA-F-]{36})(?:\?|$)/.exec(operationLocation ?? '');
  return m ? m[1] : null;
}

/** Retry-After en segundos, acotado entre 1 y 10. Si falta o no es un numero, 2. */
export function leerRetryAfter(valor: string | null | undefined): number {
  const n = Number.parseInt(String(valor ?? '').trim(), 10);
  if (!Number.isFinite(n)) return 2;
  return Math.min(10, Math.max(1, n));
}

const cabeceras = (cfg: ConfigAzure, json = false): Record<string, string> => ({
  'Ocp-Apim-Subscription-Key': cfg.clave,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
});

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

const CODIGOS_ARCHIVO = new Set(['InvalidContent', 'UnsupportedContent', 'InvalidContentDimensions', 'InvalidContentLength', 'InvalidContentSourceFormat']);

interface CuerpoError {
  error?: { code?: string; innererror?: { code?: string }; details?: Array<{ code?: string }> };
}

async function leerCuerpoError(r: Response): Promise<CuerpoError> {
  try {
    return (await r.json()) as CuerpoError;
  } catch {
    return {};
  }
}

/** Codigos de Azure para el log: nunca el texto del mensaje. */
function codigosParaLog(c: CuerpoError): Record<string, unknown> {
  return {
    code: c.error?.code ?? null,
    inner: c.error?.innererror?.code ?? null,
    details: (c.error?.details ?? []).map((d) => d.code).filter(Boolean),
  };
}

/** Clasifica una respuesta de error por su estado HTTP (tabla de la seccion 4.5). */
export function clasificarError(http: number, cuerpo: CuerpoError): { codigo: CodigoFallo; reintentable: boolean } {
  if (http === 400) {
    const codigos = [cuerpo.error?.code, cuerpo.error?.innererror?.code].filter(Boolean) as string[];
    if (codigos.some((c) => CODIGOS_ARCHIVO.has(c))) return { codigo: 'AZURE_ARCHIVO', reintentable: false };
    return { codigo: 'AZURE_PETICION', reintentable: false };
  }
  if (http === 401) return { codigo: 'AZURE_CLAVE', reintentable: false };
  if (http === 403) return { codigo: 'AZURE_CUOTA', reintentable: false };
  if (http === 404) return { codigo: 'AZURE_RESULTADO_PERDIDO', reintentable: false };
  if (http === 429) return { codigo: 'AZURE_OCUPADO', reintentable: true };
  if (http >= 500) return { codigo: 'AZURE_SERVICIO', reintentable: true };
  return { codigo: 'AZURE_RESPUESTA_RARA', reintentable: false };
}

async function falloDeRespuesta(r: Response, fase: 'POST' | 'GET'): Promise<FalloAzure> {
  const cuerpo = await leerCuerpoError(r);
  const { codigo, reintentable } = clasificarError(r.status, cuerpo);
  if (codigo === 'AZURE_CLAVE' || codigo === 'AZURE_CUOTA') pausarAzure(codigo);
  const meta = { fase, http: r.status, ...codigosParaLog(cuerpo) };
  if (codigo === 'AZURE_PETICION' || codigo === 'AZURE_CLAVE') logger.error(`[ocr-azure] Azure rechaza la peticion (${codigo})`, meta);
  else logger.warn(`[ocr-azure] Azure responde con error (${codigo})`, meta);
  return { tipo: 'fallo', codigo, reintentable, http: r.status };
}

function esTiempoAgotado(err: unknown): boolean {
  const nombre = (err as { name?: string })?.name;
  return nombre === 'AbortError' || nombre === 'TimeoutError';
}

/** fetch con redirect: 'error' rechaza con TypeError('fetch failed') y la causa 'unexpected redirect'. */
function esRedireccion(err: unknown): boolean {
  return (err as { cause?: { message?: string } })?.cause?.message === 'unexpected redirect';
}

function falloDeExcepcion(err: unknown, fase: 'POST' | 'GET' | 'DELETE'): FalloAzure {
  if (esRedireccion(err)) {
    logger.error('[ocr-azure] Azure responde con una redireccion: no se sigue', { fase });
    return { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false };
  }
  if (esTiempoAgotado(err)) {
    logger.warn('[ocr-azure] Azure no responde a tiempo', { fase });
    return { tipo: 'fallo', codigo: 'AZURE_TIEMPO', reintentable: true };
  }
  // Fallo de red: igual que un 503. No se registra el mensaje (puede llevar la URL).
  logger.warn('[ocr-azure] No se ha podido conectar con Azure', { fase, error: (err as { name?: string })?.name ?? 'Error' });
  return { tipo: 'fallo', codigo: 'AZURE_SERVICIO', reintentable: true };
}

// ---------------------------------------------------------------------------
// Llamadas
// ---------------------------------------------------------------------------

export interface OpcionesAnalizar {
  /** 'es-ES' solo en empresas espanolas. */
  locale?: string;
  /** Espera entre reintentos (inyectable en los tests). */
  esperar?: (ms: number) => Promise<void>;
}

const esperarDeVerdad = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST :analyze. Solo se reintenta (una vez) cuando Azure dice que NO ha
 * aceptado el documento: un 429 tras Retry-After (3 s como mucho) o un 5xx a
 * los 2 s. Un tiempo agotado o un fallo de red no se reintentan: el primer
 * POST pudo llegar y se pagarian dos analisis. Lo demas vuelve como fallo.
 */
export async function analizar(cfg: ConfigAzure, archivo: Buffer, opciones: OpcionesAnalizar = {}): Promise<ResultadoAnalizar> {
  const esperar = opciones.esperar ?? esperarDeVerdad;
  const cuerpo = JSON.stringify({ base64Source: archivo.toString('base64') });
  const url = urlAnalizar(cfg.endpoint, { locale: opciones.locale });

  for (let intento = 1; ; intento++) {
    let fallo: FalloAzure;
    let esperaMs = 2000;
    try {
      const r = await fetch(url, { method: 'POST', headers: cabeceras(cfg, true), body: cuerpo, redirect: 'error', signal: AbortSignal.timeout(TIEMPO_POST_MS) });
      if (r.status === 202) {
        const resultId = extraerResultId(r.headers.get('operation-location'));
        if (!resultId) {
          logger.error('[ocr-azure] El 202 de Azure no trae un Operation-Location valido', { fase: 'POST' });
          return { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false, http: 202 };
        }
        return { tipo: 'aceptado', resultId, retryAfterS: leerRetryAfter(r.headers.get('retry-after')) };
      }
      fallo = r.ok ? { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false, http: r.status } : await falloDeRespuesta(r, 'POST');
      if (r.status === 429) esperaMs = Math.min(leerRetryAfter(r.headers.get('retry-after')), 3) * 1000;
    } catch (err) {
      return { ...falloDeExcepcion(err, 'POST'), reintentable: false };
    }
    if (!fallo.reintentable || intento >= 2) return fallo;
    await esperar(esperaMs);
  }
}

/** GET analyzeResults/{resultId}: UNA consulta, sin esperar dentro. */
export async function consultarResultado(cfg: ConfigAzure, resultId: string): Promise<ResultadoConsulta> {
  let r: Response;
  try {
    r = await fetch(urlResultado(cfg.endpoint, resultId), { method: 'GET', headers: cabeceras(cfg), redirect: 'error', signal: AbortSignal.timeout(TIEMPO_GET_MS) });
  } catch (err) {
    return falloDeExcepcion(err, 'GET');
  }
  if (!r.ok) return falloDeRespuesta(r, 'GET');

  let op: { status?: string; error?: CuerpoError['error']; analyzeResult?: AnalyzeResult };
  try {
    op = (await r.json()) as typeof op;
  } catch {
    logger.error('[ocr-azure] La consulta de Azure no devuelve un JSON', { fase: 'GET', http: r.status });
    return { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false, http: r.status };
  }
  const retry = r.headers.get('retry-after');
  switch (op.status) {
    case 'notStarted':
    case 'running':
      return { tipo: 'pendiente', retryAfterS: retry ? leerRetryAfter(retry) : null };
    case 'succeeded':
      if (!op.analyzeResult) return { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false, http: r.status };
      return { tipo: 'hecho', analyzeResult: op.analyzeResult };
    case 'failed':
    case 'canceled':
    case 'skipped':
      logger.warn('[ocr-azure] El analisis de Azure ha fallado', { fase: 'GET', status: op.status, ...codigosParaLog({ error: op.error }) });
      return { tipo: 'fallo', codigo: 'AZURE_ANALISIS', reintentable: false, http: r.status };
    default:
      logger.error('[ocr-azure] Estado desconocido en la consulta de Azure', { fase: 'GET', status: String(op.status ?? '') });
      return { tipo: 'fallo', codigo: 'AZURE_RESPUESTA_RARA', reintentable: false, http: r.status };
  }
}

/** DELETE analyzeResults/{resultId}. Nunca lanza: un fallo solo deja un aviso con el codigo. */
export async function borrarResultado(cfg: ConfigAzure, resultId: string): Promise<void> {
  try {
    const r = await fetch(urlResultado(cfg.endpoint, resultId), { method: 'DELETE', headers: cabeceras(cfg), redirect: 'error', signal: AbortSignal.timeout(TIEMPO_GET_MS) });
    if (r.status !== 204 && !r.ok) logger.warn('[ocr-azure] No se ha podido borrar el resultado en Azure', { fase: 'DELETE', http: r.status });
  } catch (err) {
    logger.warn('[ocr-azure] No se ha podido borrar el resultado en Azure', { fase: 'DELETE', error: (err as { name?: string })?.name ?? 'Error' });
  }
}
