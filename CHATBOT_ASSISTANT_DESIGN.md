# Asistente Contable Chatbot - Design & Implementation Plan

**Motor Contable FacturaScripts - Chatbot de Soporte Experto**  
**Fecha:** 13 de junio de 2026  
**Estado:** Especificación y Plan

---

## 📋 Tabla de Contenidos

1. [Objetivo y Visión](#objetivo-y-visión)
2. [Arquitectura General](#arquitectura-general)
3. [Fuentes de Conocimiento](#fuentes-de-conocimiento)
4. [Componentes Técnicos](#componentes-técnicos)
5. [Flujo de Datos](#flujo-de-datos)
6. [Prompt del Asistente](#prompt-del-asistente)
7. [Plan de Implementación](#plan-de-implementación)
8. [Ejemplos de Conversaciones](#ejemplos-de-conversaciones)

---

## 🎯 Objetivo y Visión

### Propósito
Un chatbot **en-aplicación** que actúe como "contable virtual experto" para:
- Usuarios **no contables** (pequeños empresarios, autónomos) que necesitan guía
- Profesionales que quieren verificar cómo funciona la app
- Equipos de soporte respondiendo preguntas frecuentes

### Características Clave
- 🧠 **Basado en documentación** (no alucinaciones)
- 🎯 **Contextual** (sabe qué sección está viendo el usuario)
- 📚 **Experto en contabilidad española** (PGC, IVA, IRPF)
- 👥 **Lenguaje accesible** (no jerga técnica si no es necesario)
- 🔗 **Integrado en la app** (panel lateral, popup, o página dedicada)

### Ejemplo de Preguntas que Debe Responder

✅ "¿Qué es un asiento pendiente de revisión?"  
✅ "He creado una factura con IRPF, ¿dónde veo la retención?"  
✅ "¿Dónde están mis libros de IVA?"  
✅ "¿Cuándo se genera automáticamente un asiento contable?"  
✅ "¿Por qué mi balance no cuadra?"  
✅ "¿Cómo exporto mis reportes a Excel?"  
✅ "¿Qué significa 'Modelo 303'?"  

---

## 🏗️ Arquitectura General

```
┌─────────────────────────────────────────────────────┐
│                  Frontend React                     │
│          Chat Panel (Sidebar o Modal)               │
│  ┌────────────────────────────────────────────────┐ │
│  │  Input: "¿Qué es un asiento?"                  │ │
│  │  Output: Respuesta del asistente               │ │
│  └────────────────────────────────────────────────┘ │
└────────────────────┬────────────────────────────────┘
                     │ POST /api/v1/chat-assistant
                     │ { message, context, companyId }
                     ▼
        ┌────────────────────────────────┐
        │    Backend (Express + Prisma)  │
        │                                │
        │  1. Recuperar contexto         │
        │  2. Buscar en índice (RAG)     │
        │  3. Llamar a LLM (Claude)      │
        │  4. Devolver respuesta         │
        └────────────────────────────────┘
                     ▲
        ┌────────────┴────────────┬──────────────────┐
        │                         │                  │
        ▼                         ▼                  ▼
   ┌─────────┐         ┌──────────────┐      ┌─────────────┐
   │ Índice  │         │  Documentos  │      │ LLM Claude  │
   │ RAG     │         │  (Markdown)  │      │ via API     │
   │ (Vector)│         │  + Metadatos │      │             │
   └─────────┘         └──────────────┘      └─────────────┘
```

---

## 📚 Fuentes de Conocimiento

### 1. **Documentación de Contabilidad (Tutorial Quipu-style)**
```
docs/chatbot/knowledge-base/
├── 01_conceptos_basicos/
│   ├── asientos_contables.md
│   ├── iva_irpf.md
│   ├── facturas.md
│   ├── balance_pyg.md
│   └── tesoreria.md
├── 02_workflow_fiscalidad/
│   ├── factura_a_asiento.md
│   ├── libros_iva.md
│   ├── modelos_hacienda.md
│   └── cuadratura_balance.md
└── 03_escenarios_tipicos/
    ├── autonomo_iva_trimestral.md
    ├── pyme_iva_mensual.md
    ├── cambio_estado_factura.md
    └── correccion_errores.md
```

### 2. **Documentación de API & Producto**
```
docs/chatbot/product-docs/
├── feature_asientos.md
├── feature_balance_pyg.md
├── feature_libros_iva.md
├── feature_dashboard.md
├── ui_navigation.md
└── api_reference_summary.md
```

### 3. **Documentación Técnica (Resúmenes)**
```
docs/chatbot/tech-docs/
├── motor_contable_overview.md
├── flujo_factura_a_asiento.md
├── estados_asiento.md
└── validaciones_contables.md
```

### Ejemplo: `asientos_contables.md`
```markdown
# Asientos Contables - Concepto Básico

## ¿Qué es un asiento contable?

Un asiento es el registro de una operación contable siguiendo el 
principio de "partida doble": todo movimiento tiene un Debe y un Haber 
que siempre suman lo mismo.

### Ejemplo Real
Cuando creas una factura de venta de 1.000€ (más 210€ de IVA):

**Asiento automático generado:**
- DEBE: Clientes 1.210€
- HABER: Ventas 1.000€
- HABER: IVA Repercutido 210€

## Estados del Asiento

1. **DRAFT**: Recién creado, no afecta informes
2. **PENDING_REVIEW**: Esperando aprobación del usuario
3. **POSTED**: Aprobado, ya está en balance/PyG
4. **REVERSED**: Anulado (cuando se modifica factura)

## En la App

👉 Ve a **Contabilidad → Asientos** para ver todos
👉 Haz click en uno para ver líneas detalladas
👉 Si está en PENDING, usa botón **Aprobar** para confirmarlo

## Preguntas Frecuentes

**P: ¿Por qué veo "asiento pendiente de revisión"?**  
R: Porque la factura fue confirmada pero aún no aprobado 
contablemente. Es normal, revisa que los datos sean correctos 
y haz click en Aprobar.

**P: ¿Puedo editar un asiento POSTED?**  
R: No directamente. Debes modificar la factura, y el sistema 
creará un nuevo asiento automáticamente (el anterior se marca REVERSED).
```

---

## 🔧 Componentes Técnicos

### 1. **Indexador de Documentos (Backend)**

```typescript
// src/services/chatbot/document-indexer.ts

interface DocumentChunk {
  id: string;
  content: string;
  source: string;          // ej: "asientos_contables.md"
  section: string;         // ej: "Concepto Básico"
  tags: string[];          // ["concepto", "asiento", "pendiente"]
  metadata: {
    url?: string;          // Ruta en la app si aplica
    difficulty: 'basico' | 'intermedio' | 'avanzado';
    relatedTopics: string[];
  };
  embedding: number[];     // Vector de embeddings
}

export class DocumentIndexer {
  // 1. Cargar documentos Markdown
  async loadDocuments(folderPath: string): Promise<Document[]>
  
  // 2. Dividir en chunks
  async chunkDocuments(docs: Document[]): Promise<DocumentChunk[]>
  
  // 3. Generar embeddings
  async generateEmbeddings(chunks: DocumentChunk[]): Promise<DocumentChunk[]>
  
  // 4. Guardar en base de datos
  async storeChunks(chunks: DocumentChunk[]): Promise<void>
  
  // 5. Actualizar índice
  async rebuildIndex(): Promise<void>
}
```

### 2. **Sistema de Recuperación RAG (Backend)**

```typescript
// src/services/chatbot/rag-retriever.ts

export class RAGRetriever {
  // Buscar chunks relevantes
  async retrieve(
    query: string,
    topK: number = 5,
    filters?: {
      difficulty?: string;
      tags?: string[];
      source?: string;
    }
  ): Promise<DocumentChunk[]> {
    // 1. Generar embedding de la query
    // 2. Búsqueda por similitud coseno
    // 3. Aplicar filtros
    // 4. Devolver top K
  }
  
  // Mejorar contexto con información de la app
  async enrichContext(
    userId: string,
    companyId: string,
    currentPage?: string
  ): Promise<string> {
    // Agregar info del usuario y contexto actual
    // ej: "El usuario está en la página de Asientos"
  }
}
```

### 3. **Motor del Chatbot (Backend)**

```typescript
// src/services/chatbot/assistant-engine.ts

export class AssistantEngine {
  async chat(
    message: string,
    options: {
      userId: string;
      companyId: string;
      conversationId: string;
      currentPage?: string;
      language?: 'es' | 'en';
    }
  ): Promise<{
    response: string;
    sources: {
      title: string;
      snippet: string;
      source: string;
    }[];
    suggestions: string[];
  }> {
    // 1. Recuperar chunks relevantes
    const chunks = await this.ragRetriever.retrieve(message);
    
    // 2. Construir contexto
    const context = await this.buildContext(chunks, options);
    
    // 3. Llamar a Claude
    const response = await this.callClaude({
      systemPrompt: this.getSystemPrompt(options.currentPage),
      userMessage: message,
      context: context,
      conversationHistory: await this.getHistory(options.conversationId)
    });
    
    // 4. Guardar en base de datos
    await this.saveConversation(options.conversationId, {
      userMessage: message,
      assistantResponse: response,
      timestamp: new Date(),
      sources: chunks
    });
    
    // 5. Devolver con sugerencias
    return {
      response: response.text,
      sources: chunks.map(c => ({
        title: c.section,
        snippet: c.content.substring(0, 200),
        source: c.source
      })),
      suggestions: await this.generateSuggestions(message)
    };
  }
  
  private getSystemPrompt(currentPage?: string): string {
    // Personalizar según página actual
    if (currentPage === '/accounting/journal-entries') {
      return SYSTEM_PROMPT_ASIENTOS;
    }
    return SYSTEM_PROMPT_DEFAULT;
  }
}
```

### 4. **Endpoint de Chat (Backend)**

```typescript
// src/routes/chat-assistant.routes.ts

router.post('/chat-assistant', authMiddleware, async (req, res) => {
  const { message, context } = req.body;
  
  try {
    const response = await assistantEngine.chat(message, {
      userId: req.user.id,
      companyId: req.companyId,
      conversationId: req.body.conversationId || generateId(),
      currentPage: req.body.currentPage,
      language: req.query.lang || 'es'
    });
    
    res.json({
      success: true,
      data: response
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});
```

### 5. **Componente Chat Frontend (React)**

```typescript
// src/components/chatbot/ChatAssistant.tsx

export function ChatAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const { companyId } = useCompanyId();
  const { pathname } = useLocation();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    setLoading(true);
    
    // Agregar mensaje del usuario
    const userMessage: Message = {
      id: generateId(),
      role: 'user',
      content: input,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMessage]);

    try {
      // Llamar al backend
      const response = await fetch('/api/chat-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: input,
          currentPage: pathname,
          conversationId: conversationId // Guardar histórico
        })
      });

      const data = await response.json();

      // Agregar respuesta del asistente
      const assistantMessage: Message = {
        id: generateId(),
        role: 'assistant',
        content: data.data.response,
        sources: data.data.sources,
        suggestions: data.data.suggestions,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, assistantMessage]);

    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setLoading(false);
      setInput('');
    }
  };

  return (
    <Box h="600px" display="flex" flexDirection="column">
      {/* Área de mensajes */}
      <VStack flex={1} overflowY="auto" spacing={4} p={4}>
        {messages.map(msg => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        {loading && <Spinner />}
      </VStack>

      {/* Fuentes citadas */}
      {messages[messages.length - 1]?.sources && (
        <SourcesList sources={messages[messages.length - 1].sources} />
      )}

      {/* Sugerencias */}
      {messages[messages.length - 1]?.suggestions && (
        <SuggestionsList 
          suggestions={messages[messages.length - 1].suggestions}
          onSelect={setInput}
        />
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} p={4} borderTop="1px" borderColor="gray.200">
        <HStack>
          <Input
            placeholder="Pregunta algo..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <Button type="submit" isLoading={loading} colorScheme="blue">
            Enviar
          </Button>
        </HStack>
      </form>
    </Box>
  );
}
```

---

## 🔄 Flujo de Datos

```
Usuario escribe: "¿Dónde veo mis libros de IVA?"

                          ▼
          
        Frontend envía POST /api/chat-assistant
        {
          message: "¿Dónde veo mis libros de IVA?",
          currentPage: "/reports/vat-books",
          conversationId: "conv-123"
        }

                          ▼

        Backend - RAGRetriever.retrieve():
        - Generar embedding de la pregunta
        - Buscar 5 chunks más similares
        - Filtrar por tags: ["iva", "libros"]
        - Devolver chunks con fuentes

                          ▼

        Backend - AssistantEngine.chat():
        - Recuperar histórico de conversación
        - Construir contexto:
          * System prompt
          * Chunks recuperados
          * Información del usuario/empresa
          * Página actual: "Está en /reports/vat-books"
        
                          ▼

        Backend - Llamar Claude API:
        
        System prompt:
        "Eres un contable experto en la app X...
         El usuario está en la página de Libros de IVA..."
        
        Context (de RAG):
        "Chunk 1: Qué son los libros de IVA...
         Chunk 2: Cómo acceder en la app...
         Chunk 3: Diferencia emitidas/recibidas..."
        
        User message:
        "¿Dónde veo mis libros de IVA?"

                          ▼

        Claude genera respuesta:
        "Tienes dos libros de IVA:
        
        1. **Emitidas** (tus facturas a clientes):
           👉 Ve a **Reportes → Libros IVA → Emitidas**
        
        2. **Recibidas** (facturas de proveedores):
           👉 Ve a **Reportes → Libros IVA → Recibidas**
        
        Puedes filtrar por período (trimestral, mensual) 
        y exportar a CSV para tu gestión fiscal.
        
        ¿Te ayuda? ¿Quieres saber cómo exportarlos?"

                          ▼

        Backend devuelve:
        {
          response: "[respuesta arriba]",
          sources: [
            { title: "Libros de IVA", source: "iva_irpf.md", ... },
            { title: "En la App", source: "feature_libros_iva.md", ... }
          ],
          suggestions: [
            "¿Cómo exporto los libros de IVA?",
            "¿Qué diferencia hay entre emitidas y recibidas?"
          ]
        }

                          ▼

        Frontend renderiza:
        - Respuesta del asistente
        - "Fuentes citadas" (clickables)
        - Sugerencias de preguntas follow-up
```

---

## 💬 Prompt del Asistente

### System Prompt Base

```
Eres un CONTABLE y ECONOMISTA EXPERTO en:
- Contabilidad española (PGC, normativa fiscal)
- La aplicación de gestión contable FacturaScripts (nuestra app)

Tu misión es ayudar a usuarios que NO son expertos en contabilidad
a ENTENDER qué está pasando y SABER QUÉ HACER en la aplicación.

# REGLAS DE ORO

1. LENGUAJE SENCILLO
   - Evita jerga técnica innecesaria
   - Explica conceptos con ejemplos reales
   - Usa emojis para guiar visualmente (👉 ruta, 💡 consejo, ⚠️ alerta)

2. CITA FUENTES
   - Apoyate SIEMPRE en la documentación adjunta
   - Si algo no está en la documentación, dilo claramente:
     "No tengo información en mi base de datos sobre eso"
   - Indica la fuente cuando sea relevante

3. INDICA LA RUTA EN LA APP
   - Si la respuesta incluye acciones, sé específico:
     "Ve a Contabilidad → Asientos → Pendientes"
   - No digas solo "consulta los asientos", dí DÓNDE

4. PASO A PASO
   - Divide respuestas complejas en pasos numerados
   - Cada paso debe ser accionable

5. RECONOCE LÍMITES
   - Si necesita decisión fiscal real: "Deberías consultar con tu asesor"
   - Si es un bug: "Esto debería ser diferente, reportalo al equipo"

# CONTEXTO DE LA APP

## Flujo Factura → Asiento → Informes

1. Usuario crea FACTURA (ingreso o gasto)
2. Sistema genera ASIENTO CONTABLE automáticamente en estado DRAFT
3. Usuario REVISA el asiento
4. Usuario lo APRUEBA → pasa a POSTED
5. Asiento ya afecta BALANCE, PyG, LIBROS IVA

## Estados del Asiento

- DRAFT: Recién creado, no afecta informes
- PENDING_REVIEW: Esperando aprobación
- POSTED: Aprobado, afecta informes (DEFINITIVO)
- REVERSED: Marcado como reversado (por corrección de factura)

## Módulos Principales

- **Asientos**: Registro contable de operaciones
- **Balance**: Cúal es la situación patrimonial
- **PyG**: Cuánto has ganado o perdido
- **Libros IVA**: Registro fiscal de tus operaciones
- **Tesorería**: Flujo de caja y pagos
- **Modelos Hacienda**: 303 (IVA), 190 (Retenciones), etc.

# ESTILO DE RESPUESTA

```
# Pregunta del usuario: "¿Por qué veo un asiento pendiente?"

## Respuesta (estructura):

Buena pregunta. Un asiento "pendiente de revisión" es normal.

**¿Por qué aparece?**

Cuando confirmas una factura en la app, el sistema crea un asiento 
contable automáticamente. Este asiento empieza en estado "DRAFT" 
(borrador) porque está bien que lo revises antes de afectarlo 
todo tu contabilidad.

**¿Qué significa que esté "pendiente"?**

Simplemente que aún no ha sido APROBADO. No afecta tu balance ni 
tus informes hasta que lo apruebes.

**¿Qué hago ahora?**

1. Ve a **Contabilidad → Asientos**
2. Haz click en el asiento "Pendiente"
3. Revisa que los datos sean correctos
4. Click en botón **Aprobar**

¡Y listo! Ya está en tu contabilidad definitiva.

---

**💡 Consejo**: Es normal tener asientos pendientes. Es un control 
de calidad que te protege de errores.

**❓ ¿Necesitas ayuda con algo más?**
- "¿Cómo edito un asiento?"
- "¿Qué significa REVERSED?"
```

---

## 📋 Plan de Implementación

### Fase 1: Preparación (1-2 semanas)

- [ ] **Recopilar documentación**
  - Limpiar y estructurar docs de la app
  - Crear tutorial de contabilidad (basado en Quipu)
  - Documentar API endpoints
  - Crear "escenarios típicos" (autónomo, pyme, etc.)

- [ ] **Infraestructura de indexación**
  - Elegir proveedor de embeddings (OpenAI, Anthropic, local)
  - Montar base de datos de vectores (Pinecone, Weaviate, o local)
  - Crear script de indexación

### Fase 2: Backend (2-3 semanas)

- [ ] Implementar `DocumentIndexer`
- [ ] Implementar `RAGRetriever`
- [ ] Implementar `AssistantEngine`
- [ ] Crear endpoint `/api/chat-assistant`
- [ ] Guardar conversaciones en BD (para análisis)
- [ ] Tests del motor

### Fase 3: Frontend (1-2 semanas)

- [ ] Componente `ChatAssistant` (panel lateral)
- [ ] Componente `ChatMessage` (renderización)
- [ ] Componente `SourcesList` (citar fuentes)
- [ ] Componente `SuggestionsList` (preguntas follow-up)
- [ ] Integrar en layout principal
- [ ] Tests E2E

### Fase 4: Refinamiento (1 semana)

- [ ] Análisis de conversaciones (preguntas frecuentes)
- [ ] Mejorar documentación basado en datos reales
- [ ] Fine-tuning de prompts
- [ ] Performance optimization

---

## 💭 Ejemplos de Conversaciones

### Ejemplo 1: Usuario pregunta por asiento pendiente

```
Usuario: "¿Qué significa que mi asiento esté 'pendiente de revisión'?"

Asistente: 

Significa que la factura fue confirmada, pero el asiento contable
aún no ha sido **aprobado** por ti.

**¿Por qué está así?**

Es un mecanismo de control: cuando creas una factura, la app genera
automáticamente un asiento contable siguiendo las reglas del PGC 
español. Pero antes de que afecte tu contabilidad definitiva, debes 
revisarlo.

**¿Cómo aprobarlo?**

1. Ve a **Contabilidad → Asientos**
2. Busca tu asiento (busca por número de factura si lo prefieres)
3. Click en el asiento para ver sus líneas contables
4. Verifica que todo sea correcto
5. Click en botón **Aprobar**

**¿Qué pasa después?**

El asiento pasa a estado "POSTED" (contabilizado) y ya aparece en:
- Tu Balance General
- Tu Cuenta de Pérdidas y Ganancias
- Tus Libros de IVA (si tiene IVA)

---

**⚠️ Importante**: No puedes modificar un asiento POSTED directamente.
Si hay un error, debes modificar la factura → el sistema reversará
el asiento antiguo y creará uno nuevo.

**¿Preguntas related?**
- "¿Qué pasa si modifico una factura ya aprobada?"
- "¿Puedo borrar un asiento?"
```

### Ejemplo 2: Usuario pregunta sobre IRPF

```
Usuario: "He creado una factura con IRPF, ¿dónde veo el descuento?"

Asistente:

Buena pregunta. El IRPF (Impuesto sobre la Renta de las Personas 
Físicas) es una retención que aplica en ciertos servicios.

**¿Dónde ves el IRPF?**

En DOS lugares:

1. **En la factura original**
   - Cuando creaste la factura, deberías haber seleccionado 
     "Tipo de retención: IRPF" 
   - El importe neto ya viene reducido
   
2. **En el asiento contable**
   - Ve a **Contabilidad → Asientos**
   - El asiento tendrá 3 líneas:
     * DEBE: Cliente (importe neto, sin IRPF)
     * HABER: Ventas (el monto de servicio)
     * HABER: Retención IRPF (lo que le descuentas)

**¿Y el dinero que retuve?**

Lo guardas y lo declaras en modelo 190 (Retenciones de IRPF).
- Ve a **Reportes → Modelos 190**
- Verás el resumen de retenciones que has hecho

---

**💡 Ejemplo real**:
- Hiciste una factura de 1.000€ a un consultor con IRPF 19%
- La factura neta: 810€
- Tu asiento: DEBE Cliente 810€ | HABER Ventas 1.000€ | 
  HABER Ret. IRPF 190€

**¿Necesitas ayuda con la declaración del 190?**
```

---

## 🔍 Análisis y Mejora Continua

### Datos a Recopilar

```typescript
// Cada conversación se guarda con:
interface ChatConversation {
  id: string;
  userId: string;
  companyId: string;
  messages: {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
  }[];
  sourcesCited: string[];
  userSatisfaction?: 1 | 2 | 3 | 4 | 5; // Rating después de respuesta
  resolution: 'resolved' | 'partial' | 'not_helpful';
}
```

### Preguntas Frecuentes

Analizar después de 1 mes:
- "¿Cuáles son las 10 preguntas más frecuentes?"
- "¿Qué documentos se citan más?"
- "¿Dónde es más bajo el engagement?"

Usar esto para mejorar:
- Prioridad de documentación
- Ejemplos en prompts
- UI/UX del chat

---

## 🚀 Próximos Pasos

1. **Decidir proveedor LLM** (Claude, GPT-4, local)
2. **Preparar documentación** (estructura, limpiar)
3. **Elegir framework RAG** (LlamaIndex, LangChain, custom)
4. **Prototipo rápido** (indexar 5 docs, probar prompt)
5. **Validación con usuarios** (¿responde bien a preguntas reales?)

---

Este asistente puede ahorrarte mucho soporte manual y mejorar 
experiencia del usuario significativamente.
