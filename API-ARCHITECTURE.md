# 🏗️ Arquitectura de conta-api — Análisis Completo

**Fecha:** 2026-06-30  
**Propósito:** Mapeo arquitectónico, análisis de diseño y recomendaciones de usabilidad

---

## A. MAPA DE LA API

### 📍 Estructura de Archivos

```
src/
├── index.ts                      # Punto de entrada
├── app.ts                        # Express setup + middlewares
├── config/
│   ├── env.ts                    # Variables de entorno
│   ├── database.ts               # Prisma connection
│   └── logger.ts                 # Logger
├── routes/
│   ├── index.ts                  # Router agregador
│   ├── auth.routes.ts
│   ├── income-reader.routes.ts
│   ├── accounting-engine.routes.ts
│   ├── impuestosModulo.routes.ts
│   ├── registroMercantil.routes.ts
│   ├── chatAssistant.routes.ts
│   └── ... (34 routers totales)
├── controllers/               # Controladores por módulo
├── services/                  # Lógica de negocio
├── middleware/                # Auth, CORS, logging
├── utils/
│   ├── response.ts            # sendOk, sendMessage
│   ├── http-errors.ts         # badRequest, unauthorized, etc
│   └── async-handler.ts       # Wrapper para try/catch
└── docs/
    ├── swagger.ts             # Setup Swagger UI
    └── openapi.json           # Spec OpenAPI
```

### 🎯 Módulos Principales (34 routers)

#### 1️⃣ **AUTENTICACIÓN & SEGURIDAD**

```
POST   /auth/login                 → Autenticar usuario (email/password)
POST   /auth/logout                → Cerrar sesión
POST   /auth/refresh               → Renovar JWT
POST   /auth/dev-login             → Login de desarrollo (localhost)
GET    /auth/health                → Healthcheck
```

**Características:**
- JWT + refreshToken
- Dev-login para desarrollo local
- Auditoría de acceso integrada

---

#### 2️⃣ **LECTOR DE FACTURAS (Income Reader)**

```
POST   /companies/:companyId/income-reader/web-upload        → Subir desde web
POST   /companies/:companyId/income-reader/mobile-upload     → Subir desde móvil
POST   /companies/:companyId/income-reader/email-hook        → Webhook de email
GET    /companies/:companyId/income-reader/pending           → Listar pendientes
GET    /companies/:companyId/income-reader/:id               → Obtener factura
PUT    /companies/:companyId/income-reader/:id               → Actualizar
POST   /companies/:companyId/income-reader/:id/verify        → Verificar
POST   /companies/:companyId/income-reader/:id/reject        → Rechazar
GET    /companies/:companyId/income-reader/config            → Configuración
POST   /companies/:companyId/income-reader/config            → Guardar config
```

**Flujo:**
1. Subir PDF/imagen
2. OCR con Claude (vision)
3. Parsear XML Facturae si es necesario
4. Guardar datos estructurados
5. Usuario verifica/rechaza
6. Registrar en contabilidad

**Estados:** UPLOADED → READY_FOR_VERIFICATION → VERIFIED/REJECTED

---

#### 3️⃣ **MOTOR DE CONTABILIZACIÓN (Accounting Engine)**

```
POST   /companies/:companyId/accounting/contabilizar/:invoiceId
       → Contabilizar factura automáticamente

GET    /companies/:companyId/accounting/journal-entries
       → Listar asientos contables

GET    /companies/:companyId/accounting/journal-entries/:journalEntryId
       → Obtener asiento con detalle y validaciones

POST   /companies/:companyId/accounting/journal-entries/:journalEntryId/approve
       → Aprobar asiento (PENDING_REVIEW → POSTED)

POST   /companies/:companyId/accounting/journal-entries/:journalEntryId/recalculate
       → Recalcular asiento (si factura fue modificada)

PATCH  /companies/:companyId/accounting/journal-entries/:journalEntryId/lines/:lineId
       → Ajustar línea de asiento (cambiar cuenta, debe/haber)
```

**Estados Asiento:** DRAFT → PENDING_REVIEW → POSTED → REVERSED

---

#### 4️⃣ **MÓDULO DE IMPUESTOS (Modelos AEAT)**

