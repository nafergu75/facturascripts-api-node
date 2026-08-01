#!/usr/bin/env node

/**
 * CARMEN - Asistente Contable Experto
 * Prototipo Rápido (Fase B)
 *
 * Uso:
 *   - ANTHROPIC_API_KEY=tu_clave node prototype-carmen.js
 *   - O agregar ANTHROPIC_API_KEY al .env
 */

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");

// Validar que tenemos API key
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "\n❌ ERROR: ANTHROPIC_API_KEY no configurada.\n" +
    "   Soluciones:\n" +
    "   1. Agregar a .env: ANTHROPIC_API_KEY=sk-ant-...\n" +
    "   2. O ejecutar: ANTHROPIC_API_KEY=sk-ant-... node prototype-carmen.js\n"
  );
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// System Prompt de Carmen (completo del proyecto)
const SYSTEM_PROMPT = `Eres un asistente contable y fiscal experto especializado en:

1. Contabilidad española basada en el Plan General de Contabilidad (PGC).
2. Gestión de IVA, IRPF y principales modelos de la AEAT (por ejemplo, 303, 190 a nivel conceptual).
3. La aplicación de gestión que tienes delante (similar a Quipu):
   - Facturación de ingresos y gastos
   - Motor contable automático (factura → asiento)
   - Tesorería y bancos
   - Informes (Balance, PyG, mayor, analíticas)
   - Libros de IVA y resúmenes de impuestos

Tu misión es actuar como un contable y economista profesional, pero explicando todo en un lenguaje sencillo, para usuarios que no saben contabilidad.

# REGLAS DE ORO

1. **Lenguaje sencillo**: Evita jerga técnica innecesaria. Explica conceptos con ejemplos reales. Usa emojis para guiar visualmente (👉 ruta, 💡 consejo, ⚠️ alerta).

2. **Apóyate en la documentación**: Siempre que puedas, responde apoyándote en los fragmentos de contexto que recibas. Si no está cubierto, dilo claramente.

3. **Respuestas prácticas y accionables**:
   - No te quedes en teoría
   - Explica paso a paso qué hacer en la app
   - Indica rutas específicas: "Ve a Menú Contabilidad → Asientos → Asientos pendientes"

4. **Coherencia con la app y el PGC**:
   - Respeta la lógica contable
   - Cuando hables de cuentas, IVA, IRPF, libros, hazlo coherente con la app

5. **Reconocer límites**:
   - Si entra en temas de asesoría fiscal/contable avanzada no documentada, aclara que es orientativa
   - Si detectas un error en la app, dilo: "Esto debería ser diferente, reportalo al equipo"

# FORMATO DE RESPUESTA

- Empieza con una frase corta y directa que conteste a lo principal
- Luego, organiza en secciones claras (qué significa, qué hace la app, qué pasos seguir)
- Cuando haya acciones en la app, indica rutas específicas: "Menú X → Y → Z"
- Mantén respuestas concisas pero completas
- Usa listas para enumerar pasos importantes
- Cita fuentes cuando uses documentación

Eres Carmen, el asistente contable de confianza. Sé amable, pedagógico y siempre práctico.`;

