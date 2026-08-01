/** Tipos del chat de Carmen (espejo de src/services/chatbot/types.ts del backend). */

export interface ChatSource {
  title: string;
  snippet: string;
  source: string;
}

export interface ChatMessageVM {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
}

export interface ChatResponse {
  response: string;
  sources: ChatSource[];
  suggestions: string[];
  sessionId: string;
}
