/**
 * Capa 3 de Carmen: la IA (Claude Haiku 4.5) como último recurso.
 *
 * Una sola llamada, sin herramientas y sin thinking, con max_tokens 500,
 * temperature 0,2, 15 s de timeout y 1 reintento. Lo que se envía:
 *  - el system prompt fijo (llm-prompt.ts);
 *  - las 3 fichas FAQ más cercanas;
 *  - como mucho 2 turnos anteriores con origen 'faq' o 'ia' (nunca de datos);
 *  - la pregunta depurada (sin NIF, IBAN, correos, teléfonos ni nombres de
 *    terceros) y la fecha de hoy.
 * Nada de resultados de servicios ni respuestas de datos del historial.
 *
 * Antes se reserva el tope (presupuesto.service) y después se liquida con
 * `usage`. Si la API contesta con un error (4xx/5xx), no lo cobra: se devuelve
 * la reserva, y ante una sobrecarga (429, 5xx, 529) se reintenta una vez con la
 * misma reserva. Si la llamada se corta o se agota el tiempo, Anthropic puede
 * haberla procesado y cobrado: la reserva se queda como gasto (el peor caso),
 * la pregunta cuenta en los topes del día y no se reintenta. El SDK no
 * reintenta por su cuenta (maxRetries 0), así que ningún intento queda sin
 * contar. La respuesta pasa por el validador de cifras: si trae una cifra sin
 * respaldo, se descarta; si se cortó en los 500 tokens, se deja hasta la
 * última frase completa con un aviso.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/env';
import { logger } from '../../config/logger';
import { costeUsd, MAX_TOKENS_ENTRADA, type UsoTokens } from './precios';
import { devolver, liquidar, reservar, type MotivoSinIA, type Reserva } from './presupuesto.service';
import { systemPrompt } from './llm-prompt';
import { validarCifras } from './validarCifras';
import { fechaES } from './plantillas';
import type { FichaFAQ } from './faq/faq.data';

export const ETIQUETA_IA = 'Respuesta orientativa generada por IA. No ha visto los datos de tu empresa.';
export const AVISO_RECORTADA = 'La respuesta se ha acortado. Para más detalle, consúltalo con tu asesor.';
const TIMEOUT_MS = 15_000;
const TEMPERATURA = 0.2;
/** Errores HTTP de sobrecarga que se reintentan una vez (Anthropic no los cobra). */
const REINTENTABLES = new Set([429, 500, 502, 503, 504, 529]);
const ESPERA_REINTENTO_MS = 800;

/** Turno anterior que puede ir a la IA (solo de fichas o de la propia IA). */
export interface TurnoPrevio {
  pregunta: string;
  respuesta: string;
}

export interface PeticionIA {
  companyId: string;
  userId: string;
  hoy: string;
  topeEmpresa: number;
  /** Pregunta YA depurada. */
  pregunta: string;
  fichas: FichaFAQ[];
  turnos: TurnoPrevio[];
  /** false: empresa no establecida en España (sin IVA español, modelos de la AEAT ni nóminas). Por defecto, true. */
  empresaEspanola?: boolean;
}

/** Aviso para la IA cuando la empresa no está establecida en España (va en el mensaje, no en el system fijo). */
export const NOTA_EMPRESA_EXTRANJERA =
  'La empresa del usuario no está establecida en España: no lleva IVA español, no presenta modelos de la AEAT y no tiene nóminas en la aplicación. No le hables de esas obligaciones como suyas; si pregunta por ellas, díselo y que lo consulte con su asesor.\n\n';

export interface AuditoriaIA {
  companyId: string;
  userId: string;
  modelo: string;
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheEscritura: number;
  tokensCacheLectura: number;
  reservaUsd: number;
  costeUsd: number;
  estado: 'ok' | 'error' | 'descartada' | 'sin_tope';
  motivo?: string;
  duracionMs?: number;
}

export type ResultadoIA =
  | { tipo: 'ok'; texto: string; auditoria: AuditoriaIA }
  | { tipo: 'descartada'; auditoria: AuditoriaIA }
  | { tipo: 'error'; auditoria: AuditoriaIA }
  | { tipo: 'sin_tope'; motivo: MotivoSinIA; auditoria: AuditoriaIA };

