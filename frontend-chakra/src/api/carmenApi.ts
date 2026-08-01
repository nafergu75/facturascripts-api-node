/**
 * API Service - Carmen (asistente contable RAG)
 * Encapsula /companies/:companyId/chat-assistant/*
 *
 * El backend responde en envoltura { ok, data }; httpGet/httpPost ya extraen
 * `.data`, asi que estas funciones devuelven el payload directo.
 */

import { httpGet, httpPost } from '../utils/http';

const BASE_PATH = '/companies/:companyId/chat-assistant';

export interface ChatSource {
  title: string;
  snippet: string;
  source: string;
}

export interface ChatResult {
  response: string;
  sources: ChatSource[];
  suggestions: string[];
  sessionId: string;
}

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  sources?: ChatSource[] | null;
}

export function sendCarmenMessage(
  companyId: string,
  payload: { message: string; sessionId?: string; currentPage?: string },
): Promise<ChatResult> {
  const endpoint = BASE_PATH.replace(':companyId', companyId);
  return httpPost(endpoint, payload);
}

export function getCarmenHistory(
  companyId: string,
  sessionId: string,
): Promise<{ sessionId: string; messages: StoredChatMessage[] }> {
  const endpoint = BASE_PATH.replace(':companyId', companyId) + `/${sessionId}/messages`;
  return httpGet(endpoint);
}
