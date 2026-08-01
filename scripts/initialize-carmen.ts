/**
 * Construye el indice RAG de Carmen a partir de docs/chatbot/knowledge-base.
 *
 * Ejecucion:  ts-node scripts/initialize-carmen.ts  (o npm run carmen:index)
 */
import { DocumentIndexer } from '../src/services/chatbot/document-indexer';

function main(): void {
  const indexer = new DocumentIndexer();
  const { chunks, lastUpdated } = indexer.rebuildIndex();

  console.log(`Carmen: indice generado con ${chunks.length} chunks (actualizado: ${lastUpdated})`);
}

main();
