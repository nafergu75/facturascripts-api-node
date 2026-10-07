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
 * Antes se reserva el tope (presupuesto.service), después se liquida con
 * `usage` y, si la API falla, se devuelve la reserva. La respuesta pasa por el
 * validador de cifras: si trae una cifra sin respaldo, se descarta.
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
const TIMEOUT_MS = 15_000;
const TEMPERATURA = 0.2;

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
}

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
    cliente = new Anthropic({ apiKey: config.anthropicApiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
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
export function construirMensajes(p: Pick<PeticionIA, 'hoy' | 'pregunta' | 'fichas' | 'turnos'>): { system: string; messages: Anthropic.MessageParam[]; fichasUsadas: FichaFAQ[] } {
  const system = systemPrompt();
  let turnos = p.turnos.slice(-2);
  let fichas = p.fichas.slice(0, 3);
  const armar = () => {
    const historial: Anthropic.MessageParam[] = turnos.flatMap((t) => [
      { role: 'user' as const, content: t.pregunta },
      { role: 'assistant' as const, content: t.respuesta },
    ]);
    const referencia = fichas.length ? `Fichas de referencia:\n${fichas.map(textoFicha).join('\n\n')}\n\n` : 'No hay fichas de referencia para esta pregunta.\n\n';
    const ultimo: Anthropic.MessageParam = { role: 'user', content: `Hoy es ${fechaES(p.hoy)}.\n\n${referencia}Pregunta: ${p.pregunta}` };
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
  let respuesta: Anthropic.Message;
  try {
    respuesta = await clienteIA().messages.create({
      model: config.carmen.modelo,
      max_tokens: config.carmen.maxTokensSalida,
      temperature: TEMPERATURA,
      system,
      messages,
    });
  } catch (e) {
    await devolver(reserva);
    const motivo =
      e instanceof Anthropic.APIError
        ? `api_${e.status ?? 'sin_estado'}${e instanceof Anthropic.APIConnectionTimeoutError ? '_timeout' : ''}`
        : 'error_desconocido';
    logger.error(`carmen: la llamada a la IA ha fallado (${motivo})`);
    return { tipo: 'error', auditoria: { ...auditoriaBase(p, reserva.usd), estado: 'error', motivo, duracionMs: Date.now() - inicio } };
  }

  const uso = respuesta.usage as UsoTokens;
  const coste = costeUsd(config.carmen.modelo, uso);
  await liquidar(reserva, coste);
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

  const texto = respuesta.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!texto || respuesta.stop_reason === 'refusal') {
    return { tipo: 'descartada', auditoria: { ...auditoria, estado: 'descartada', motivo: texto ? 'rechazo' : 'sin_texto' } };
  }
  const validacion = validarCifras(texto, [`Hoy es ${fechaES(p.hoy)}.`, p.pregunta, ...fichasUsadas.map((f) => `${f.pregunta}\n${f.respuesta}`)]);
  if (!validacion.ok) {
    return { tipo: 'descartada', auditoria: { ...auditoria, estado: 'descartada', motivo: `cifras_sin_respaldo:${validacion.sinRespaldo.length}` } };
  }
  return { tipo: 'ok', texto, auditoria };
}
