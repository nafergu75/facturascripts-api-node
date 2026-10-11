/**
 * Ayudas de los tests del lector con Azure: carga los fixtures (forma oficial
 * de la API 2024-11-30) y los convierte en Response como las de fetch.
 *
 * Los fixtures 401, 403 y 429 llevan "_nota": su cuerpo es de la pasarela de
 * Azure AI services y no esta en el contrato de Document Intelligence. El
 * codigo decide por el estado HTTP, nunca por ese texto.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export function fixtureAzure<T = Record<string, unknown>>(nombre: string): T {
  return JSON.parse(readFileSync(join(__dirname, `${nombre}.json`), 'utf-8')) as T;
}

export function fixtureClaude<T = Record<string, unknown>>(nombre: string): T {
  return JSON.parse(readFileSync(join(__dirname, '..', 'claude', `${nombre}.json`), 'utf-8')) as T;
}

/** Respuesta JSON con estado y cabeceras. */
export function respuesta(cuerpo: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const sinCuerpo = status === 202 || status === 204 || cuerpo === null;
  return new Response(sinCuerpo ? null : JSON.stringify(cuerpo), { status, headers: { ...(sinCuerpo ? {} : { 'Content-Type': 'application/json' }), ...headers } });
}

/** El 202 del POST :analyze, con las cabeceras del fixture. */
export function aceptado(nombre = 'analizar-202'): Response {
  const f = fixtureAzure<{ headers: Record<string, string> }>(nombre);
  return respuesta(null, 202, f.headers);
}

/** Un error con su estado (y la cabecera Retry-After si el fixture la trae). */
export function error(nombre: string, status: number): Response {
  const f = fixtureAzure<{ headers?: Record<string, string> }>(nombre);
  const { headers, ...cuerpo } = f;
  return respuesta(cuerpo, status, headers ?? {});
}

/** El resultado (GET analyzeResults) de un fixture. */
export function resultado(nombre: string): Response {
  return respuesta(fixtureAzure(nombre), 200);
}

export const RESULT_ID = '3b31320d-8bab-4f88-b19c-2322a7f11034';
export const ENDPOINT = 'https://prueba.cognitiveservices.azure.com';
export const CLAVE = 'clave-secreta-de-prueba-0123456789abcdef';
/** NIF del emisor de los fixtures (CIF valido) y de la empresa receptora. */
export const NIF_EMISOR = 'B12345674';
export const NIF_EMPRESA = 'B87654323';