/** Cliente de la API. Se crea al primer uso; los tests lo sustituyen con fijarClienteIA. */
type ClienteIA = Pick<Anthropic, 'messages'>;
let cliente: ClienteIA | null = null;

function clienteIA(): ClienteIA {
  if (!cliente) {
    // Sin reintentos del SDK: el reintento lo hace preguntarIA, solo cuando la API no ha cobrado.
    cliente = new Anthropic({ apiKey: config.anthropicApiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  return cliente;
}

/** Solo para tests: sustituye el cliente de Anthropic por uno simulado. */
export function fijarClienteIA(c: ClienteIA | null): void {
  cliente = c;
}

/** Estimación prudente de tokens (unos 3 caracteres por token en castellano). */
export function estimarTokens(texto: string): number {
  return Math.ceil(texto.length / 3);
}

function textoFicha(f: FichaFAQ, i: number): string {
  return `[Ficha ${i + 1}] ${f.pregunta}\n${f.respuesta}\nFuente: ${f.fuente.titulo}, verificada el ${fechaES(f.verificadaEl)}.`;
}

/** Arma los mensajes recortando hasta caber en MAX_TOKENS_ENTRADA: fuera turnos, luego fichas. */
export function construirMensajes(p: Pick<PeticionIA, 'hoy' | 'pregunta' | 'fichas' | 'turnos' | 'empresaEspanola'>): { system: string; messages: Anthropic.MessageParam[]; fichasUsadas: FichaFAQ[] } {
  const system = systemPrompt();
  let turnos = p.turnos.slice(-2);
  let fichas = p.fichas.slice(0, 3);
  const armar = () => {
    const historial: Anthropic.MessageParam[] = turnos.flatMap((t) => [
      { role: 'user' as const, content: t.pregunta },
      { role: 'assistant' as const, content: t.respuesta },
    ]);
    const referencia = fichas.length ? `Fichas de referencia:\n${fichas.map(textoFicha).join('\n\n')}\n\n` : 'No hay fichas de referencia para esta pregunta.\n\n';
    const nota = p.empresaEspanola === false ? NOTA_EMPRESA_EXTRANJERA : '';
    const ultimo: Anthropic.MessageParam = { role: 'user', content: `Hoy es ${fechaES(p.hoy)}.\n\n${nota}${referencia}Pregunta: ${p.pregunta}` };
    return [...historial, ultimo];
  };
  const tamano = (msgs: Anthropic.MessageParam[]) => estimarTokens(system) + msgs.reduce((s, m) => s + estimarTokens(String(m.content)), 0);
  let messages = armar();
  while (tamano(messages) > MAX_TOKENS_ENTRADA && (turnos.length || fichas.length)) {
    if (turnos.length) turnos = turnos.slice(1);
    else fichas = fichas.slice(0, -1);
    messages = armar();
  }
  return { system, messages, fichasUsadas: fichas };
}

function auditoriaBase(p: PeticionIA, reserva: number): AuditoriaIA {
  return {
    companyId: p.companyId,
    userId: p.userId,
    modelo: config.carmen.modelo,
    tokensEntrada: 0,
    tokensSalida: 0,
    tokensCacheEscritura: 0,
    tokensCacheLectura: 0,
    reservaUsd: reserva,
    costeUsd: 0,
    estado: 'error',
  };
}

/** Pregunta a la IA con todas las barreras: tope, una llamada, liquidación y validador de cifras. */
export async function preguntarIA(p: PeticionIA): Promise<ResultadoIA> {
  const r = await reservar(p.companyId, p.userId, p.hoy, p.topeEmpresa);
  if (!r.ok) {
    return { tipo: 'sin_tope', motivo: r.motivo, auditoria: { ...auditoriaBase(p, 0), estado: 'sin_tope', motivo: r.motivo } };
  }
  const reserva: Reserva = r.reserva;
  const { system, messages, fichasUsadas } = construirMensajes(p);
  const inicio = Date.now();
  const llamar = () =>
    clienteIA().messages.create({
      model: config.carmen.modelo,
      max_tokens: config.carmen.maxTokensSalida,
      temperature: TEMPERATURA,
      system,
      messages,
    });
  let respuesta: Anthropic.Message;
  try {
    try {
      respuesta = await llamar();
    } catch (e) {
      // Sobrecarga con respuesta de la API: no se ha cobrado; un reintento con la misma reserva.
      if (!(e instanceof Anthropic.APIError) || e.status === undefined || !REINTENTABLES.has(e.status)) throw e;
      await new Promise((res) => setTimeout(res, ESPERA_REINTENTO_MS));
      respuesta = await llamar();
    }
  } catch (e) {
    const conRespuesta = e instanceof Anthropic.APIError && e.status !== undefined;
    let motivo: string;
    if (conRespuesta) {
      // La API ha contestado con un error: no lo cobra, se devuelve la reserva.
      motivo = `api_${(e as InstanceType<typeof Anthropic.APIError>).status}`;
      await devolver(reserva);
    } else {
      // Tiempo agotado o conexión cortada: puede haberse procesado y cobrado. La
      // reserva se queda como gasto y la pregunta cuenta en los topes del día.
      motivo = e instanceof Anthropic.APIConnectionTimeoutError ? 'tiempo_agotado' : e instanceof Anthropic.APIConnectionError ? 'conexion' : 'error_desconocido';
    }
    logger.error(`carmen: la llamada a la IA ha fallado (${motivo})`);
    return {
      tipo: 'error',
      auditoria: { ...auditoriaBase(p, reserva.usd), estado: 'error', motivo, costeUsd: conRespuesta ? 0 : reserva.usd, duracionMs: Date.now() - inicio },
    };
  }

  const uso = respuesta.usage as UsoTokens;
  const coste = costeUsd(config.carmen.modelo, uso);
  try {
    await liquidar(reserva, coste);
  } catch {
    // La respuesta ya está pagada: se entrega igual. La reserva (el peor caso) se queda como gasto.
    logger.error('carmen: no se ha podido liquidar el coste de la IA; se queda la reserva');
  }
  const auditoria: AuditoriaIA = {
    ...auditoriaBase(p, reserva.usd),
    tokensEntrada: uso.input_tokens,
    tokensSalida: uso.output_tokens,
    tokensCacheEscritura: uso.cache_creation_input_tokens ?? 0,
    tokensCacheLectura: uso.cache_read_input_tokens ?? 0,
    costeUsd: coste,
    estado: 'ok',
    duracionMs: Date.now() - inicio,
  };

  let texto = respuesta.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!texto || respuesta.stop_reason === 'refusal') {
    return { tipo: 'descartada', auditoria: { ...auditoria, estado: 'descartada', motivo: texto ? 'rechazo' : 'sin_texto' } };
  }
  let recortada = false;
  if (respuesta.stop_reason === 'max_tokens') {
    // Cortada en los 500 tokens: hasta la última frase completa y con aviso; si no queda nada útil, se descarta.
    const completa = hastaUltimaFrase(texto);
    if (!completa) return { tipo: 'descartada', auditoria: { ...auditoria, estado: 'descartada', motivo: 'truncada' } };
    texto = completa;
    recortada = true;
  }
  const validacion = validarCifras(texto, [p.pregunta, ...fichasUsadas.map((f) => `${f.pregunta}\n${f.respuesta}`)], { fechas: [p.hoy] });
  if (!validacion.ok) {
    return { tipo: 'descartada', auditoria: { ...auditoria, estado: 'descartada', motivo: `cifras_sin_respaldo:${validacion.sinRespaldo.length}` } };
  }
  return { tipo: 'ok', texto: recortada ? `${texto}\n\n${AVISO_RECORTADA}` : texto, auditoria: recortada ? { ...auditoria, motivo: 'recortada' } : auditoria };
}

/** Texto hasta la última frase completa (acabada en «.», «!», «?» o «…»), o null si queda muy poco. */
export function hastaUltimaFrase(texto: string): string | null {
  const m = texto.match(/^[\s\S]*[.!?…](?=\s|$)/);
  const r = m?.[0].trim() ?? '';
  return r.length >= 40 ? r : null;
}
