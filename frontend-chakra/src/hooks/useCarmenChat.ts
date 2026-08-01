/**
 * Estado de una conversacion con Carmen.
 *
 * Mantiene los mensajes en memoria del componente (la persistencia real vive en
 * el backend, ligada al sessionId). currentPage se toma de la ruta activa para
 * que Carmen ajuste el contexto (asientos/reportes/impuestos).
 */

import { useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCompanyId } from './useCompanyId';
import { sendCarmenMessage, ChatSource } from '../api/carmenApi';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  suggestions?: string[];
}

function newSessionId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface UseCarmenChat {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sessionId: string;
  sendMessage: (text: string) => Promise<void>;
  clearHistory: () => void;
}

export function useCarmenChat(): UseCarmenChat {
  const companyId = useCompanyId();
  const { pathname } = useLocation();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || loading) return;

      const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: message };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      setError(null);

      try {
        const res = await sendCarmenMessage(companyId, { message, sessionId, currentPage: pathname });
        setSessionId(res.sessionId);
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            content: res.response,
            sources: res.sources,
            suggestions: res.suggestions,
          },
        ]);
      } catch (e) {
        setError((e as { message?: string })?.message || 'No se pudo contactar con Carmen.');
      } finally {
        setLoading(false);
      }
    },
    [companyId, sessionId, pathname, loading],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
    setSessionId(newSessionId());
  }, []);

  return { messages, loading, error, sessionId, sendMessage, clearHistory };
}