```
GET    /companies/:companyId/impuestos/modelos
       → Listar modelos (303, 347, 349, 390, etc.)

GET    /companies/:companyId/impuestos/modelos/:modeloId
       → Obtener modelo con casillas

PUT    /companies/:companyId/impuestos/modelos/:modeloId
       → Actualizar manualmente

POST   /companies/:companyId/impuestos/modelos/:modeloId/recalcular
       → Recalcular desde facturas

POST   /companies/:companyId/impuestos/modelos/:modeloId/pdf
       → Generar PDF (PDF/A archivable)

GET    /companies/:companyId/impuestos/modelos/:modeloId/pdf
       → Descargar PDF

POST   /companies/:companyId/impuestos/modelos/:modeloId/listo-para-presentar
       → Marcar como listo

POST   /companies/:companyId/impuestos/modelos/:modeloId/recalcular
       → Recalcular si cambió algo

GET    /companies/:companyId/impuestos/ingresos-gastos/excel
       → Export Excel de ingresos/gastos
```

**Generación:** Automática desde facturas contabilizadas

---

#### 5️⃣ **REGISTRO MERCANTIL**

```
GET    /fiscal-years/:fyId/books                    → Listar libros
POST   /fiscal-years/:fyId/books/generate           → Generar libros (Diario, Inventarios, etc.)
GET    /books/:bookId/download                      → Descargar PDF/A

GET    /fiscal-years/:fyId/annual-accounts          → Listar cuentas anuales
POST   /fiscal-years/:fyId/annual-accounts/generate → Generar cuentas
GET    /annual-accounts/:id/download                → Descargar

POST   /fiscal-years/:fyId/close                    → Cerrar ejercicio
GET    /fiscal-years/:fyId/deadlines                → Plazos legales

POST   /fiscal-years/:fyId/legalization-package     → Crear expediente legalización
POST   /legalization-packages/:packageId/diligence  → Subir diligencia (firma)
GET    /legalization-packages/:packageId/download   → Descargar expediente
```

**Formatos:** PDF/A (archivable), XML si aplica

---

#### 6️⃣ **REPORTES FINANCIEROS**

```
GET    /companies/:companyId/reports/balance
GET    /companies/:companyId/reports/profit-and-loss
GET    /companies/:companyId/reports/ledger          → Mayor de cuenta
GET    /companies/:companyId/reports/income
GET    /companies/:companyId/reports/expenses
GET    /companies/:companyId/reports/vat             → IVA
GET    /companies/:companyId/reports/retentions      → Retenciones
GET    /companies/:companyId/reports/treasury        → Tesorería
GET    /companies/:companyId/reports/analytics/monthly
GET    /companies/:companyId/reports/analytics/by-customer
```

**Parámetros:** `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `year=2026`

---

#### 7️⃣ **CARMEN — Chatbot de Asistencia**

```
POST   /companies/:companyId/chat-assistant/
       → Enviar mensaje a Carmen

GET    /companies/:companyId/chat-assistant/:sessionId/messages
       → Obtener historial de sesión
```

**Capacidades:**
- Sugerencias de contabilización
- Respuestas sobre FAQ
- Búsqueda en base de conocimientos local

---

#### 8️⃣ **DATOS MAESTROS**

```
GET    /companies/:companyId/clientes/               → Listar clientes
POST   /companies/:companyId/clientes/               → Crear cliente
GET    /companies/:companyId/clientes/:id
PUT    /companies/:companyId/clientes/:id
DELETE /companies/:companyId/clientes/:id
GET    /companies/:companyId/clientes/buscar

GET    /companies/:companyId/proveedores/            → Proveedores (igual patrón)
GET    /companies/:companyId/productos/              → Productos
GET    /companies/:companyId/series/                 → Series de documentos
GET    /companies/:companyId/periodos/               → Períodos contables
GET    /companies/:companyId/plan-contable/          → Plan de cuentas
GET    /companies/:companyId/bancos/                 → Gestión bancaria
```

---

#### 9️⃣ **ADMINISTRACIÓN**

```
GET    /companies/                                   → Listar empresas
POST   /companies/                                   → Crear empresa
GET    /companies/:id
PUT    /companies/:id
DELETE /companies/:id

