import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useApp } from '../app/AppLayout';
import { ErrorBanner } from '../app/ui';
import { ChatAssistantApi } from './chatAssistantApi';
import { useCarmenChat } from './useCarmenChat';
import { ChatMessage } from './ChatMessage';
import { ChatSuggestions } from './ChatSuggestions';

/** Boton flotante + panel de chat con Carmen, disponible en toda la app. */
export function ChatAssistant(): React.ReactElement {
  const { api, sesion } = useApp();
  const location = useLocation();
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const listaRef = useRef<HTMLDivElement>(null);

  const chatApi = useMemo(
    () => new ChatAssistantApi(api.baseUrl, sesion.companyId, sesion.token),
    [api.baseUrl, sesion.companyId, sesion.token],
  );
  const { mensajes, sugerencias, enviando, error, enviar } = useCarmenChat(chatApi, sesion.companyId, location.pathname);

  useEffect(() => {
    if (!abierto) return;
    listaRef.current?.scrollTo({ top: listaRef.current.scrollHeight, behavior: 'smooth' });
  }, [mensajes, enviando, abierto]);

  const handleEnviar = (): void => {
    if (!texto.trim()) return;
    void enviar(texto);
    setTexto('');
  };

  return (
    <>
      <button
        onClick={() => setAbierto((v) => !v)}
        title="Carmen, tu asistente contable"
        style={{
          position: 'fixed',
          bottom: 20,
          right: 20,
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: '#1a56b0',
          color: '#fff',
          border: 'none',
          fontSize: 22,
          cursor: 'pointer',
          boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          zIndex: 1000,
        }}
      >
        {abierto ? '✕' : '💬'}
      </button>

      {abierto && (
        <div
          style={{
            position: 'fixed',
            bottom: 86,
            right: 20,
            width: 360,
            maxHeight: '70vh',
            height: 480,
            background: '#fff',
            borderRadius: 12,
            boxShadow: '0 8px 30px rgba(0,0,0,0.25)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            zIndex: 1000,
          }}
        >
          <div style={{ background: '#1a56b0', color: '#fff', padding: '10px 14px', fontSize: 14, fontWeight: 600 }}>
            Carmen · Asistente contable
          </div>

          <div ref={listaRef} style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {mensajes.length === 0 && (
              <p style={{ fontSize: 13, color: '#667' }}>
                Hola, soy Carmen 👋 Pregúntame sobre asientos, IVA, IRPF o cualquier duda de la app.
              </p>
            )}
            {mensajes.map((m) => (
              <ChatMessage key={m.id} mensaje={m} />
            ))}
            {enviando && <p style={{ fontSize: 12, color: '#889' }}>Carmen está escribiendo…</p>}
          </div>

          {error && (
            <div style={{ padding: '0 12px' }}>
              <ErrorBanner mensaje={error} />
            </div>
          )}

          <div style={{ padding: 12, borderTop: '1px solid #eef1f5' }}>
            <ChatSuggestions sugerencias={sugerencias} onSelect={(s) => void enviar(s)} />
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleEnviar();
                }}
                placeholder="Escribe tu pregunta..."
                style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid #ccd', fontSize: 13 }}
              />
              <button
                onClick={handleEnviar}
                disabled={enviando || !texto.trim()}
                style={{
                  padding: '8px 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: '#1a56b0',
                  color: '#fff',
                  cursor: enviando || !texto.trim() ? 'default' : 'pointer',
                  opacity: enviando || !texto.trim() ? 0.6 : 1,
                }}
              >
                Enviar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
