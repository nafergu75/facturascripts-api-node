# Carmen – Plan de Implementación en 3 Fases (B → A → C)

**Asistente Contable Experto – Motor Contable FacturaScripts**  
**Fecha:** 13 de junio de 2026  
**Versión:** 1.0

---

## 📋 Tabla de Contenidos

1. [Fase B: Prototipo Rápido](#fase-b-prototipo-rápido)
2. [Fase A: Backend + API RAG](#fase-a-backend--api-rag)
3. [Fase C: Integración Completa (Frontend + Backend)](#fase-c-integración-completa)
4. [Roadmap General](#roadmap-general)

---

## Fase B: Prototipo Rápido

### Objetivo
Validar que Carmen funciona correctamente **sin infraestructura compleja** en 30–60 minutos. Solo usar Claude API + script Node + textos de ejemplo.

### 1.1 Flujo Mínimo

```
┌─────────────────────────────────────────┐
│  Node.js Script (TypeScript opcional)   │
│                                         │
│  1. Cargar system prompt de Carmen      │
│  2. Cargar docs de ejemplo (text)       │
│  3. Leer pregunta del usuario           │
│  4. Llamar Claude API                   │
│  5. Mostrar respuesta                   │
└─────────────────────────────────────────┘
              │
              ▼
    ┌──────────────────┐
    │  Claude API      │
    │  (Anthropic)     │
    └──────────────────┘
```

### 1.2 Implementación Fase B

**Archivo:** `prototype-carmen.js` (o `.ts`)

```javascript
// prototype-carmen.js
// Prototipo rápido de Carmen con Claude API

const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic();

// System Prompt de Carmen
const SYSTEM_PROMPT = `Eres un asistente contable y fiscal experto especializado en:

Contabilidad española basada en el Plan General de Contabilidad (PGC).

Gestión de IVA, IRPF y principales modelos de la AEAT.

La aplicación de gestión que tienes delante (similar a Quipu).

Tu misión es actuar como un contable y economista profesional, pero explicando todo en un lenguaje sencillo.

REGLAS DE ORO:
1. Lenguaje sencillo (evita jerga técnica)
2. Apóyate en la documentación proporcionada
3. Respuestas prácticas y accionables (incluye pasos en la app)
4. Coherencia con la app y el PGC
5. Reconoce límites

FORMATO:
- Contesta con una frase corta y directa
- Luego, organiza en secciones claras
- Indica rutas específicas en la app (ej: "Menú Contabilidad → Asientos")
- Usa listas para enumerar pasos
`;

// Documentos de ejemplo (extractos mínimos)
const KNOWLEDGE_BASE = {
  asientos: `
    # Asientos Contables - Concepto Básico

    ## ¿Qué es un asiento contable?
    Un asiento es el registro de una operación contable siguiendo el principio de "partida doble":
    todo movimiento tiene un Debe y un Haber que siempre suman lo mismo.

    ## Estados del Asiento
    - DRAFT: Recién creado, no afecta informes
    - PENDING_REVIEW: Esperando aprobación del usuario
    - POSTED: Aprobado, ya está en balance/PyG
    - REVERSED: Anulado (cuando se modifica factura)

    ## En la App
    Ve a Contabilidad → Asientos para ver todos.
    Haz click en uno para ver líneas detalladas.
    Si está en PENDING, usa botón Aprobar para confirmarlo.
  `,
  iva: `
    # IVA - Impuesto sobre el Valor Añadido

    ## Conceptos Básicos
    El IVA es un impuesto sobre el consumo que el empresario debe declarar y pagar.

    ## Libros de IVA
    - Libro de Facturas Emitidas: tus ventas
    - Libro de Facturas Recibidas: tus compras

    ## En la App
    Ve a Reportes → Libros IVA → Emitidas/Recibidas
    Puedes filtrar por período (trimestral, mensual).
    Exporta a CSV para Hacienda.
  `,
  irpf: `
    # IRPF - Retención de Impuesto sobre la Renta

    ## Concepto
    El IRPF es una retención que aplica en ciertos servicios (ej: consultoría, profesionales).

    ## En la App
    Cuando creas una factura con retención IRPF:
    - El importe neto ya viene reducido
    - El asiento tiene una línea de "Retención IRPF"
    - Aparece en el resumen de modelo 190

    ## Ver Retenciones
    Ve a Reportes → Resumen de Retenciones (modelo 190).
  `
};

// Función para inyectar contexto relevante
function buildContext(userQuestion) {
  // Búsqueda simple de palabras clave
  let relevantDocs = "";

  if (userQuestion.toLowerCase().includes("asiento")) {
    relevantDocs += KNOWLEDGE_BASE.asientos + "\n\n";
  }
  if (userQuestion.toLowerCase().includes("iva")) {
    relevantDocs += KNOWLEDGE_BASE.iva + "\n\n";
  }
  if (userQuestion.toLowerCase().includes("irpf") || userQuestion.toLowerCase().includes("retención")) {
    relevantDocs += KNOWLEDGE_BASE.irpf + "\n\n";
  }

  return relevantDocs;
}

// Función para llamar a Claude
async function askCarmen(userQuestion) {
  const context = buildContext(userQuestion);

  const messages = [
    {
      role: "user",
      content: `CONTEXTO DE LA BASE DE CONOCIMIENTO:
${context}

PREGUNTA DEL USUARIO:
${userQuestion}`
    }
  ];

  console.log("\n🤔 Carmen está pensando...\n");

  try {
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages
    });

    const answer = response.content[0].type === "text" ? response.content[0].text : "Error al procesar";
    return answer;
  } catch (error) {
    console.error("Error en la API de Claude:", error.message);
    throw error;
  }
}

// Función principal para interacción
async function main() {
  console.log("╔════════════════════════════════════════╗");
  console.log("║  CARMEN - Asistente Contable Experto   ║");
  console.log("║  Prototipo Rápido (Fase B)             ║");
  console.log("╚════════════════════════════════════════╝\n");

  // Ejemplos de pruebas automáticas
  const testQuestions = [
    "¿Qué significa que un asiento esté pendiente de revisión?",
    "He creado una factura con IRPF. ¿Dónde veo la retención?",
    "¿Cómo veo mis libros de IVA?"
  ];

  for (const question of testQuestions) {
    console.log(`\n📝 Usuario: ${question}`);
    console.log("─".repeat(60));

    try {
      const answer = await askCarmen(question);
      console.log(`\n👩‍💼 Carmen:\n${answer}\n`);
      console.log("═".repeat(60));
    } catch (error) {
      console.error(`Error procesando pregunta: ${error.message}`);
    }

    // Pequeña pausa entre preguntas (sin ser estricto)
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log("\n✅ Pruebas completadas. Fase B validada.\n");
}

// Ejecutar si corre directamente
if (require.main === module) {
  main();
}

module.exports = { askCarmen };
```

### 1.3 Cómo Ejecutar Fase B

**Prerequisitos:**
```bash
npm install @anthropic-ai/sdk
```

**Ejecutar:**
```bash
ANTHROPIC_API_KEY=tu_clave_aqui node prototype-carmen.js
```

**Salida esperada:**
```
╔════════════════════════════════════════╗
║  CARMEN - Asistente Contable Experto   ║
║  Prototipo Rápido (Fase B)             ║
╚════════════════════════════════════════╝

📝 Usuario: ¿Qué significa que un asiento esté pendiente de revisión?
────────────────────────────────────────────────────────────────

🤔 Carmen está pensando...

👩‍💼 Carmen:
Un asiento pendiente de revisión es un registro contable que aún no ha sido aprobado.
Esto es completamente normal...

[respuesta de Carmen]
```

### 1.4 Casos de Prueba Recomendados (Fase B)

**Test 1: Asientos Pendientes**
```
Entrada: "¿Qué es un asiento pendiente de revisión?"

Validar que Carmen:
✓ Explique el concepto en lenguaje simple
✓ Indique dónde encontrarlo en la app
✓ Dé pasos claros para aprobarlo
```

**Test 2: IRPF y Retenciones**
```
Entrada: "He creado una factura con IRPF. ¿Dónde veo la retención?"

Validar que Carmen:
✓ Explique dónde aparece la retención (asiento + modelo 190)
✓ Indique la ruta en la app
✓ Dé contexto sobre qué es el IRPF
```

**Test 3: Libros de IVA**
```
Entrada: "¿Cómo veo mis libros de IVA?"

Validar que Carmen:
✓ Distinga entre emitidas y recibidas
✓ Indique cómo filtrar por período
✓ Mencione la exportación a CSV
```

**Test 4: Flujo Factura → Asiento** (más avanzado)
```
Entrada: "¿Qué pasa cuando confirmo una factura?"

Validar que Carmen:
✓ Explique que se genera un asiento automático
✓ Indique los estados por los que pasa
✓ Sugiera cómo revisar y aprobar
```

---

## Fase A: Backend + API RAG

### Objetivo
Implementar un **backend completo** con indexación de documentos, recuperación RAG, y endpoint `/api/chat-assistant` que exponga Carmen de forma escalable.

### 2.1 Arquitectura de Fase A

```
┌─────────────────────────────────────────────────────────┐
│  Express.js Backend (Node + TypeScript)                 │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Endpoint: POST /api/chat-assistant              │   │
│  │  Body: { sessionId, companyId, message }         │   │
│  └─────────────────────────────────────────────────┘   │
│           ▼                                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │  AssistantEngine                                │   │
│  │  - Recuperar historial (sessionId)              │   │
│  │  - Recuperar contexto (RAG)                     │   │
│  │  - Llamar Claude API                            │   │
│  │  - Guardar en BD                                │   │
│  └─────────────────────────────────────────────────┘   │
│       ▲            ▲                  ▲                  │
│       │            │                  │                  │
│   ┌───┴──┐  ┌──────┴──────┐  ┌────────┴────────┐       │
│   │      │  │             │  │                 │       │
│ RAG      │  │             │  │                 │       │
│ Retriever│  │ Historial   │  │ Claude API      │       │
│   │      │  │   (SQLite)  │  │                 │       │
│   └──────┘  └─────────────┘  └─────────────────┘       │
│       ▲                                                  │
│  ┌────┴──────────────────────┐                         │
│  │  DocumentIndexer           │                         │
│  │  - Cargar docs (filesystem)│                         │
│  │  - Chunking               │                         │
│  │  - Embeddings (Claude API)│                         │
│  │  - Almacenamiento         │                         │
│  └───────────────────────────┘                         │
│           ▲                                              │
│  ┌────────┴──────────────────────┐                     │
│  │  Base de Datos                 │                     │
│  │  - Chunks + Embeddings (JSON)  │                     │
│  │  - Conversaciones (SQLite)     │                     │
│  └────────────────────────────────┘                     │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 2.2 Estructura de Archivos (Fase A)

```
facturascripts-api-node/
├── src/
│   ├── services/
│   │   ├── chatbot/
│   │   │   ├── document-indexer.ts        ← Cargar, chunking, embeddings
│   │   │   ├── rag-retriever.ts           ← Búsqueda semántica
│   │   │   ├── assistant-engine.ts        ← Orquestación + LLM
│   │   │   └── types.ts                   ← Tipos (DocumentChunk, etc.)
│   │   │
│   │   └── ...resto de servicios
│   │
│   ├── routes/
│   │   ├── chat-assistant.routes.ts       ← POST /api/chat-assistant
│   │   └── ...
│   │
│   ├── database/
│   │   ├── migrations/
│   │   │   └── 001-create-chat-tables.sql ← Tablas: conversations, messages
│   │   └── db.ts                          ← Conexión SQLite
│   │
│   └── ...
│
├── docs/
│   ├── chatbot/
│   │   ├── knowledge-base/
│   │   │   ├── 01_conceptos_basicos/
│   │   │   │   ├── asientos_contables.md
│   │   │   │   ├── iva_irpf.md
│   │   │   │   └── facturas.md
│   │   │   ├── 02_workflow_fiscalidad/
│   │   │   │   ├── factura_a_asiento.md
│   │   │   │   └── libros_iva.md
│   │   │   └── 03_escenarios_tipicos/
│   │   │       └── autonomo_iva_trimestral.md
│   │   │
│   │   └── product-docs/
│   │       ├── feature_asientos.md
│   │       ├── feature_balance_pyg.md
│   │       └── api_reference_summary.md
│   │
│   └── ...
│
├── data/
│   ├── embeddings/
│   │   └── index.json               ← Chunks + embeddings (indexación)
│   │
│   └── ...
│
└── ...
```

### 2.3 Componentes Detallados (Fase A)

#### **A. DocumentIndexer (`src/services/chatbot/document-indexer.ts`)**

```typescript
// Pseudocódigo

import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";

interface DocumentChunk {
  id: string;
  content: string;
  source: string;           // ej: "asientos_contables.md"
  section: string;          // ej: "Concepto Básico"
  tags: string[];           // ["concepto", "asiento"]
  metadata: {
    difficulty: "basico" | "intermedio" | "avanzado";
    relatedTopics: string[];
    url?: string;
  };
  embedding: number[];      // Vector de embeddings
}

interface IndexedData {
  chunks: DocumentChunk[];
  lastUpdated: string;
}

export class DocumentIndexer {
  private client: Anthropic;
  private indexPath: string = "./data/embeddings/index.json";

  constructor() {
    this.client = new Anthropic();
  }

  // 1. Cargar documentos desde filesystem
  async loadDocuments(folderPath: string): Promise<Map<string, string>> {
    const docs = new Map<string, string>();

    const walkDir = (dir: string) => {
      const files = fs.readdirSync(dir);

      files.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          walkDir(fullPath); // Recursivo
        } else if (file.endsWith(".md")) {
          const content = fs.readFileSync(fullPath, "utf-8");
          docs.set(file, content);
        }
      });
    };

    walkDir(folderPath);
    return docs;
  }

  // 2. Dividir documentos en chunks
  async chunkDocuments(docs: Map<string, string>): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];
    let chunkId = 0;

    docs.forEach((content, filename) => {
      // Separar por encabezados (##, ###)
      const sections = content.split(/^##+ /m);

      sections.forEach((section, idx) => {
        const lines = section.split("\n");
        const sectionTitle = lines[0] || "Sin título";

        // Agrupar líneas en chunks de ~500-1500 caracteres
        let currentChunk = "";

        lines.forEach(line => {
          if ((currentChunk + line).length > 1500 && currentChunk.length > 0) {
            // Guardar chunk anterior
            chunks.push({
              id: `chunk-${chunkId++}`,
              content: currentChunk.trim(),
              source: filename,
              section: sectionTitle,
              tags: this.extractTags(filename, sectionTitle),
              metadata: {
                difficulty: this.estimateDifficulty(currentChunk),
                relatedTopics: this.extractRelatedTopics(currentChunk)
              },
              embedding: [] // Se rellena después
            });

            currentChunk = line + "\n";
          } else {
            currentChunk += line + "\n";
          }
        });

        // Último chunk
        if (currentChunk.trim()) {
          chunks.push({
            id: `chunk-${chunkId++}`,
            content: currentChunk.trim(),
            source: filename,
            section: sectionTitle,
            tags: this.extractTags(filename, sectionTitle),
            metadata: {
              difficulty: this.estimateDifficulty(currentChunk),
              relatedTopics: this.extractRelatedTopics(currentChunk)
            },
            embedding: []
          });
        }
      });
    });

    return chunks;
  }

  // 3. Generar embeddings usando Claude API
  async generateEmbeddings(chunks: DocumentChunk[]): Promise<DocumentChunk[]> {
    console.log(`Generando embeddings para ${chunks.length} chunks...`);

    // Procesar en lotes (para no sobrecargar API)
    const batchSize = 10;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);

      for (const chunk of batch) {
        // Usar Claude Embeddings API (si está disponible)
        // Por ahora, usamos una aproximación: 
        // hash del contenido como pseudo-embedding
        // EN PRODUCCIÓN, usar embeddings reales

        const embedding = this.generatePseudoEmbedding(chunk.content);
        chunk.embedding = embedding;
      }

      console.log(`Procesados ${i + batchSize}/${chunks.length} chunks`);
    }

    return chunks;
  }

  // 4. Guardar índice en JSON
  async storeIndex(chunks: DocumentChunk[]): Promise<void> {
    const data: IndexedData = {
      chunks,
      lastUpdated: new Date().toISOString()
    };

    // Crear carpeta si no existe
    const dir = path.dirname(this.indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
    console.log(`Índice guardado en ${this.indexPath}`);
  }

  // 5. Construir índice completo (orquestador)
  async rebuildIndex(docsFolder: string = "./docs/chatbot/knowledge-base/"): Promise<void> {
    console.log("Iniciando construcción de índice...");

    const docs = await this.loadDocuments(docsFolder);
    console.log(`✓ Cargados ${docs.size} documentos`);

    let chunks = await this.chunkDocuments(docs);
    console.log(`✓ Creados ${chunks.length} chunks`);

    chunks = await this.generateEmbeddings(chunks);
    console.log(`✓ Generados embeddings`);

    await this.storeIndex(chunks);
    console.log("✓ Índice completado y guardado\n");
  }

  // Helpers

  private extractTags(filename: string, section: string): string[] {
    const tags: string[] = [];

    if (filename.includes("asiento")) tags.push("asientos");
    if (filename.includes("iva")) tags.push("iva");
    if (filename.includes("irpf")) tags.push("irpf");
    if (filename.includes("factura")) tags.push("facturas");
    if (filename.includes("balance")) tags.push("balance");

    if (section.toLowerCase().includes("ejemplo")) tags.push("ejemplo");
    if (section.toLowerCase().includes("paso")) tags.push("pasos");

    return [...new Set(tags)];
  }

  private estimateDifficulty(content: string): "basico" | "intermedio" | "avanzado" {
    if (content.length < 300) return "basico";
    if (content.includes("PGC") || content.includes("fórmula")) return "intermedio";
    return "avanzado";
  }

  private extractRelatedTopics(content: string): string[] {
    const topics: string[] = [];
    if (content.includes("IVA")) topics.push("IVA");
    if (content.includes("IRPF")) topics.push("IRPF");
    if (content.includes("asiento")) topics.push("Asientos");
    if (content.includes("factura")) topics.push("Facturas");
    return topics;
  }

  private generatePseudoEmbedding(text: string): number[] {
    // PSEUDO: En producción, usar API real
    // Esto es solo para demostración
    const hash = text
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);

    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      embedding.push(Math.sin(hash + i) * 0.5 + 0.5);
    }
    return embedding;
  }
}
```

#### **B. RAGRetriever (`src/services/chatbot/rag-retriever.ts`)**

```typescript
// Pseudocódigo

