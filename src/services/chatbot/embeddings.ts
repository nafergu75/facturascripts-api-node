/**
 * Pseudo-embeddings: aproximación sin coste para Fase A.
 *
 * No son embeddings semánticos reales (la API de Claude no expone un endpoint
 * de embeddings). Se usan como mecanismo de desempate entre chunks ya
 * filtrados por tags/keywords (ver RAGRetriever). Cuando se integre un
 * proveedor de embeddings real, sustituir esta función manteniendo la firma.
 */
export function generatePseudoEmbedding(text: string): number[] {
  const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

  const embedding: number[] = [];
  for (let i = 0; i < 1536; i++) {
    embedding.push(Math.sin(hash + i) * 0.5 + 0.5);
  }
  return embedding;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
