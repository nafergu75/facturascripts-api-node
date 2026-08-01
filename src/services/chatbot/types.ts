export type DocumentType = 'ACCOUNTING' | 'API' | 'FRONTEND' | 'OTHER';

export interface DocumentChunk {
  id: string;
  content: string;
  source: string; // ej: "asientos_contables.md"
  section: string; // ej: "Concepto Básico"
  type: DocumentType; // clasificación temática del documento
  tags: string[]; // ["asientos", "ejemplo"]
  metadata: {
    difficulty: 'basico' | 'intermedio' | 'avanzado';
    relatedTopics: string[];
  };
  embedding: number[];
}

export interface IndexedData {
  chunks: DocumentChunk[];
  lastUpdated: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatSource {
  title: string;
  snippet: string;
  source: string;
}

export interface ChatOptions {
  userId: string;
  companyId: string;
  sessionId: string;
  currentPage?: string;
}

export interface ChatResult {
  response: string;
  sources: ChatSource[];
  suggestions: string[];
  sessionId: string;
}