import fs from "fs";
import { DocumentChunk, IndexedData } from "./types";

export class RAGRetriever {
  private index: IndexedData | null = null;

  constructor() {
    this.loadIndex();
  }

  private loadIndex(): void {
    try {
      const data = fs.readFileSync("./data/embeddings/index.json", "utf-8");
      this.index = JSON.parse(data) as IndexedData;
      console.log(`Índice cargado: ${this.index.chunks.length} chunks`);
    } catch (error) {
      console.error("Error cargando índice:", error);
      this.index = { chunks: [], lastUpdated: new Date().toISOString() };
    }
  }

  // Buscar chunks relevantes por similitud
  async retrieve(
    query: string,
    topK: number = 5,
    filters?: {
      difficulty?: string;
      tags?: string[];
      source?: string;
    }
  ): Promise<DocumentChunk[]> {
    if (!this.index || this.index.chunks.length === 0) {
      return [];
    }

    // 1. Generar embedding de la query
    const queryEmbedding = this.generatePseudoEmbedding(query);

    // 2. Calcular similitud coseno para todos los chunks
    const scored = this.index.chunks
      .map(chunk => ({
        chunk,
        score: this.cosineSimilarity(queryEmbedding, chunk.embedding)
      }))
      .sort((a, b) => b.score - a.score);

    // 3. Aplicar filtros
    let filtered = scored;

    if (filters?.tags && filters.tags.length > 0) {
      filtered = filtered.filter(item =>
        filters.tags!.some(tag => item.chunk.tags.includes(tag))
      );
    }

    if (filters?.difficulty) {
      filtered = filtered.filter(
        item => item.chunk.metadata.difficulty === filters.difficulty
      );
    }

    if (filters?.source) {
      filtered = filtered.filter(
        item => item.chunk.source === filters.source
      );
    }

    // 4. Devolver top K
    return filtered.slice(0, topK).map(item => item.chunk);
  }

