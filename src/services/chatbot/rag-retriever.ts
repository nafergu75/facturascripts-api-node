import fs from 'fs';
import { logger } from '../../config/logger';
import { cosineSimilarity, generatePseudoEmbedding } from './embeddings';
import { DocumentIndexer, INDEX_PATH } from './document-indexer';
import { DocumentChunk, DocumentType, IndexedData } from './types';

export interface RetrieveFilters {
  tags?: string[];
  difficulty?: 'basico' | 'intermedio' | 'avanzado';
  source?: string;
  type?: DocumentType;
}

/**
 * Recupera los chunks de la base de conocimiento de Carmen mas relevantes
 * para una pregunta del usuario. El indice se carga una vez y se reutiliza
 * (relee si el fichero cambia, util tras `npm run carmen:index`).
 */
export class RAGRetriever {
  private index: IndexedData | null = null;
  private indexMtimeMs = 0;

  retrieve(query: string, topK = 5, filters?: RetrieveFilters): DocumentChunk[] {
    this.ensureIndexLoaded();

    if (!this.index || this.index.chunks.length === 0) {
      return [];
    }

    const queryEmbedding = generatePseudoEmbedding(query);

    const scored = this.index.chunks
      .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
      .sort((a, b) => b.score - a.score);

    let filtered = scored;

    if (filters?.tags && filters.tags.length > 0) {
      filtered = scored.filter((item) => filters.tags!.some((tag) => item.chunk.tags.includes(tag)));
      // Si los tags no casan con ningun chunk, no dejamos a Carmen sin contexto:
      // caemos de vuelta a los mejor puntuados sin filtrar.
      if (filtered.length === 0) {
        filtered = scored;
      }
    }

    if (filters?.difficulty) {
      filtered = filtered.filter((item) => item.chunk.metadata.difficulty === filters.difficulty);
    }

    if (filters?.source) {
      filtered = filtered.filter((item) => item.chunk.source === filters.source);
    }

    if (filters?.type) {
      filtered = filtered.filter((item) => item.chunk.type === filters.type);
    }

    return filtered.slice(0, topK).map((item) => item.chunk);
  }

  private ensureIndexLoaded(): void {
    // 1) Indice precomputado en disco (cache local tras `npm run carmen:index`).
    //    Se reutiliza y se relee solo si cambia el mtime.
    try {
      const stat = fs.statSync(INDEX_PATH);
      if (this.index && stat.mtimeMs === this.indexMtimeMs) return;

      const data = fs.readFileSync(INDEX_PATH, 'utf-8');
      this.index = JSON.parse(data) as IndexedData;
      this.indexMtimeMs = stat.mtimeMs;
      logger.info(`carmen: indice cargado de disco (${this.index.chunks.length} chunks)`);
      return;
    } catch {
      // Sin index.json: caso esperado en Vercel (esta gitignored y no se despliega).
      // Continuamos a la reconstruccion en memoria.
    }

    // 2) Reconstruccion en memoria desde los .md (fuente de verdad). Funciona en
    //    serverless si la KB viaja en el bundle (vercel.json -> includeFiles).
    //    Se hace una sola vez por instancia (cold start).
    if (this.index && this.index.chunks.length > 0) return;

    try {
      this.index = new DocumentIndexer().buildIndex();
      logger.info(`carmen: indice reconstruido en memoria (${this.index.chunks.length} chunks)`);
    } catch {
      logger.warn('carmen: no se pudo cargar ni reconstruir el indice. RAG sin contexto.');
      this.index = { chunks: [], lastUpdated: new Date().toISOString() };
    }
  }
}
