import React from 'react';

/** Chips de preguntas sugeridas tras la respuesta de Carmen. */
export function ChatSuggestions({
  sugerencias,
  onSelect,
}: {
  sugerencias: string[];
  onSelect: (sugerencia: string) => void;
}): React.ReactElement | null {
  if (sugerencias.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
      {sugerencias.map((s, i) => (
        <button
          key={i}
          onClick={() => onSelect(s)}
          style={{
            fontSize: 12,
            padding: '4px 10px',
            borderRadius: 14,
            border: '1px solid #cdd9ea',
            background: '#f5f8ff',
            color: '#1a56b0',
            cursor: 'pointer',
          }}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