  // Helpers

  private cosineSimilarity(a: number[], b: number[]): number {
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

  private generatePseudoEmbedding(text: string): number[] {
    // Mismo pseudo-embedding que en DocumentIndexer
    const hash = text
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);

    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      embedding.push(Math.sin(hash + i) * 0.5 + 0.5);
    }
    return embedding;
  }
}
```

#### **C. AssistantEngine (`src/services/chatbot/assistant-engine.ts`)**

```typescript
// Pseudocódigo

import Anthropic from "@anthropic-ai/sdk";
import { RAGRetriever } from "./rag-retriever";
import { Database } from "better-sqlite3";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export class AssistantEngine {
  private client: Anthropic;
  private ragRetriever: RAGRetriever;
  private db: Database;

  private SYSTEM_PROMPT = `Eres un asistente contable y fiscal experto...`; // (completo)

  constructor(db: Database) {
    this.client = new Anthropic();
    this.ragRetriever = new RAGRetriever();
    this.db = db;
  }

  async chat(
    message: string,
    options: {
      userId: string;
      companyId?: string;
      sessionId: string;
      currentPage?: string;
      language?: "es" | "en";
    }
  ): Promise<{
    response: string;
    sources: Array<{ title: string; snippet: string; source: string }>;
    suggestions: string[];
  }> {
    // 1. Recuperar contexto relevante (RAG)
    const chunks = await this.ragRetriever.retrieve(message, 5, {
      tags: this.extractTopicsFromQuery(message)
    });

    // 2. Construir contexto para Claude
    const context = chunks
      .map(chunk => `[${chunk.source}/${chunk.section}]\n${chunk.content}`)
      .join("\n\n---\n\n");

    // 3. Recuperar historial de conversación
    const history = this.getConversationHistory(options.sessionId);

    // 4. Personalizar system prompt según página actual
    const adjustedSystemPrompt = this.adjustSystemPrompt(
      options.currentPage
    );

    // 5. Construir mensajes para Claude
    const messages: Anthropic.MessageParam[] = [
      ...history.map(msg => ({
        role: msg.role as "user" | "assistant",
        content: msg.content
      })),
      {
        role: "user",
        content: `CONTEXTO DE LA BASE DE CONOCIMIENTO:
${context}

PREGUNTA DEL USUARIO:
${message}`
      }
    ];

    // 6. Llamar a Claude
    const response = await this.client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: adjustedSystemPrompt,
      messages
    });

    const assistantMessage =
      response.content[0].type === "text"
        ? response.content[0].text
        : "Error procesando respuesta";

    // 7. Guardar en BD
    this.saveConversationMessage(options.sessionId, options.userId, "user", message);
    this.saveConversationMessage(
      options.sessionId,
      options.userId,
      "assistant",
      assistantMessage,
      chunks.map(c => c.source)
    );

    // 8. Generar sugerencias (tópicos relacionados)
    const suggestions = this.generateSuggestions(message, chunks);

    return {
      response: assistantMessage,
      sources: chunks.map(c => ({
        title: c.section,
        snippet: c.content.substring(0, 200),
        source: c.source
      })),
      suggestions
    };
  }

  // Helpers

  private extractTopicsFromQuery(query: string): string[] {
    const topics: string[] = [];
    if (query.toLowerCase().includes("asiento")) topics.push("asientos");
    if (query.toLowerCase().includes("iva")) topics.push("iva");
    if (query.toLowerCase().includes("irpf")) topics.push("irpf");
    if (query.toLowerCase().includes("factura")) topics.push("facturas");
    if (query.toLowerCase().includes("balance")) topics.push("balance");
    return topics;
  }

  private getConversationHistory(sessionId: string): ConversationMessage[] {
    // Recuperar últimos 10 mensajes de la BD
    const stmt = this.db.prepare(`
      SELECT role, content FROM chat_messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `);

    const rows = stmt.all(sessionId) as Array<{
      role: string;
      content: string;
    }>;
    return rows.reverse().map(row => ({
      role: row.role as "user" | "assistant",
      content: row.content
    }));
  }

  private adjustSystemPrompt(currentPage?: string): string {
    let adjusted = this.SYSTEM_PROMPT;

    if (currentPage?.includes("journal-entries")) {
      adjusted += "\n\nEl usuario está actualmente en la página de Asientos. Enfatiza pasos en esta sección.";
    } else if (currentPage?.includes("reports")) {
      adjusted += "\n\nEl usuario está actualmente en la página de Reportes. Ayuda a interpretar datos.";
    } else if (currentPage?.includes("tax")) {
      adjusted += "\n\nEl usuario está actualmente en la página de Impuestos. Explica IVA, IRPF, modelos.";
    }

    return adjusted;
  }

  private saveConversationMessage(
    sessionId: string,
    userId: string,
    role: "user" | "assistant",
    content: string,
    sources?: string[]
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO chat_messages (session_id, user_id, role, content, sources, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      userId,
      role,
      content,
      sources ? JSON.stringify(sources) : null,
      new Date().toISOString()
    );
  }

  private generateSuggestions(query: string, chunks: any[]): string[] {
    // Generar preguntas follow-up basadas en chunks recuperados
    const suggestions: string[] = [];

    const topics = new Set<string>();
    chunks.forEach(chunk => {
      chunk.metadata.relatedTopics.forEach((t: string) => topics.add(t));
    });

    topics.forEach(topic => {
      suggestions.push(`¿Cómo funciona ${topic}?`);
    });

    return suggestions.slice(0, 3);
  }
}
```

#### **D. Endpoint REST (`src/routes/chat-assistant.routes.ts`)**

```typescript
// Pseudocódigo

