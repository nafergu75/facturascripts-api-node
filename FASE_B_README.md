# 🚀 FASE B: Prototipo Rápido de Carmen

**Estado:** ✅ Implementado y Listo para Ejecutar  
**Fecha:** 13 de junio de 2026  
**Archivo Principal:** `prototype-carmen.js`

---

## 📋 ¿Qué es Fase B?

Un prototipo rápido que valida que Carmen funciona correctamente **sin infraestructura compleja**. 

Solo necesita:
- Node.js
- Clave de API de Claude (Anthropic)
- Documentos de ejemplo en memoria

**Tiempo de ejecución:** 5-10 minutos para 4 pruebas completas

---

## 🔧 Instalación y Setup

### Paso 1: Obtén tu Clave de API de Anthropic

1. Ve a: https://console.anthropic.com/account/keys
2. Click en **"Create Key"** (o copia una existente)
3. La clave comienza con `sk-ant-`
4. Cópiala (la necesitarás en el paso siguiente)

### Paso 2: Agrega la Clave al `.env`

Abre el archivo `.env` en la raíz del proyecto:

```bash
# Busca esta línea:
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Reemplaza con tu clave real:
ANTHROPIC_API_KEY=sk-ant-tu-clave-aqui-completa
```

**Ejemplo:**
```
ANTHROPIC_API_KEY=sk-ant-1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q
```

### Paso 3: Instala Dependencia (ya hecho)

```bash
npm install @anthropic-ai/sdk
```

---

## 🎯 Ejecutar Fase B

### Opción A: Ejecutar con clave en `.env`

```bash
node prototype-carmen.js
```

### Opción B: Ejecutar con clave en línea de comando

```bash
ANTHROPIC_API_KEY=tu-clave-aqui node prototype-carmen.js
```

### Salida Esperada

Carmen ejecutará **4 casos de prueba**:

```
╔════════════════════════════════════════════════╗
║  👩‍💼 CARMEN - Asistente Contable Experto        ║
║  Prototipo Rápido (Fase B)                     ║
║  Validación de 4 Casos de Prueba               ║
╚════════════════════════════════════════════════╝

════════════════════════════════════════════════════════════
Test 1: Asientos Pendientes
════════════════════════════════════════════════════════════

📝 Usuario pregunta:
"¿Qué significa que un asiento esté pendiente de revisión?"

🤔 Carmen está pensando...

👩‍💼 Carmen responde:

Un asiento pendiente de revisión es un registro contable que aún no 
ha sido aprobado. Esto es completamente normal...

[RESPUESTA COMPLETA]

✅ TEST PASADO - Contiene 4/4 palabras clave esperadas

════════════════════════════════════════════════════════════
...más tests...
════════════════════════════════════════════════════════════

📊 RESUMEN DE RESULTADOS
════════════════════════════════════════════════════════════

✅ Tests Pasados:  4/4
⚠️  Tests Fallidos: 0/4
📈 Tasa de Éxito:  100%

🎉 ¡FASE B VALIDADA EXITOSAMENTE!

👉 Próximo paso: Implementar Fase A (Backend RAG)
```

---

## 📝 Casos de Prueba (Fase B)

Carmen se prueba con **4 preguntas reales**:

### Test 1: Asientos Pendientes ✅
**Pregunta:** "¿Qué significa que un asiento esté pendiente de revisión?"

**Validación:** Carmen debe mencionar:
- Qué significa "pendiente"
- El estado PENDING_REVIEW
- Cómo aprobarlo
- La ruta en la app

---

### Test 2: IRPF y Retenciones ✅
**Pregunta:** "He creado una factura con IRPF. ¿Dónde veo la retención?"

**Validación:** Carmen debe mencionar:
- Qué es IRPF
- Dónde aparece en la app
- Modelo 190
- La ruta exacta

---

### Test 3: Libros de IVA ✅
**Pregunta:** "¿Cómo veo mis libros de IVA?"

**Validación:** Carmen debe mencionar:
- Diferencia entre emitidas y recibidas
- Cómo filtrar por período
- La ruta: Reportes → Libros IVA
- Exportación a CSV

---

### Test 4: Flujo Factura → Asiento ✅
**Pregunta:** "¿Qué pasa cuando confirmo una factura?"

**Validación:** Carmen debe explicar:
- Que se genera asiento automático
- Los estados DRAFT → PENDING_REVIEW → POSTED
- El flujo completo

---

## 🔍 Base de Conocimiento (Fase B)

Carmen tiene acceso a 4 documentos de ejemplo en memoria:

```javascript
KNOWLEDGE_BASE = {
  asientos:    // Conceptos, estados, ejemplos
  iva:         // IVA, libros, modelo 303
  irpf:        // IRPF, retenciones, modelo 190
  workflow:    // Flujo factura → asiento → informes
}
```

Estos documentos son **extractos reales** que luego se indexarán en Fase A.

---

## ✨ Características de Fase B

✅ **System Prompt Completo**  
   Carmen tiene el rol completo de contable + experto en app

✅ **Búsqueda de Contexto Básica**  
   Busca palabras clave en la pregunta para recuperar docs relevantes

✅ **Llamadas a Claude API**  
   Usa el modelo `claude-3-5-sonnet-20241022`

✅ **Validación Automática**  
   Verifica que las respuestas contengan palabras clave esperadas

✅ **Sin Infraestructura Compleja**  
   No hay base de datos, no hay indexación RAG, no hay embeddings

---

## 🚀 Próximo: Fase A (Backend RAG)

Una vez validada Fase B, pasamos a:

- Indexación de documentos (DocumentIndexer)
- Búsqueda semántica por similitud (RAGRetriever)
- Motor de chat con historial (AssistantEngine)
- Endpoint REST `/api/chat-assistant`
- Base de datos SQLite

---

## 🔗 Referencias

- **Plan Completo:** `CARMEN_IMPLEMENTATION_PLAN.md`
- **Código:** `prototype-carmen.js`
- **Diseño:** `CHATBOT_ASSISTANT_DESIGN.md`
- **System Prompt:** Incluido en `prototype-carmen.js` (línea ~13)

---

## ❓ Troubleshooting

### Error: "Could not resolve authentication method"

**Causa:** ANTHROPIC_API_KEY no está configurada

**Solución:**
1. Verifica que `.env` tiene `ANTHROPIC_API_KEY=sk-ant-...`
2. O ejecuta: `ANTHROPIC_API_KEY=tu-clave node prototype-carmen.js`

---

### Error: "Module not found: @anthropic-ai/sdk"

**Solución:**
```bash
npm install @anthropic-ai/sdk
```

---

### La respuesta de Carmen es muy corta

**Causa:** Token limit o API request incompleto

**Solución:** Asegúrate de que la clave es válida (no de prueba)

---

## 📊 Métricas de Éxito (Fase B)

| Métrica | Esperado | Validación |
|---------|----------|-----------|
| Tests pasados | 4/4 | Todos deben pasar |
| Palabras clave encontradas | 3/4+ | Carmen menciona conceptos correctos |
| Tasa de éxito | 100% | Fase B validada |
| Tiempo ejecución | <10 min | Rápido para prototipo |

---

## ✅ Fase B Completada

Cuando veas:

```
🎉 ¡FASE B VALIDADA EXITOSAMENTE!

👉 Próximo paso: Implementar Fase A (Backend RAG)
```

**Entonces:**
- Prototipo está funcionando ✓
- Carmen responde correctamente ✓
- Ready para Fase A ✓

---

**¡Listo para empezar!**

Ejecuta: `node prototype-carmen.js`
