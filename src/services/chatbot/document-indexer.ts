import fs from 'fs';
import path from 'path';
import { logger } from '../../config/logger';
import { generatePseudoEmbedding } from './embeddings';
import { DocumentChunk, DocumentType, IndexedData } from './types';

/**
 * Resuelve el directorio de la base de conocimiento de forma robusta en los dos
 * entornos: en local `__dirname` apunta a src/dist; en Vercel serverless el
 * bundle se ejecuta desde la raiz del proyecto (process.cwd()), y los .md viajan
 * gracias a `includeFiles` en vercel.json. Probamos cwd primero y caemos al
 * relativo a __dirname.
 */
function resolveKnowledgeBaseDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'docs/chatbot/knowledge-base'),
    path.resolve(__dirname, '../../../docs/chatbot/knowledge-base'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

export const KNOWLEDGE_BASE_DIR = resolveKnowledgeBaseDir();
export const INDEX_PATH = path.resolve(__dirname, '../../../data/embeddings/index.json');

const MAX_CHUNK_LENGTH = 1500;

/**
 * Carga los documentos Markdown de la base de conocimiento de Carmen, los
 * divide en chunks por encabezado y construye el indice usado por RAGRetriever.
 */
export class DocumentIndexer {
  /** Carga todos los .md de una carpeta (recursivo). */
  loadDocuments(folderPath: string): Map<string, string> {
    const docs = new Map<string, string>();

    const walkDir = (dir: string): void => {
      if (!fs.existsSync(dir)) return;

      for (const file of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (file.endsWith('.md')) {
          docs.set(file, fs.readFileSync(fullPath, 'utf-8'));
        }
      }
    };

    walkDir(folderPath);
    return docs;
  }

  /** Divide los documentos en chunks por seccion (encabezados ##/###). */
  chunkDocuments(docs: Map<string, string>): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    let chunkId = 0;

    docs.forEach((content, filename) => {
      const sections = content.split(/^##+ /m);

      for (const section of sections) {
        const lines = section.split('\n');
        const sectionTitle = (lines[0] || 'Sin título').trim();

        let currentChunk = '';
        for (const line of lines) {
          if ((currentChunk + line).length > MAX_CHUNK_LENGTH && currentChunk.trim().length > 0) {
            chunks.push(this.buildChunk(chunkId++, currentChunk, filename, sectionTitle));
            currentChunk = `${line}\n`;
          } else {
            currentChunk += `${line}\n`;
          }
        }

        if (currentChunk.trim()) {
          chunks.push(this.buildChunk(chunkId++, currentChunk, filename, sectionTitle));
        }
      }
    });

    return chunks;
  }

  /** Genera (pseudo) embeddings para cada chunk. */
  generateEmbeddings(chunks: DocumentChunk[]): DocumentChunk[] {
    for (const chunk of chunks) {
      chunk.embedding = generatePseudoEmbedding(`${chunk.section}\n${chunk.content}`);
    }
    return chunks;
  }

  /** Guarda el indice en data/embeddings/index.json. */
  storeIndex(chunks: DocumentChunk[]): void {
    const data: IndexedData = {
      chunks,
      lastUpdated: new Date().toISOString(),
    };

    const dir = path.dirname(INDEX_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2));
  }

  /**
   * Construye el indice EN MEMORIA desde los .md, sin escribir a disco. Es la
   * ruta usada por el RAGRetriever en serverless (Vercel), donde no existe el
   * index.json precomputado (esta gitignored) y el disco es de solo lectura.
   */
  buildIndex(docsFolder: string = KNOWLEDGE_BASE_DIR): IndexedData {
    const docs = this.loadDocuments(docsFolder);
    let chunks = this.chunkDocuments(docs);
    chunks = this.generateEmbeddings(chunks);
    return { chunks, lastUpdated: new Date().toISOString() };
  }

  /** Orquesta la reconstruccion completa del indice y lo persiste a disco. */
  rebuildIndex(docsFolder: string = KNOWLEDGE_BASE_DIR): IndexedData {
    const data = this.buildIndex(docsFolder);
    logger.info(`carmen: ${data.chunks.length} chunks construidos desde ${docsFolder}`);

    this.storeIndex(data.chunks);
    logger.info(`carmen: indice guardado en ${INDEX_PATH}`);

    return data;
  }

  private buildChunk(id: number, rawContent: string, filename: string, sectionTitle: string): DocumentChunk {
    const content = rawContent.trim();
    return {
      id: `chunk-${id}`,
      content,
      source: filename,
      section: sectionTitle,
      type: this.classifyType(filename, content),
      tags: this.extractTags(filename, sectionTitle),
      metadata: {
        difficulty: this.estimateDifficulty(content),
        relatedTopics: this.extractRelatedTopics(content),
      },
      embedding: [],
    };
  }

  /**
   * Clasifica el documento en una categoria tematica para permitir filtrado
   * (RAGRetriever.filterType). Por defecto, la base de conocimiento contable
   * cae en ACCOUNTING; documentos sobre endpoints/REST o el front se etiquetan
   * aparte si se añaden en el futuro.
   */
  private classifyType(filename: string, content: string): DocumentType {
    const f = filename.toLowerCase();
    const c = content.toLowerCase();

    if (f.includes('api') || f.includes('endpoint') || c.includes('get /') || c.includes('post /')) return 'API';
    if (f.includes('frontend') || f.includes('ui') || f.includes('pantalla') || c.includes('componente react')) return 'FRONTEND';
    if (
      f.includes('asiento') || f.includes('iva') || f.includes('irpf') || f.includes('factura') ||
      f.includes('balance') || f.includes('contab') || f.includes('cuenta') || f.includes('modelo')
    ) {
      return 'ACCOUNTING';
    }
    return 'OTHER';
  }

  private extractTags(filename: string, section: string): string[] {
    const tags: string[] = [];
    const lowerFile = filename.toLowerCase();
    const lowerSection = section.toLowerCase();

    if (lowerFile.includes('asiento')) tags.push('asientos');
    if (lowerFile.includes('iva')) tags.push('iva');
    if (lowerFile.includes('irpf')) tags.push('irpf');
    if (lowerFile.includes('factura')) tags.push('facturas');
    if (lowerFile.includes('balance')) tags.push('balance');

    if (lowerSection.includes('ejemplo')) tags.push('ejemplo');
    if (lowerSection.includes('paso')) tags.push('pasos');

    return [...new Set(tags)];
  }

  private estimateDifficulty(content: string): 'basico' | 'intermedio' | 'avanzado' {
    if (content.length < 300) return 'basico';
    if (content.includes('PGC') || content.includes('fórmula')) return 'intermedio';
    return 'avanzado';
  }

  private extractRelatedTopics(content: string): string[] {
    const topics: string[] = [];
    if (content.includes('IVA')) topics.push('IVA');
    if (content.includes('IRPF')) topics.push('IRPF');
    if (content.includes('asiento') || content.includes('Asiento')) topics.push('Asientos');
    if (content.includes('factura') || content.includes('Factura')) topics.push('Facturas');
    return topics;
  }
}