GET    /users/                                       → Listar usuarios (global)
POST   /users/
GET    /users/:id
PUT    /users/:id
DELETE /users/:id

GET    /admin/empresas                               → Admin: gestión multiempresa
POST   /admin/usuarios
POST   /admin/usuarios/:userId/empresas/:companyId  → Asignar empresa a usuario
```

---

## B. CÓMO SE USA EN LA PRÁCTICA

### 📝 Ejemplo 1: Flujo de Lector de Facturas

**Cliente:** App móvil sube foto de factura

```bash
# 1️⃣ SUBIR FACTURA (desde móvil)
POST /api/companies/company-1/income-reader/mobile-upload HTTP/1.1
Content-Type: multipart/form-data; boundary=----WebKitFormBoundary

------WebKitFormBoundary
Content-Disposition: form-data; name="file"; filename="factura.jpg"
Content-Type: image/jpeg

[BINARY IMAGE DATA]
------WebKitFormBoundary--
```

**Respuesta (HTTP 200):**
```json
{
  "ok": true,
  "data": {
    "id": "doc-12345",
    "nombreArchivo": "factura.jpg",
    "estado": "UPLOADED",
    "createdAt": "2026-06-30T10:15:00Z",
    "usuario": {
      "id": "user-1",
      "email": "vendedor@empresa.com"
    }
  }
}
```

---

```bash
# 2️⃣ LECTOR PROCESA EN BACKGROUND
# Claude vision OCR → ParsedInvoiceData
# Cliente puede polling: GET /api/companies/company-1/income-reader/:id
```

**Respuesta (después de OCR):**
```json
{
  "ok": true,
  "data": {
    "id": "doc-12345",
    "estado": "READY_FOR_VERIFICATION",
    "documentoExtraido": {
      "nifEmisor": "B12345678",
      "nombreEmisor": "Proveedor ABC",
      "numero": "FAC-2024-001",
      "fecha": "2026-06-20",
      "baseImponible": 1000.00,
      "totalIva": 210.00,
      "total": 1210.00,
      "confianza": 0.95,
      "ocrEstado": "OK"
    }
  }
}
```

---

```bash
# 3️⃣ USUARIO VERIFICA EN CHAKRA
POST /api/companies/company-1/income-reader/doc-12345/verify HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "correcta": true,
  "cambios": {}
}
```

**Respuesta:**
```json
{
  "ok": true,
  "data": {
    "id": "doc-12345",
    "estado": "VERIFIED",
    "contabilizadoEn": "je-456",
    "asiento": {
      "id": "je-456",
      "estado": "PENDING_REVIEW",
      "lineas": [
        {
          "cuenta": "400",
          "descripcion": "Proveedor ABC - FAC-2024-001",
          "debe": 1210.00,
          "haber": 0
        },
        {
          "cuenta": "600",
          "descripcion": "Compras - Proveedor ABC",
          "debe": 0,
          "haber": 1000.00
        },
        {
          "cuenta": "472",
          "descripcion": "IVA Soportado",
          "debe": 0,
          "haber": 210.00
        }
      ]
    }
  }
}
```

---

### 📝 Ejemplo 2: Contabilización Manual + Aprobación

**Escenario:** Usuario genera asiento manualmente en Chakra

```bash
# 1️⃣ CONTABILIZAR FACTURA
POST /api/companies/company-1/accounting/contabilizar/invoice-789 HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/x-www-form-urlencoded