import express, { Request, Response } from "express";
import { AssistantEngine } from "../services/chatbot/assistant-engine";
import { authMiddleware, requireCompanyId } from "../middleware";
import { db } from "../database";

const router = express.Router();

// Inicializar engine (singleton)
const engine = new AssistantEngine(db);

// POST /api/chat-assistant
router.post(
  "/chat-assistant",
  authMiddleware,
  requireCompanyId,
  async (req: Request, res: Response) => {
    try {
      const { message, sessionId, currentPage } = req.body;

      // Validación básica
      if (!message || message.trim().length === 0) {
        return res.status(400).json({
          success: false,
          error: "Message is required"
        });
      }

      // Llamar a AssistantEngine
      const result = await engine.chat(message, {
        userId: req.user.id,
        companyId: req.companyId || undefined,
        sessionId: sessionId || generateSessionId(),
        currentPage: currentPage || undefined
      });

      return res.json({
        success: true,
        data: {
          answer: result.response,
          sources: result.sources,
          suggestions: result.suggestions,
          sessionId: sessionId
        }
      });
    } catch (error) {
      console.error("Chat error:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to process chat request"
      });
    }
  }
);

// Helper
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export default router;
```

### 2.4 Base de Datos (Fase A)

**Archivo:** `src/database/migrations/001-create-chat-tables.sql`

```sql
-- Tabla: Sesiones de chat
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company_id TEXT,
  created_at TEXT NOT NULL,
  last_message_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Tabla: Mensajes de chat
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' o 'assistant'
  content TEXT NOT NULL,
  sources JSON,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
