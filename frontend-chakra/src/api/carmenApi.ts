/**
 * API Service - Carmen (asistente contable)
 * Encapsula /companies/:companyId/chat-assistant/*
 *
 * Contrato de Carmen v1 (RespuestaCarmen en src/services/carmen/tipos.ts). Este
 * front es antiguo: solo pinta el texto, la fuente, los avisos y los botones.
 * La ventana completa (tablas, cifras, historial) está en frontend/web.
 *
 * El id de la conversación lo crea el servidor: la primera pregunta va sin
 * sessionId y las siguientes con el que devuelve la respuesta.
 *
 * El backend responde en envoltura { ok, data }; httpGet/httpPost ya extraen
 * `.data`, asi que estas funciones devuelven el payload directo.
 */

import { httpGet, httpPost } from '../utils/http';

const BASE_PATH = '/companies/:companyId/chat-assistant';

export type OrigenCarmen = 'datos' | 'faq' | 'ia' | 'aclaracion' | 'sistema';

/** Lo que manda un botón (se reenvía tal cual, sin tocarlo). */
export type AccionCarmen = { tipo: string; [k: string]: unknown };

export interface BotonCarmen {
  texto: string;
  accion: AccionCarmen;
}

export interface RespuestaCarmen {
  sessionId: string;
  mensajeId: string;
  origen: OrigenCarmen;
  entendido?: string;
  texto: string;
  avisos?: string[];
  botones?: BotonCarmen[];
  fuente?: { titulo: string; url: string; verificadaEl: string };
  etiquetaIA?: string;
}

export function sendCarmenMessage(
  companyId: string,
  payload: { message?: string; accion?: AccionCarmen; sessionId?: string; currentPage?: string },
): Promise<RespuestaCarmen> {
  const endpoint = BASE_PATH.replace(':companyId', companyId);
  return httpPost(endpoint, payload);
}

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  origen: OrigenCarmen | null;
  createdAt: string;
  oculto: boolean;
}

export function getCarmenHistory(
  companyId: string,
  sessionId: string,
): Promise<{ sessionId: string; titulo: string | null; mensajes: StoredChatMessage[] }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + `/${encodeURIComponent(sessionId)}/messages`;
  return httpGet(endpoint);
}