tipo=INGRESO&mode=AUTO
```

**Respuesta:**
```json
{
  "ok": true,
  "data": {
    "journalEntryId": "je-789",
    "estado": "PENDING_REVIEW",
    "advertencias": [
      "Cliente sin cuenta asignada: usar 430 (genérica)"
    ]
  }
}
```

---

```bash
# 2️⃣ OBTENER DETALLE DEL ASIENTO (para revisión)
GET /api/companies/company-1/accounting/journal-entries/je-789 HTTP/1.1
Authorization: Bearer eyJhbGc...
```

**Respuesta:**
```json
{
  "ok": true,
  "data": {
    "asiento": {
      "id": "je-789",
      "estado": "PENDING_REVIEW",
      "fecha": "2026-06-30",
      "referencia": "VENTA-2026-001"
    },
    "lineas": [
      {
        "id": "jel-1",
        "cuenta": "430",
        "descripcion": "Clientes",
        "debe": 5000,
        "haber": 0
      },
      {
        "id": "jel-2",
        "cuenta": "700",
        "descripcion": "Ventas",
        "debe": 0,
        "haber": 4132
      },
      {
        "id": "jel-3",
        "cuenta": "477",
        "descripcion": "IVA Repercutido",
        "debe": 0,
        "haber": 868
      }
    ],
    "validaciones": {
      "cuadrado": true,
      "errores": [],
      "advertencias": []
    },
    "permitidoAprobar": true
  }
}
```

---

```bash
# 3️⃣ APROBAR ASIENTO
POST /api/companies/company-1/accounting/journal-entries/je-789/approve HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "observaciones": "Revisado y correcto"
}
```

**Respuesta:**
```json
{
  "ok": true,
  "data": {
    "journalEntryId": "je-789",
    "estado": "POSTED",
    "contabilizadoEn": "2026-06-30T14:30:00Z"
  }
}
```

---

### 📝 Ejemplo 3: Generar Modelo de Impuestos (303)

**Escenario:** Período Q2 2026, generar declaración IVA

```bash
# 1️⃣ LISTAR MODELOS DEL PERÍODO
GET /api/companies/company-1/impuestos/modelos HTTP/1.1
Authorization: Bearer eyJhbGc...
```

**Respuesta:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "modelo-303-2026-q2",
      "codigo": "303",
      "ejercicio": 2026,
      "periodo": "Q2",
      "estado": "DRAFT",
      "casillas": {
        "300": 10000.00,  // Total facturas emitidas
        "301": 2100.00,   // IVA repercutido
        "310": 5000.00,   // Total compras
        "311": 1050.00    // IVA soportado
      },
      "cuotaAIngresar": 1050.00
    }
  ]
}
```

---

```bash
# 2️⃣ RECALCULAR (automático desde facturas)
POST /api/companies/company-1/impuestos/modelos/modelo-303-2026-q2/recalcular HTTP/1.1
Authorization: Bearer eyJhbGc...
```

**Respuesta:** Actualiza casillas automáticamente desde journal entries contabilizados

```json
{
  "ok": true,
  "data": {
    "id": "modelo-303-2026-q2",
    "estado": "READY",
    "casillas": {
      "300": 15000.00,  // Actualizado
      "301": 3150.00,   // Actualizado
      ...
    }
  }
}
```

---

```bash
# 3️⃣ GENERAR PDF (PDF/A archivable)
POST /api/companies/company-1/impuestos/modelos/modelo-303-2026-q2/pdf HTTP/1.1
Authorization: Bearer eyJhbGc...
```

**Respuesta:** Descargable directamente o accesible via GET

```
HTTP 200 Content-Type: application/pdf
[PDF/A BINARY DATA]
```

---

### 📝 Ejemplo 4: Carmen Chatbot

**Escenario:** Usuario pregunta sobre sugerencia de cuenta

```bash
# 1️⃣ ENVIAR PREGUNTA
POST /api/companies/company-1/chat-assistant/ HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "message": "¿Qué cuenta uso para compra de tinta de impresora?"
}
```

**Respuesta:**
```json
{
  "ok": true,
  "data": {
    "sessionId": "sess-abc123",
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "content": "¿Qué cuenta uso para compra de tinta de impresora?"
      },
      {
        "id": "msg-2",
        "role": "assistant",
        "content": "Para compra de tinta de impresora, debes usar:\n\n**Cuenta 625**: Reparación y conservación de bienes corporales\nO\n**Cuenta 622**: Reparaciones y conservación del inmovilizado material\n\nSi es material consumible, podría ser:\n**Cuenta 602**: Compras de otros suministros\n\nDepende si lo consideras gasto o material de oficina."
      }
    ]
  }
}
```

---

## C. DISEÑO Y USABILIDAD

### ✅ FORTALEZAS

1. **Separación Clara de Responsabilidades**
   - Routers → Controllers → Services
   - Middleware bien posicionado (auth, CORS, logging)
   - Cada módulo es independiente

