import { useCallback, useState } from 'react';
import { ChatAssistantApi } from './chatAssistantApi';
import { ChatMessageVM } from './types';

const SESSION_KEY_PREFIX = 'carmen.sessionId.';

/** Estado y envio de mensajes del chat de Carmen, con sesion persistida por empresa. */
export function useCarmenChat(api: ChatAssistantApi, companyId: string, currentPage: string): {
  mensajes: ChatMessageVM[];
  sugerencias: string[];
  enviando: boolean;
  error: string | null;
  enviar: (texto: string) => Promise<void>;
} {
  const [sessionId, setSessionId] = useState<string | undefined>(
    () => localStorage.getItem(SESSION_KEY_PREFIX + companyId) ?? undefined,
  );
  const [mensajes, setMensajes] = useState<ChatMessageVM[]>([]);
  const [sugerencias, setSugerencias] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enviar = useCallback(
    async (texto: string) => {
      const contenido = texto.trim();
      if (!contenido || enviando) return;

      setError(null);
      setSugerencias([]);
      setMensajes((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: contenido }]);
      setEnviando(true);

      try {
        const res = await api.enviarMensaje(contenido, sessionId, currentPage);
        if (res.sessionId !== sessionId) {
          setSessionId(res.sessionId);
          localStorage.setItem(SESSION_KEY_PREFIX + companyId, res.sessionId);
        }
        setMensajes((prev) => [...prev, { id: `a-${Date.now()}`, role: 'assistant', content: res.response, sources: res.sources }]);
        setSugerencias(res.suggestions);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo contactar con Carmen.');
      } finally {
        setEnviando(false);
      }
    },
    [api, sessionId, currentPage, companyId, enviando],
  );

  return { mensajes, sugerencias, enviando, error, enviar };
}
