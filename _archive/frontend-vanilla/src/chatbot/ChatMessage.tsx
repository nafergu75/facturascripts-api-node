import React from 'react';
import { ChatMessageVM } from './types';
import { ChatSources } from './ChatSources';

/** Burbuja de mensaje (usuario a la derecha, Carmen a la izquierda). */
export function ChatMessage({ mensaje }: { mensaje: ChatMessageVM }): React.ReactElement {
  const esUsuario = mensaje.role === 'user';

  return (
    <div style={{ display: 'flex', justifyContent: esUsuario ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
      <div
        style={{
          maxWidth: '85%',
          background: esUsuario ? '#1a56b0' : '#eef1f5',
          color: esUsuario ? '#fff' : '#222',
          borderRadius: 10,
          padding: '8px 12px',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {mensaje.content}
        {!esUsuario && mensaje.sources && <ChatSources sources={mensaje.sources} />}
      </div>
    </div>
  );
}