2. **Manejo Consistente de Errores**
   ```
   - asyncHandler: try/catch automático
   - sendOk / sendMessage: respuestas uniformes
   - http-errors: códigos HTTP estándar
   ```

3. **Auditoría Integrada**
   - Cada acción importante llama `registrarAuditoria`
   - Rastreo de usuario, empresa, recurso, metadatos
   - Útil para compliance

4. **Multi-formato en Uploads**
   - Multipart (multer)
   - Binario crudo
   - JSON con Base64
   - Flexible para clientes diversos

5. **Respuestas Estructuradas**
   ```json
   { ok: boolean, data: T, message?: string }
   ```
   - Predictible
   - Fácil de parsear en clientes

6. **Documentación Swagger**
   - `/docs` activo
   - OpenAPI JSON generado

7. **Scopes y Roles**
   - `authorize('contabilidad:write')` explícito
   - JWT + empresa (multi-tenant)

---

### ⚠️ PUNTOS MEJORABLES

#### 1. **Inconsistencia en Rutas: Scoping**

**Problema:**
```
INCONSISTENTE:
GET /companies/:companyId/clientes              ← Scoped
GET /annual-accounts/:id/download               ← NO scoped

GET /fiscal-years/:fyId/books                   ← NO scoped (pero usa fyId)
GET /companies/:companyId/impuestos/modelos     ← Scoped
```

**Mejor:** Todas las rutas de usuario deberían seguir `/{recurso}` o `/companies/:companyId/{recurso}`

---

#### 2. **Falta de Paginación Explícita**

**Problema:**
```
GET /companies/:companyId/clientes/
→ Retorna TODA la lista sin límite
```

**Mejor:**
```
GET /companies/:companyId/clientes?limit=20&offset=0
→ { data: [...], total: 1000, hasMore: true }
```

---

#### 3. **Respuestas sin Tipado en Cliente**

**Problema:**
- Swagger documenta algunos endpoints, pero no todos (34 routers)
- Clientes TypeScript no tienen tipos generados

**Mejor:**
- Generar OpenAPI spec completo
- Usar OpenAPI Generator para tipos TS

---

#### 4. **Falta de Filtros y Búsqueda**

**Problema:**
```
GET /companies/:companyId/clientes/
→ Sin filtros: estado, tipo, etc.
```

**Mejor:**
```
GET /companies/:companyId/clientes?estado=ACTIVO&tipo=EMPRESA&search=acme
```

---

#### 5. **Estados Documentados pero sin Enum**

**Problema:**
```
Estados posibles: DRAFT, PENDING_REVIEW, POSTED, REVERSED
→ Pero en rutas no se ve enum explícito
```

**Mejor:**
```typescript
type JournalEntryStatus = 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';
GET /journal-entries?estado=POSTED
```

---

#### 6. **Falta de Rate Limiting Visible**

**Problema:**
- Middleware existe pero no hay doc de límites
- Cliente no sabe cuándo será throttled

**Mejor:**
- Documentar límites: `/docs`
- Retornar headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset`

---

#### 7. **Errores sin Estructura Uniforme**

**Problema:**
```
badRequest() vs unauthorized() vs notFound()
→ No queda claro si cliente debe reintentar o no
```

**Mejor:**
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "...",
    "details": { "field": "email", "reason": "invalid" },
    "retryable": false
  }
}
```

---

#### 8. **Documentación de Parámetros Incompleta**

**Problema:**
```
GET /reports/balance?from=...&to=...
→ ¿Qué formato? ¿UTC? ¿Timezone?
```

**Mejor:** Swagger documenta tipos y ejemplos

---

## D. RECOMENDACIONES

### 🎯 Corto Plazo (1-2 semanas)

#### 1. Completar OpenAPI/Swagger
```bash
# Ahora:
- Swagger existe pero solo para algunos endpoints
- 34 routers, pocos documentados

# Hacer:
- Documentar TODOS los endpoints
- Incluir request/response examples
- Generar cliente TS con openapi-generator
```

#### 2. Estandarizar Rutas Scoped
```
# Cambiar de:
GET /annual-accounts/:id/download
GET /fiscal-years/:fyId/books

# Cambiar a:
GET /companies/:companyId/annual-accounts/:id/download
GET /companies/:companyId/fiscal-years/:fyId/books

# Beneficio: multi-tenant claro, validación de acceso consistente
```

