import React from 'react';
import { ChatSource } from './types';

/** Lista de documentos de la base de conocimiento usados para una respuesta. */
export function ChatSources({ sources }: { sources: ChatSource[] }): React.ReactElement | null {
  if (sources.length === 0) return null;

  return (
    <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid rgba(0,0,0,0.08)', fontSize: 11, color: '#667' }}>
      <strong>Fuentes:</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
        {sources.map((s, i) => (
          <li key={i} title={s.snippet}>
            {s.title} <span style={{ color: '#99a' }}>({s.source})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
