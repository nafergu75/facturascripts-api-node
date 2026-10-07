/**
 * Estado de una conversacion con Carmen.
 *
 * Mantiene los mensajes en memoria del componente (la persistencia real vive en
 * el backend). El id de la conversacion lo crea el servidor: la primera
 * pregunta va sin sessionId y las siguientes con el que devolvio la respuesta.
 * Antes el hook inventaba un id ('web-...') y el servidor, que solo acepta
 * conversaciones propias, respondia 404 a todo.
 *
 * currentPage se toma de la ruta activa para que Carmen sugiera consultas de
 * esa pantalla.
 */

import { useCallback, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useCompanyId } from './useCompanyId';
import { sendCarmenMessage, AccionCarmen, BotonCarmen, RespuestaCarmen } from '../api/carmenApi';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  origen?: RespuestaCarmen['origen'];
  entendido?: string;
  avisos?: string[];
  botones?: BotonCarmen[];
  fuente?: RespuestaCarmen['fuente'];
  etiquetaIA?: string;
}

export interface UseCarmenChat {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sessionId: string | undefined;
  sendMessage: (text: string) => Promise<void>;
  sendBoton: (boton: BotonCarmen) => Promise<void>;
  clearHistory: () => void;
}

function mensajeDeError(e: unknown): string {
  const err = e as { statusCode?: number; message?: string };
  if (err?.statusCode === 0) return 'No se puede conectar con el servidor.';
  if (err?.statusCode === 403) return 'No tienes acceso a Carmen en esta empresa.';
  if (err?.statusCode && err.statusCode >= 500) return 'Carmen no ha podido responder ahora mismo. Inténtalo de nuevo.';
  return err?.message || 'No se pudo contactar con Carmen.';
}

export function useCarmenChat(): UseCarmenChat {
  const companyId = useCompanyId();
  const { pathname } = useLocation();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const enCurso = useRef(false);

  const enviar = useCallback(
    async (visible: string, cuerpo: { message?: string; accion?: AccionCarmen }) => {
      if (enCurso.current) return;
      enCurso.current = true;
      setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: 'user', content: visible }]);
      setLoading(true);
      setError(null);

      const peticion = (sid: string | undefined) =>
        sendCarmenMessage(companyId, { ...cuerpo, ...(sid ? { sessionId: sid } : {}), currentPage: pathname.slice(0, 200) });
      try {
        let res: RespuestaCarmen;
        try {
          res = await peticion(sessionId);
        } catch (e) {
          // La conversacion ya no existe (borrada o caducada): se empieza otra.
          if (sessionId && (e as { statusCode?: number })?.statusCode === 404) res = await peticion(undefined);
          else throw e;
        }
        setSessionId(res.sessionId);
        setMessages((prev) => [
          ...prev,
          {
            id: res.mensajeId,
            role: 'assistant',
            content: res.texto,
            origen: res.origen,
            entendido: res.entendido,
            avisos: res.avisos,
            botones: res.botones,
            fuente: res.fuente,
            etiquetaIA: res.etiquetaIA,
          },
        ]);
      } catch (e) {
        setError(mensajeDeError(e));
      } finally {
        enCurso.current = false;
        setLoading(false);
      }
    },
    [companyId, sessionId, pathname],
  );

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim().slice(0, 500);
      if (!message) return;
      await enviar(message, { message });
    },
    [enviar],
  );

  const sendBoton = useCallback(
    async (boton: BotonCarmen) => {
      // «Preguntar a la IA» necesita la pregunta: la ultima que escribio el usuario.
      const ultima = [...messages].reverse().find((m) => m.role === 'user')?.content;
      await enviar(boton.texto, boton.accion.tipo === 'ia' ? { accion: boton.accion, message: ultima } : { accion: boton.accion });
    },
    [enviar, messages],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
    setSessionId(undefined);
  }, []);

  return { messages, loading, error, sessionId, sendMessage, sendBoton, clearHistory };
}