#### 3. Agregar Paginación por Defecto
```typescript
// En utils/response.ts

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

// En controladores:
const { limit = 20, offset = 0 } = req.query;
```

---

### 🎯 Mediano Plazo (1-2 meses)

#### 4. Generar Tipos TS Desde OpenAPI
```bash
npx openapi-generator-cli generate -i openapi.json -g typescript-axios -o generated/
```

Beneficio: Cliente Chakra tiene autocompletar, validación en tiempo de compilación

#### 5. Enriquecer Respuestas de Error
```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Monto no puede ser negativo",
    "statusCode": 400,
    "timestamp": "2026-06-30T14:30:00Z",
    "requestId": "req-12345",
    "retryable": false
  }
}
```

Beneficio: Cliente puede mostrar errores específicos, reintentos inteligentes

#### 6. Documentar Estados y Transiciones
```markdown
# Estado del Asiento Contable

DRAFT → PENDING_REVIEW → POSTED
  └─→ REVERSED (desde cualquiera)

Transiciones válidas:
- DRAFT + usuario.rol = contable → PENDING_REVIEW
- PENDING_REVIEW + usuario.rol = gerente → POSTED
- POSTED + usuario.rol = admin → REVERSED

[Documentar en /docs]
```

#### 7. Rate Limiting Headers
```typescript
res.set('X-RateLimit-Limit', '300');
res.set('X-RateLimit-Remaining', '299');
res.set('X-RateLimit-Reset', '1625000000');
```

---

### 🎯 Largo Plazo (mejoras arquitectónicas)

#### 8. Versionado de API
```
GET /api/v1/companies/:companyId/clientes
GET /api/v2/companies/:companyId/clientes

# Beneficio: evolucionar sin romper clientes viejos
```

#### 9. Webhooks para Eventos Asíncronos
```
POST /webhooks/subscribe
{
  "event": "asiento.approved",
  "url": "https://mi-app.com/webhook"
}

# Beneficio: Chakra no necesita polling, notificaciones en tiempo real
```

#### 10. GraphQL (opcional)
```graphql
query {
  empresa(id: "comp-1") {
    clientes(filter: {estado: ACTIVO}, limit: 20) {
      edges { node { id, nombre } }
      pageInfo { hasNextPage }
    }
  }
}
```

Beneficio: Cliente solicita exactamente lo que necesita (N+1 query problem resuelto)

---

## E. RESUMEN ARQUITECTÓNICO

| Aspecto | Status | Recomendación |
|---------|--------|-----------------|
| **Separación de capas** | ✅ Bien | Mantener |
| **Error handling** | ✅ Consistente | Enriquecer estructura |
| **Multi-tenant** | ✅ Implementado | Estandarizar rutas scoped |
| **Documentación API** | ⚠️ Parcial | Completar OpenAPI |
| **Paginación** | ❌ No existe | Implementar |
| **Tipos TS Cliente** | ⚠️ Manual | Generar desde OpenAPI |
| **Estados/transiciones** | ⚠️ Implícitos | Documentar explícitamente |
| **Rate limiting** | ✅ Implementado | Agregar headers |
| **Auditoría** | ✅ Integrada | Mantener |
| **Versionado API** | ❌ No existe | Considerar después |

---

## F. PASOS SIGUIENTES

**Prioridad 1 (Bloquea desarrollo):**
1. Completar documentación Swagger (todos los 34 endpoints)
2. Generar tipos TS desde OpenAPI
3. Estandarizar rutas scoped

**Prioridad 2 (Mejora usabilidad):**
4. Agregar paginación por defecto
5. Enriquecer respuestas de error
6. Documentar estados y transiciones

**Prioridad 3 (Escalabilidad futura):**
7. Versionado de API (/v1, /v2)
8. Webhooks para eventos

---

**Conclusión:** conta-api tiene una **arquitectura sólida**, pero necesita **documentación y estandarización** para ser verdaderamente usable por clientes externos (Chakra, móvil, integradores).

Recomiendo empezar por Prioridad 1 esta semana.