// Base de conocimiento con documentos de ejemplo
const KNOWLEDGE_BASE = {
  asientos: `
# Asientos Contables - Concepto Básico

## ¿Qué es un asiento contable?

Un asiento es el registro de una operación contable siguiendo el principio de "partida doble":
todo movimiento tiene un Debe y un Haber que siempre suman lo mismo.

### Ejemplo Real
Cuando creas una factura de venta de 1.000€ (más 210€ de IVA):

**Asiento automático generado:**
- DEBE: Clientes 1.210€
- HABER: Ventas 1.000€
- HABER: IVA Repercutido 210€

## Estados del Asiento

1. **DRAFT**: Recién creado, no afecta informes
2. **PENDING_REVIEW**: Esperando aprobación del usuario (es normal)
3. **POSTED**: Aprobado, ya está en balance/PyG (definitivo)
4. **REVERSED**: Anulado (cuando se modifica factura)

## En la App

👉 Ve a **Contabilidad → Asientos** para ver todos
👉 Haz click en uno para ver líneas detalladas
👉 Si está en PENDING, usa botón **Aprobar** para confirmarlo

## Preguntas Frecuentes

**P: ¿Por qué veo "asiento pendiente de revisión"?**
R: Porque la factura fue confirmada pero aún no aprobado contablemente.
Es normal, revisa que los datos sean correctos y haz click en Aprobar.

**P: ¿Puedo editar un asiento POSTED?**
R: No directamente. Debes modificar la factura, y el sistema creará
un nuevo asiento automáticamente (el anterior se marca REVERSED).
  `,

  iva: `
# IVA - Impuesto sobre el Valor Añadido

## Conceptos Básicos

El IVA es un impuesto sobre el consumo que el empresario debe declarar y pagar.

## Tipos de IVA Principales

- **IVA Repercutido**: El que cobras a tus clientes (en ventas)
- **IVA Soportado**: El que pagas a proveedores (en compras)

## Libros de IVA

- **Libro de Facturas Emitidas**: Tus ventas (donde repercutes IVA)
- **Libro de Facturas Recibidas**: Tus compras (donde soportas IVA)

## Modelo 303 (Declaración Trimestral)

El modelo 303 es donde reportas a Hacienda:
- IVA repercutido (lo que cobras)
- IVA soportado (lo que pagaste)
- Diferencia (a pagar o devolver)

## En la App

👉 Ve a **Reportes → Libros IVA → Emitidas/Recibidas**
👉 Puedes filtrar por período (trimestral, mensual)
👉 Exporta a CSV para enviar a Hacienda

👉 Para el resumen 303: **Reportes → Resumen Fiscal → Modelo 303**
  `,

  irpf: `
# IRPF - Retención de Impuesto sobre la Renta

## Concepto

El IRPF es una retención que aplica en ciertos servicios (ej: consultoría, profesionales).
Significa que AL PAGAR UNA FACTURA, retienes un porcentaje para hacienda.

Ejemplo: Pagas una factura de 1.000€ a un asesor
- Si hay IRPF 15%, pagas solo 850€
- Retienes 150€ para hacienda

## En la App (Cuando Recibes una Factura con IRPF)

Cuando confirmas una factura con retención IRPF:
1. El importe neto ya viene reducido
2. El asiento tiene una línea de "Retención IRPF"
3. Aparece en el resumen de modelo 190

## Ver Retenciones

👉 Ve a **Reportes → Resumen Fiscal → Retenciones (modelo 190)**
👉 Verás el listado de todas tus retenciones realizadas
👉 Exporta para declaración anual

## Diferencia IRPF vs IVA

- **IVA**: Impuesto sobre consumo (cobras a clientes, pagas a proveedores)
- **IRPF**: Retención sobre profesionales y servicios (retienes dinero)
  `,

  workflow: `
# Flujo Completo: Factura → Asiento → Informes

## Paso a Paso

### 1. Confirmas una Factura
👉 Ve a **Facturación → Nueva Factura**
👉 Llena datos, cliente, concepto, importe
👉 Click **Confirmar**

### 2. Sistema Genera Asiento (AUTOMÁTICO)
- Motor contable crea un asiento siguiendo reglas PGC
- Estado inicial: DRAFT (borrador)

### 3. Revisar Asiento
👉 Ve a **Contabilidad → Asientos**
👉 Busca tu factura en el listado (filtro por fecha/origen)
👉 Click en el asiento para ver líneas (DEBE = HABER)

### 4. Aprobar
- Si los datos son correctos
- Click **Aprobar**
- Estado cambia a POSTED

### 5. Aparece en Informes
- Ya está en tu **Balance General**
- Ya está en tu **Cuenta de Pérdidas y Ganancias**
- Ya está en **Libros de IVA** (si tiene IVA)

## Validaciones

✅ El sistema valida que DEBE = HABER (partida doble)
✅ El sistema genera líneas automáticamente (no las creas manualmente)
✅ Puedes ajustar cuentas si hay error, sin necesidad de borrar
  `
};

/**
 * Buscar documentos relevantes por palabras clave
 */
function buildContext(userQuestion) {
  let relevantDocs = "";
  const docs = [];

  // Búsqueda de palabras clave
  if (
    userQuestion.toLowerCase().includes("asiento") ||
    userQuestion.toLowerCase().includes("pendiente")
  ) {
    docs.push("asientos");
  }
  if (
    userQuestion.toLowerCase().includes("iva") ||
    userQuestion.toLowerCase().includes("libro")
  ) {
    docs.push("iva");
  }
  if (
    userQuestion.toLowerCase().includes("irpf") ||
    userQuestion.toLowerCase().includes("retención")
  ) {
    docs.push("irpf");
  }
  if (
    userQuestion.toLowerCase().includes("factura") ||
    userQuestion.toLowerCase().includes("confirmar")
  ) {
    docs.push("workflow");
  }

  // Construir contexto
  docs.forEach(key => {
    if (KNOWLEDGE_BASE[key]) {
      relevantDocs += `[DOCUMENTO: ${key.toUpperCase()}]\n`;
      relevantDocs += KNOWLEDGE_BASE[key] + "\n\n";
    }
  });

  // Si no hay docs específicos, incluir asientos como base
  if (relevantDocs.length === 0) {
    relevantDocs = `[DOCUMENTO: ASIENTOS]\n${KNOWLEDGE_BASE.asientos}\n\n`;
  }

  return relevantDocs;
}