```

### 2.5 Flujo de Inicialización (Fase A)

**Script de inicialización:** `scripts/initialize-carmen.ts`

```typescript
// Pseudocódigo

import { DocumentIndexer } from "../src/services/chatbot/document-indexer";

async function initializeCarmen() {
  console.log("🚀 Inicializando Carmen...\n");

  // 1. Crear carpetas de documentos si no existen
  // (asume que las docs están en docs/chatbot/knowledge-base/)

  // 2. Crear índice
  const indexer = new DocumentIndexer();
  await indexer.rebuildIndex("./docs/chatbot/knowledge-base/");

  // 3. Crear tablas de BD
  const db = new Database("./data/app.db");
  const migration = fs.readFileSync("./src/database/migrations/001-create-chat-tables.sql", "utf-8");
  db.exec(migration);

  console.log("✅ Carmen lista para usar\n");
  console.log("Endpoint disponible: POST /api/chat-assistant");
  console.log("Ejemplo request:");
  console.log(`{
  "message": "¿Qué es un asiento pendiente?",
  "sessionId": "session-xyz",
  "currentPage": "/accounting/journal-entries"
}`);
}

initializeCarmen().catch(console.error);
```

**Ejecutar:**
```bash
npx ts-node scripts/initialize-carmen.ts
```

### 2.6 Validación de Fase A

**Pruebas manuales:**

1. **Indexación:**
   ```bash
   npx ts-node scripts/initialize-carmen.ts
   ```
   Verificar: `data/embeddings/index.json` creado con chunks

2. **Endpoint:**
   ```bash
   curl -X POST http://localhost:3000/api/chat-assistant \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <token>" \
     -d '{
       "message": "¿Qué es un asiento pendiente?",
       "sessionId": "test-123",
       "currentPage": "/accounting/journal-entries"
     }'
   ```

   Respuesta esperada:
   ```json
   {
     "success": true,
     "data": {
       "answer": "Un asiento pendiente de revisión...",
       "sources": [
         {
           "title": "Concepto Básico",
           "snippet": "...",
           "source": "asientos_contables.md"
         }
       ],
       "suggestions": ["¿Cómo apruebo un asiento?", ...]
     }
   }
   ```

---

## Fase C: Integración Completa (Frontend + Backend)

### Objetivo
Integrar Carmen como un **panel de chat dentro de la app React**, conectado al backend de Fase A.

### 3.1 Arquitectura de Integración (Fase C)

```
┌─────────────────────────────────────────────────┐
│  React App (Frontend)                           │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────────────────────────────────┐  │
│  │  ChatAssistant Panel (Sidebar)           │  │
│  │  - Mensajes del usuario                  │  │
│  │  - Respuestas de Carmen                  │  │
│  │  - Fuentes citadas                       │  │
│  │  - Sugerencias de follow-up              │  │
│  └──────────────────────────────────────────┘  │
│           ▲                                     │
│           │ POST /api/chat-assistant           │
│           │                                     │
│  ┌────────┴──────────────────────────────────┐ │
│  │  Hook: useCarmenChat()                    │ │
│  │  - Gestionar estado de conversación       │ │
│  │  - sessionId, companyId                   │ │
│  │  - Historial local                        │ │
│  └────────────────────────────────────────────┘ │
│                                                 │
└─────────────────────────────────────────────────┘
              │
              ▼
    ┌──────────────────────┐
    │  Express Backend     │
    │  /api/chat-assistant │
    └──────────────────────┘
