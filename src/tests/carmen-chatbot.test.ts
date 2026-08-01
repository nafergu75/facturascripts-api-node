import fs from 'fs';

// --- Modo degradado determinista: sin clave de Anthropic y sin red ---
// Mockeamos la config de entorno con la forma COMPLETA de AppConfig para que
// cualquier importador (engine, logger) reciba un objeto valido. La clave esta
// en `anthropicApiKey: undefined` -> el engine construye client=null y cae al
// fallback local, sin llamar a la API de Claude.
jest.mock('../config/env', () => ({
  config: {
    port: 3000,
    nodeEnv: 'test',
    isProd: false,
    isTest: true,
    databaseUrl: 'mysql://test',
    encryptionKey: '0'.repeat(64),
    jwtSecret: 'test',
    fsApiUrl: undefined,
    fsApiKey: undefined,
    anthropicApiKey: undefined,
    corsOrigins: [],
  },
}));

// --- Prisma mockeado: verificamos persistencia logica, no integracion real ---
const prismaMock = {
  chatSession: { upsert: jest.fn().mockResolvedValue({}) },
  chatMessage: {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  },
};
jest.mock('../config/database', () => ({ prisma: prismaMock }));

import { generatePseudoEmbedding, cosineSimilarity } from '../services/chatbot/embeddings';
import { DocumentIndexer } from '../services/chatbot/document-indexer';
import { RAGRetriever } from '../services/chatbot/rag-retriever';
import { AssistantEngine } from '../services/chatbot/assistant-engine';
import { DocumentChunk, IndexedData } from '../services/chatbot/types';

// Helper minimo: construye un chunk de prueba con su (pseudo) embedding real.
function chunk(partial: Partial<DocumentChunk> & Pick<DocumentChunk, 'id' | 'content' | 'source' | 'tags'>): DocumentChunk {
  return {
    section: partial.section ?? 'Seccion',
    type: partial.type ?? 'ACCOUNTING',
    metadata: partial.metadata ?? { difficulty: 'basico', relatedTopics: [] },
    embedding: partial.embedding ?? generatePseudoEmbedding(partial.content),
    ...partial,
  } as DocumentChunk;
}

// Hace que el RAGRetriever lea un indice en memoria (sin tocar el fichero real,
// que esta gitignored). Devuelve la funcion de limpieza de los spies.
function mockIndexEnDisco(index: IndexedData): void {
  jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);
  jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(index));
}

describe('Carmen · embeddings (puros)', () => {
  it('generatePseudoEmbedding devuelve un vector de longitud 1536', () => {
    expect(generatePseudoEmbedding('IVA trimestral')).toHaveLength(1536);
  });

  it('es determinista: mismo texto -> mismo vector', () => {
    expect(generatePseudoEmbedding('IVA trimestral')).toEqual(generatePseudoEmbedding('IVA trimestral'));
  });

  it('cosineSimilarity de un vector consigo mismo es ~1', () => {
    const e = generatePseudoEmbedding('asiento pendiente');
    expect(cosineSimilarity(e, e)).toBeCloseTo(1, 5);
  });
});

describe('Carmen · DocumentIndexer', () => {
  it('chunkifica por encabezados, mantiene source, clasifica ACCOUNTING y etiqueta iva', () => {
    const docs = new Map<string, string>([
      ['iva.md', '# IVA\n## Concepto\nEl IVA es un impuesto sobre el consumo.\n## Libros de IVA\nEmitidas y recibidas.'],
    ]);

    const chunks = new DocumentIndexer().chunkDocuments(docs);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((c) => c.source === 'iva.md')).toBe(true);
    expect(chunks.every((c) => c.type === 'ACCOUNTING')).toBe(true);
    expect(chunks.some((c) => c.tags.includes('iva'))).toBe(true);
  });
});

describe('Carmen · RAGRetriever', () => {
  const index: IndexedData = {
    lastUpdated: '2026-06-21',
    chunks: [
      chunk({ id: 'c-iva', content: 'El IVA se declara trimestralmente.', source: 'iva.md', section: 'IVA', tags: ['iva'], metadata: { difficulty: 'basico', relatedTopics: ['IVA'] } }),
      chunk({ id: 'c-asi', content: 'Un asiento pendiente espera aprobacion.', source: 'asientos_contables.md', section: 'Estados', tags: ['asientos'], metadata: { difficulty: 'basico', relatedTopics: ['Asientos'] } }),
    ],
  };

  beforeEach(() => mockIndexEnDisco(index));
  afterEach(() => jest.restoreAllMocks());

  it('filtrando por tags ["iva"] devuelve solo chunks de IVA', () => {
    const r = new RAGRetriever().retrieve('como declaro el IVA?', 5, { tags: ['iva'] });
    expect(r.length).toBe(1);
    expect(r[0].source).toBe('iva.md');
  });

  it('si el tag no casa, hace fallback y no deja la respuesta vacia', () => {
    const r = new RAGRetriever().retrieve('pregunta sin tag concreto', 5, { tags: ['inexistente'] });
    expect(r.length).toBeGreaterThan(0);
  });

  it('sin index.json en disco (caso Vercel) reconstruye el indice en memoria desde los .md', () => {
    // Limpiamos los spies del beforeEach (que mockean readFileSync con un indice
    // falso) para que la reconstruccion lea los .md REALES de la KB.
    jest.restoreAllMocks();

    // Capturamos la statSync ORIGINAL antes de espiar: jest.spyOn muta el modulo
    // fs en sitio (singleton), asi que delegar via requireActual reentraria en el
    // propio spy (recursion). statSync del INDEX_PATH falla -> simula el indice
    // gitignored ausente; el resto de accesos usan la impl original.
    const originalStatSync = fs.statSync;
    jest.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p).includes('embeddings')) throw new Error('ENOENT');
      return originalStatSync(p);
    }) as typeof fs.statSync);

    const r = new RAGRetriever().retrieve('como funciona el IVA?', 5, { tags: ['iva'] });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((c) => c.source.endsWith('.md'))).toBe(true);
  });
});

describe('Carmen · AssistantEngine (modo degradado)', () => {
  beforeEach(() => {
    mockIndexEnDisco({
      lastUpdated: '2026-06-21',
      chunks: [
        chunk({ id: 'c-iva', content: 'El IVA se declara cada trimestre en el modelo 303.', source: 'iva.md', section: 'IVA', tags: ['iva'], metadata: { difficulty: 'basico', relatedTopics: ['IVA'] } }),
      ],
    });
    prismaMock.chatSession.upsert.mockClear();
    prismaMock.chatMessage.create.mockClear();
    prismaMock.chatMessage.findMany.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('sin API key responde con el contexto recuperado, incluye fuentes y persiste user+assistant', async () => {
    const res = await new AssistantEngine().chat('cuando se declara el IVA?', {
      userId: 'u1',
      companyId: '1',
      sessionId: 'sess-test',
      currentPage: '/impuestos',
    });

    expect(res.sessionId).toBe('sess-test');
    expect(res.response).toContain('IVA');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(prismaMock.chatSession.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.chatMessage.create).toHaveBeenCalledTimes(2);
  });
});