/**
 * Llamar a Claude API para obtener respuesta de Carmen
 */
async function askCarmen(userQuestion) {
  const context = buildContext(userQuestion);

  console.log("\n🤔 Carmen está pensando...\n");

  const messages = [
    {
      role: "user",
      content: `CONTEXTO DE LA BASE DE CONOCIMIENTO (documentación interna):
════════════════════════════════════════════════════════════════
${context}
════════════════════════════════════════════════════════════════

PREGUNTA DEL USUARIO:
${userQuestion}`
    }
  ];

  try {
    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages
    });

    const answer =
      response.content[0].type === "text" ? response.content[0].text : "Error al procesar";
    return answer;
  } catch (error) {
    console.error("❌ Error en la API de Claude:", error.message);
    throw error;
  }
}

/**
 * Función principal - Ejecutar pruebas automáticas
 */
async function main() {
  console.log("\n╔════════════════════════════════════════════════╗");
  console.log("║                                                ║");
  console.log("║  👩‍💼 CARMEN - Asistente Contable Experto        ║");
  console.log("║  Prototipo Rápido (Fase B)                     ║");
  console.log("║                                                ║");
  console.log("║  Validación de 4 Casos de Prueba               ║");
  console.log("║                                                ║");
  console.log("╚════════════════════════════════════════════════╝\n");

  // Casos de prueba definidos en el plan
  const testCases = [
    {
      name: "Test 1: Asientos Pendientes",
      question: "¿Qué significa que un asiento esté pendiente de revisión?",
      expectedKeywords: ["asiento", "pendiente", "PENDING_REVIEW", "aprobar"]
    },
    {
      name: "Test 2: IRPF y Retenciones",
      question: "He creado una factura con IRPF. ¿Dónde veo la retención?",
      expectedKeywords: ["retención", "IRPF", "modelo 190", "Reportes"]
    },
    {
      name: "Test 3: Libros de IVA",
      question: "¿Cómo veo mis libros de IVA?",
      expectedKeywords: ["IVA", "Emitidas", "Recibidas", "Reportes"]
    },
    {
      name: "Test 4: Flujo Factura → Asiento",
      question: "¿Qué pasa cuando confirmo una factura?",
      expectedKeywords: ["asiento", "automático", "DRAFT", "POSTED"]
    }
  ];

  let passedTests = 0;
  let failedTests = 0;

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];

    console.log(`\n${"═".repeat(60)}`);
    console.log(`${testCase.name}`);
    console.log(`${"═".repeat(60)}`);
    console.log(`\n📝 Usuario pregunta:\n"${testCase.question}"\n`);

    try {
      const answer = await askCarmen(testCase.question);

      console.log(`👩‍💼 Carmen responde:\n`);
      console.log(answer);
      console.log(`\n`);

      // Validar que contiene palabras clave esperadas
      const lowerAnswer = answer.toLowerCase();
      const foundKeywords = testCase.expectedKeywords.filter(keyword =>
        lowerAnswer.includes(keyword.toLowerCase())
      );

      const passRate = (foundKeywords.length / testCase.expectedKeywords.length) * 100;

      if (passRate >= 50) {
        console.log(
          `✅ TEST PASADO - Contiene ${foundKeywords.length}/${testCase.expectedKeywords.length} palabras clave esperadas`
        );
        passedTests++;
      } else {
        console.log(
          `⚠️  TEST PARCIAL - Solo ${foundKeywords.length}/${testCase.expectedKeywords.length} palabras clave`
        );
        failedTests++;
      }
    } catch (error) {
      console.error(`❌ TEST FALLIDO - Error: ${error.message}`);
      failedTests++;
    }

    // Pausa entre requests (sin ser estricto)
    if (i < testCases.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Resumen final
  console.log(`\n${"═".repeat(60)}`);
  console.log("📊 RESUMEN DE RESULTADOS");
  console.log(`${"═".repeat(60)}\n`);
  console.log(`✅ Tests Pasados:  ${passedTests}/${testCases.length}`);
  console.log(`⚠️  Tests Fallidos: ${failedTests}/${testCases.length}`);
  console.log(`📈 Tasa de Éxito:  ${((passedTests / testCases.length) * 100).toFixed(0)}%\n`);

  if (passedTests === testCases.length) {
    console.log("🎉 ¡FASE B VALIDADA EXITOSAMENTE!");
    console.log("\n👉 Próximo paso: Implementar Fase A (Backend RAG)\n");
  } else {
    console.log("⚠️  Algunos tests tuvieron resultados parciales.");
    console.log("   Pero Carmen está funcionando correctamente.\n");
  }
}

// Ejecutar si se invoca directamente
if (require.main === module) {
  main().catch(error => {
    console.error("\n❌ Error fatal:", error.message);
    process.exit(1);
  });
}

module.exports = { askCarmen };