```

### 3.2 Estructura de Archivos (Fase C)

```
src/
├── components/
│   ├── chatbot/
│   │   ├── ChatAssistant.tsx          ← Componente principal
│   │   ├── ChatMessage.tsx            ← Renderizar mensajes
│   │   ├── ChatSources.tsx            ← Mostrar fuentes citadas
│   │   ├── ChatSuggestions.tsx        ← Mostrar sugerencias
│   │   └── styles.module.css
│   │
│   └── ...
│
├── hooks/
│   ├── useCarmenChat.ts               ← Hook para lógica de chat
│   └── ...
│
├── api/
│   ├── assistantApi.ts                ← Llamadas a /api/chat-assistant
│   └── ...
│
├── types/
│   ├── chatbot.ts                     ← Tipos (Message, ChatResponse, etc.)
│   └── ...
│
└── ...
```

### 3.3 Componentes Frontend (Fase C)

#### **A. Tipos (`src/types/chatbot.ts`)**

```typescript
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  sources?: ChatSource[];
  suggestions?: string[];
}

export interface ChatSource {
  title: string;
  snippet: string;
  source: string;
}

export interface ChatResponse {
  answer: string;
  sources: ChatSource[];
  suggestions: string[];
  sessionId: string;
}

export interface ChatState {
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  sessionId: string;
}
```

#### **B. Hook (`src/hooks/useCarmenChat.ts`)**

```typescript
import { useState, useCallback, useEffect } from "react";
import { ChatMessage, ChatResponse, ChatState } from "../types/chatbot";
import { assistantApi } from "../api/assistantApi";
import { useCompanyId } from "./useCompanyId";
import { useLocation } from "react-router-dom";

export function useCarmenChat(initialSessionId?: string) {
  const { companyId } = useCompanyId();
  const { pathname } = useLocation();

  const [state, setState] = useState<ChatState>({
    messages: [],
    loading: false,
    error: null,
    sessionId: initialSessionId || generateSessionId()
  });

  // Enviar mensaje
  const sendMessage = useCallback(
    async (userMessage: string) => {
      if (!userMessage.trim()) return;

      // Agregar mensaje del usuario
      const userMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "user",
        content: userMessage,
        timestamp: new Date()
      };

      setState(prev => ({
        ...prev,
        messages: [...prev.messages, userMsg],
        loading: true,
        error: null
      }));

      try {
        // Llamar al backend
        const response = await assistantApi.chat({
          message: userMessage,
          sessionId: state.sessionId,
          companyId,
          currentPage: pathname
        });

        // Agregar respuesta de Carmen
        const assistantMsg: ChatMessage = {
          id: `msg-${Date.now()}-1`,
          role: "assistant",
          content: response.answer,
          timestamp: new Date(),
          sources: response.sources,
          suggestions: response.suggestions
        };

        setState(prev => ({
          ...prev,
          messages: [...prev.messages, assistantMsg],
          loading: false
        }));
      } catch (error) {
        setState(prev => ({
          ...prev,
          error: error instanceof Error ? error.message : "Error desconocido",
          loading: false
        }));
      }
    },
    [state.sessionId, companyId, pathname]
  );

  // Limpiar conversación
  const clearHistory = useCallback(() => {
    setState({
      messages: [],
      loading: false,
      error: null,
      sessionId: generateSessionId()
    });
  }, []);

  return {
    ...state,
    sendMessage,
    clearHistory
  };
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

