/**
 * Precios de la API de Anthropic en dólares por millón de tokens, para liquidar
 * el coste real de cada respuesta con `response.usage`.
 *
 * El tope se compara en euros contando 1 $ = 1 €: sobreestima el gasto y nunca
 * deja pasarse. Un modelo que no esté en la tabla se cobra al precio más caro
 * conocido, para que cambiar CARMEN_MODELO sin tocar esto no deje pasar gasto.
 */
export interface PreciosModelo {
  entrada: number;
  salida: number;
  cacheEscritura5m: number;
  cacheEscritura1h: number;
  cacheLectura: number;
}

const HAIKU_45: PreciosModelo = { entrada: 1, salida: 5, cacheEscritura5m: 1.25, cacheEscritura1h: 2, cacheLectura: 0.1 };

export const PRECIOS: Record<string, PreciosModelo> = {
  'claude-haiku-4-5-20251001': HAIKU_45,
  'claude-haiku-4-5': HAIKU_45,
};

/** Precio de reserva para modelos desconocidos (el de los modelos más caros). */
const PRECIO_DESCONOCIDO: PreciosModelo = { entrada: 15, salida: 75, cacheEscritura5m: 18.75, cacheEscritura1h: 30, cacheLectura: 1.5 };

export function preciosDe(modelo: string): PreciosModelo {
  return PRECIOS[modelo] ?? PRECIO_DESCONOCIDO;
}

/** Tokens de entrada como máximo que se envían a la IA (se recorta en el backend). */
export const MAX_TOKENS_ENTRADA = 3500;

/** Peor caso de una llamada: toda la entrada permitida y toda la salida. */
export function reservaUsd(modelo: string, maxTokensSalida: number): number {
  const p = preciosDe(modelo);
  return redondear((MAX_TOKENS_ENTRADA * p.entrada + maxTokensSalida * p.salida) / 1e6);
}

/** Lo que devuelve la API en `usage` (solo los campos que cuestan). */
export interface UsoTokens {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}

/** Coste real en dólares de una respuesta. */
export function costeUsd(modelo: string, uso: UsoTokens): number {
  const p = preciosDe(modelo);
  const escritura = uso.cache_creation_input_tokens ?? 0;
  const w1h = uso.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = uso.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, escritura - w1h);
  const lectura = uso.cache_read_input_tokens ?? 0;
  return redondear(
    (uso.input_tokens * p.entrada + uso.output_tokens * p.salida + w5m * p.cacheEscritura5m + w1h * p.cacheEscritura1h + lectura * p.cacheLectura) / 1e6,
  );
}

/** Seis decimales, como la columna costeUsd. */
export function redondear(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}