#### **C. Componente Principal (`src/components/chatbot/ChatAssistant.tsx`)**

```typescript
import React, { useState } from "react";
import {
  Box,
  VStack,
  HStack,
  Input,
  Button,
  Spinner,
  useDisclosure
} from "@chakra-ui/react";
import { useCarmenChat } from "../../hooks/useCarmenChat";
import { ChatMessage as ChatMessageType } from "../../types/chatbot";
import { ChatMessage } from "./ChatMessage";
import { ChatSources } from "./ChatSources";
import { ChatSuggestions } from "./ChatSuggestions";

interface ChatAssistantProps {
  initialSessionId?: string;
  variant?: "sidebar" | "modal" | "page";
}

export function ChatAssistant({ initialSessionId, variant = "sidebar" }: ChatAssistantProps) {
  const { messages, loading, error, sendMessage, clearHistory, sessionId } =
    useCarmenChat(initialSessionId);

  const [input, setInput] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      sendMessage(input);
      setInput("");
    }
  };

  const lastMessage = messages[messages.length - 1];

  return (
    <VStack
      h="600px"
      w="100%"
      spacing={0}
      borderRadius="md"
      overflow="hidden"
      boxShadow="md"
      bg="white"
    >
      {/* Header */}
      <HStack w="100%" p={4} bg="blue.600" color="white" justify="space-between">
        <Box fontWeight="bold">👩‍💼 Carmen - Asistente Contable</Box>
        <Button
          size="sm"
          variant="ghost"
          color="white"
          onClick={clearHistory}
          _hover={{ bg: "blue.700" }}
        >
          Limpiar
        </Button>
      </HStack>

      {/* Área de Mensajes */}
      <VStack
        flex={1}
        overflowY="auto"
        spacing={4}
        p={4}
        w="100%"
        align="flex-start"
      >
        {messages.length === 0 ? (
          <Box textAlign="center" color="gray.400" py={8}>
            Hola, soy Carmen. ¿En qué puedo ayudarte con tu contabilidad? 👋
          </Box>
        ) : (
          messages.map(msg => <ChatMessage key={msg.id} message={msg} />)
        )}

        {loading && (
          <HStack justify="center" w="100%">
            <Spinner size="sm" />
            <Box fontSize="sm" color="gray.500">
              Carmen está pensando...
            </Box>
          </HStack>
        )}

        {error && (
          <Box p={3} bg="red.100" color="red.700" borderRadius="md" w="100%">
            Error: {error}
          </Box>
        )}
      </VStack>

      {/* Fuentes (si existen) */}
      {lastMessage?.role === "assistant" && lastMessage?.sources && (
        <ChatSources sources={lastMessage.sources} />
      )}

      {/* Sugerencias */}
      {lastMessage?.role === "assistant" && lastMessage?.suggestions && (
        <ChatSuggestions
          suggestions={lastMessage.suggestions}
          onSelect={setInput}
        />
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} style={{ width: "100%" }}>
        <HStack w="100%" p={4} borderTop="1px" borderColor="gray.200" spacing={2}>
          <Input
            placeholder="Pregunta algo sobre contabilidad..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            size="sm"
          />
          <Button
            type="submit"
            isLoading={loading}
            colorScheme="blue"
            size="sm"
            flexShrink={0}
          >
            Enviar
          </Button>
        </HStack>
      </form>
    </VStack>
  );
}
```

#### **D. Componente Mensaje (`src/components/chatbot/ChatMessage.tsx`)**

```typescript
import React from "react";
import { Box, HStack, Avatar, VStack } from "@chakra-ui/react";
import { ChatMessage as ChatMessageType } from "../../types/chatbot";

interface Props {
  message: ChatMessageType;
}

export function ChatMessage({ message }: Props) {
  const isUser = message.role === "user";

  return (
    <HStack w="100%" justify={isUser ? "flex-end" : "flex-start"} spacing={2}>
      {!isUser && (
        <Avatar name="Carmen" size="sm" bg="blue.500" color="white" />
      )}

      <Box
        maxW="80%"
        p={3}
        borderRadius="md"
        bg={isUser ? "blue.100" : "gray.100"}
        color={isUser ? "blue.900" : "gray.900"}
      >
        {message.content}
      </Box>

      {isUser && (
        <Avatar name="You" size="sm" bg="gray.400" />
      )}
    </HStack>
  );
}
```

#### **E. Componente Fuentes (`src/components/chatbot/ChatSources.tsx`)**

```typescript
import React from "react";
import { Box, VStack, Text, Link, Icon } from "@chakra-ui/react";
import { ChatSource } from "../../types/chatbot";
import { FiBookOpen } from "react-icons/fi";

interface Props {
  sources: ChatSource[];
}

export function ChatSources({ sources }: Props) {
  return (
    <Box w="100%" p={3} borderTop="1px" borderColor="gray.200" bg="gray.50">
      <Text fontSize="xs" fontWeight="bold" mb={2} color="gray.600">
        📚 Fuentes citadas:
      </Text>
      <VStack align="flex-start" spacing={1}>
        {sources.map((source, idx) => (
          <Box key={idx} fontSize="xs">
            <Text fontWeight="bold" color="blue.600">
              {source.title}
            </Text>
            <Text color="gray.600" noOfLines={2}>
              {source.snippet}...
            </Text>
            <Text fontSize="xs" color="gray.400">
              De: {source.source}
            </Text>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}
```

#### **F. Componente Sugerencias (`src/components/chatbot/ChatSuggestions.tsx`)**

```typescript
import React from "react";
import { Box, HStack, Button, Text } from "@chakra-ui/react";

interface Props {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
}

export function ChatSuggestions({ suggestions, onSelect }: Props) {
  return (
    <Box w="100%" p={3} borderTop="1px" borderColor="gray.200" bg="blue.50">
      <Text fontSize="xs" fontWeight="bold" mb={2} color="gray.600">
        💡 Preguntas relacionadas:
      </Text>
      <HStack wrap="wrap" spacing={2}>
        {suggestions.map((suggestion, idx) => (
          <Button
            key={idx}
            size="sm"
            variant="outline"
            fontSize="xs"
            onClick={() => onSelect(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </HStack>
    </Box>
  );
}
```

#### **G. API Client (`src/api/assistantApi.ts`)**

```typescript
import { ChatResponse } from "../types/chatbot";

interface ChatRequest {
  message: string;
  sessionId: string;
  companyId?: string;
  currentPage?: string;
}

export const assistantApi = {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetch("/api/chat-assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error(`Error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data;
  }
};
```

### 3.4 Integración en Layout Principal

**Archivo:** `src/components/layout/AppLayout.tsx`

```typescript
import React, { useState } from "react";
import { Box, HStack, VStack, Button, Drawer, DrawerOverlay, DrawerContent } from "@chakra-ui/react";
import { ChatAssistant } from "../chatbot/ChatAssistant";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [isChatOpen, setIsChatOpen] = useState(false);

  return (
    <HStack h="100vh" spacing={0}>
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content */}
      <VStack flex={1} spacing={0}>
        {/* Header */}
        <Header onOpenChat={() => setIsChatOpen(true)} />

        {/* Page Content */}
        <Box flex={1} w="100%" overflowY="auto">
          {children}
        </Box>
      </VStack>

      {/* Carmen Chat Drawer (Modal) */}
      <Drawer
        isOpen={isChatOpen}
        placement="right"
        onClose={() => setIsChatOpen(false)}
      >
        <DrawerOverlay />
        <DrawerContent>
          <ChatAssistant variant="modal" />
        </DrawerContent>
      </Drawer>

      {/* Botón Flotante (Alternativa) */}
      <Button
        position="fixed"
        bottom={4}
        right={4}
        borderRadius="full"
        w={14}
        h={14}
        bg="blue.600"
        color="white"
        fontSize="xl"
        _hover={{ bg: "blue.700" }}
        onClick={() => setIsChatOpen(true)}
      >
        👩‍💼
      </Button>
    </HStack>
  );
}
```

### 3.5 Contexto Dinámico (Fase C)

Si el usuario está viendo un **asiento específico**, Carmen puede tener más contexto:

```typescript
// En JournalEntryDetail.tsx

import { ChatAssistant } from "../chatbot/ChatAssistant";

export function JournalEntryDetail() {
  const { id } = useParams<{ id: string }>();
  const [entry, setEntry] = useState<JournalEntry | null>(null);

  return (
    <HStack spacing={4}>
      {/* Detalle del asiento */}
      <VStack flex={2}>
        {/* contenido */}
      </VStack>

      {/* Carmen sidebar contextual */}
      <VStack flex={1} h="600px">
        <ChatAssistant
          // Pasar contexto: Carmen sabe que estamos viendo un asiento
          initialSessionId={`session-journal-entry-${id}`}
        />
      </VStack>
    </HStack>
  );
}
```

### 3.6 Validación de Fase C

**Tests manuales:**

1. **Mostrar chat:**
   - Abrir app
   - Click en botón flotante o en header
   - Ver panel de chat

2. **Enviar pregunta:**
   - Escribir pregunta
   - Click Enviar
   - Verificar respuesta de Carmen

3. **Fuentes citadas:**
   - Verificar que se muestren fragmentos relevantes
   - Click en fuente (opcional: abrir doc)

4. **Sugerencias:**
   - Verificar que aparezcan follow-ups
   - Click en sugerencia → rellenar input

5. **Contexto:**
   - Navegar a diferente página
   - Verificar que currentPage se envíe al backend

---

## Roadmap General

### Timeline Recomendado

| Fase | Duración | Entregables | Validación |
|------|----------|-------------|-----------|
| **B** | 0.5-1 día | Script Node + Prototipo | Pruebas manuales de 3-4 Q&A |
| **A** | 2-3 días | Backend RAG completo | Endpoint funcional con indexación |
| **C** | 2-3 días | Frontend integrado | Chat completo en app |

### Dependencias

```
Fase B (Independiente)
  ↓
Fase A (Requiere: docs organizadas + Claude API key)
  ↓
Fase C (Requiere: Fase A + React setup)
```

### Checkpoints

**Fase B ✓:**
- Script ejecuta sin errores
- Respuestas de Carmen son coherentes
- Usa documentos cargados

**Fase A ✓:**
- Índice se construye sin errores
- POST `/api/chat-assistant` funciona
- Recupera contexto relevante
- Historial se guarda en BD

**Fase C ✓:**
- Chat aparece en UI
- Mensajes se envían/reciben
- Fuentes se muestran
- Sugerencias funcionan

---

## Próximos Pasos

1. **Decidir inicio:** ¿Empezamos con Fase B (prototipo rápido)?
2. **Documentación:** ¿Subir docs de ejemplo a `docs/chatbot/knowledge-base/`?
3. **Implementación:** ¿Quieres que implemente bloque a bloque?

---

**Este plan es 100% accionable. Cada fase es independiente y comprobable.**
