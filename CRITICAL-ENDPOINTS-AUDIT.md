# 🔍 AUDITORÍA TÉCNICA - 5 Endpoints Críticos

**Fecha:** 2026-06-30  
**Auditor:** Senior Backend Engineer + API Documentation Specialist  
**Objetivo:** Documentación OpenAPI profesional para endpoints críticos

---

## RESUMEN EJECUTIVO

He revisado los 5 endpoints más críticos en el código real de conta-api. Todos funcionan correctamente, pero la documentación actual es muy genérica.

| Endpoint | Status | Prioridad | Tiempo |
|----------|--------|-----------|--------|
| 1. POST /auth/login | ✅ Funcional | 🔴 CRÍTICO | 30 min |
| 2. POST /auth/refresh | ✅ Funcional | 🔴 CRÍTICO | 20 min |
| 3. POST /income-reader/mobile-upload | ✅ Funcional | 🔴 CRÍTICO | 40 min |
| 4. POST /accounting/contabilizar | ✅ Funcional | 🔴 CRÍTICO | 35 min |
| 5. GET /impuestos/pdf | ✅ Funcional | 🟡 IMPORTANTE | 25 min |

---

## A. REVISIÓN POR ENDPOINT

### 1️⃣ POST /auth/login

#### ¿Qué hace realmente?

Autentica usuario con email/password y retorna:
- JWT access token (corta duración)
- JWT refresh token (7 días)
- Datos del usuario (id, email, roles, empresas)
- Lista de empresas a las que tiene acceso
- Empresa seleccionada (si se envía `empresaCodigo`)

#### Cómo se usa

```bash
# Caso 1: Sin empresa específica (dejar que frontend elija)
POST /auth/login
{
  "email": "user@empresa.com",
  "password": "password123"
}

# Caso 2: Con empresa específica (login inmediato a empresa)
POST /auth/login
{
  "email": "user@empresa.com",
  "password": "password123",
  "empresaCodigo": "DEMO"
}
```

#### Qué falta en la documentación

- ❌ No documenta que `empresaCodigo` es OPCIONAL
- ❌ No explica diferencia entre ambos casos
- ❌ No muestra estructura completa de respuesta
- ❌ No incluye ejemplos realistas
- ❌ No explica qué hacer con tokens
- ❌ No documenta error específico cuando empresa no existe

#### Mejoras propuestas

1. **Hacer explícito el flujo de dos pasos:**
   - Sin empresaCodigo → devuelve lista de empresas → frontend elige
   - Con empresaCodigo → valida acceso y devuelve empresa seleccionada

2. **Agregar ejemplos completos** de request y response

3. **Documentar cómo usar los tokens:**
   - `token` en Authorization header de requests posteriores
   - `refreshToken` para refrescar cuando token expira

4. **Aclarar roles y scopes:**
   - Qué significa `esAdminGlobal`
   - Qué son `roles` vs `scopes`

---

### 2️⃣ POST /auth/refresh

#### ¿Qué hace realmente?

Renueva el access token usando el refresh token. El refresh token:
- Tiene validez de 7 días
- Se revoca automáticamente si se reutiliza (seguridad contra token robado)
- Mantiene roles/empresas FRESCOS de BD (revocaciones surten efecto)

#### Cómo se usa

```bash
# Cuando access token está cerca de expirar
POST /auth/refresh
{
  "refreshToken": "eyJhbGc..."
}
```

#### Qué falta

- ❌ No explica validez de 7 días
- ❌ No documenta rotación de refresh token
- ❌ No explica qué pasa si refresh token se roba
- ❌ No muestra respuesta (misma que login)

#### Mejoras propuestas

1. **Documentar ciclo de vida:**
   - Access token: ~15 min
   - Refresh token: 7 días

2. **Explicar seguridad:**
   - Si reutilizas el mismo refresh token dos veces → FALLA (revocado)
   - Esto previene que un token robado se use indefinidamente

3. **Mostrar respuesta completa:**
   - Devuelve nueva `token` + nuevo `refreshToken`
   - Roles y empresas se recargan desde BD

---

### 3️⃣ POST /companies/{companyId}/income-reader/mobile-upload

#### ¿Qué hace realmente?

Sube archivo de factura desde móvil (foto de factura).

**Soporta 3 formas diferentes de envío:**

**Forma 1: Multipart (Form Data)**
```
Content-Type: multipart/form-data
file: <binary image file>
```

**Forma 2: Binario crudo**
```
Content-Type: application/octet-stream
X-Filename: factura.jpg
<binary data>
```

**Forma 3: JSON con Base64**
```
Content-Type: application/json
{
  "nombreArchivo": "factura.jpg",
  "mimeType": "image/jpeg",
  "contenidoBase64": "iVBORw0KGg..."
}
```

#### Cómo se usa (Chakra)

La mayoría de clientes usarán **multipart (Forma 1)**:

```javascript
const formData = new FormData();
formData.append('file', imageFile); // <input type="file">

const response = await axios.post(
  `/companies/${companyId}/income-reader/mobile-upload`,
  formData,
  { headers: { 'Content-Type': 'multipart/form-data' } }
);
// → { ok: true, data: { document: { id, nombreArchivo, estado, ... } } }
```

#### Qué falta

- ❌ No explica que soporta 3 formas diferentes
- ❌ No documenta que es multipart/form-data
- ❌ No explica qué es `estado` en respuesta
- ❌ No documentan tipos de archivo permitidos (PDF, JPG, PNG)
- ❌ No documentan tamaño máximo de archivo
- ❌ Returns 201 (Created) pero OpenAPI dice 200

#### Mejoras propuestas

1. **Cambiar a multipart/form-data:**
   - Es la forma estándar para subidas de archivo
   - Chakra y clientes reales lo esperan

2. **Documentar estados de documento:**
   ```
   UPLOADED → Archivo recibido
   READY_FOR_VERIFICATION → OCR completado, listo para revisar
   VERIFIED → Usuario verificó, listo para contabilizar
   REJECTED → Usuario rechazó, no contabilizar
   ```

3. **Especificar tipos de archivo:**
   - PDF (recomendado)
   - JPG/JPEG (fotos)
   - PNG (fotos)

4. **Devolver 201 Created** (no 200) cuando se crea documento

5. **Documentar flujo completo:**
   - Upload → OCR procesa en background
   - Cliente hace polling: GET `/income-reader/{id}`
   - Cuando `estado = READY_FOR_VERIFICATION` → usuario revisa
   - Usuario verifica: POST `/income-reader/{id}/verify`

---

### 4️⃣ POST /companies/{companyId}/accounting/contabilizar/{invoiceId}

#### ¿Qué hace realmente?

Crea un asiento contable automático a partir de una factura.

Requiere 2 parámetros:
- `tipo` (OBLIGATORIO): INGRESO | GASTO
  - INGRESO: factura de cliente
  - GASTO: factura de proveedor
- `mode` (opcional, default AUTO): AUTO | MANUAL
  - AUTO: contabiliza automáticamente
  - MANUAL: crea asiento en DRAFT para revisión

#### Cómo se usa

```bash
# Contabilizar automático una factura de ingreso
POST /companies/comp-1/accounting/contabilizar/inv-2026-001?tipo=INGRESO

# Respuesta:
{
  "ok": true,
  "data": {
    "journalEntryId": "je-abc123",
    "estado": "PENDING_REVIEW",  // o DRAFT si modo MANUAL
    "advertencias": [
      "Cliente sin cuenta asignada: se usó cuenta genérica 430"
    ]
  }
}
```

#### Qué falta

- ❌ No documenta que `tipo` es OBLIGATORIO
- ❌ No explica diferencia INGRESO vs GASTO
- ❌ No explica qué es `modo` AUTO vs MANUAL
- ❌ No documenta estados posibles del asiento
- ❌ No explica qué significan las advertencias
- ❌ No documenta cuándo retorna 400 (si tipo invalido)

#### Problemas de usabilidad

🔴 **PROBLEMA 1: tipo es query param, pero debería ser body o mejor nombrado**
```
ACTUAL (confuso):
  ?tipo=INGRESO

MEJOR:
  ?tipoDocumento=INGRESO  (más claro qué es)
  O en body: { tipo: "INGRESO" }
```

🟡 **PROBLEMA 2: No explica pre-requisitos**
- ¿Qué datos necesita el asiento?
- ¿Dónde se obtiene la factura?
- ¿Qué pasa si factura no existe?

#### Mejoras propuestas

1. **Renombrar parámetro:**
   - `tipo` → `tipoDocumento` o `invoiceType` (más claro)

2. **Documentar estados de asiento:**
   ```
   DRAFT: Creado pero no revisado
   PENDING_REVIEW: Listo para revisar/aprobar
   POSTED: Contabilizado (fijo)
   REVERSED: Reversado (anulado)
   ```

3. **Explicar flujo:**
   - POST contabilizar → estado PENDING_REVIEW
   - User revisa: GET journal-entries/{id}
   - Si correcto: POST journal-entries/{id}/approve → POSTED

4. **Documentar advertencias:**
   - Qué significan cada una
   - Si son bloqueantes o informativas

5. **Agregar ejemplos de error:**
   ```json
   400: { "error": "Parameter 'tipo' required and must be INGRESO or GASTO" }
   404: { "error": "Invoice not found" }
   ```

---

### 5️⃣ GET /companies/{companyId}/impuestos/modelos/{modeloId}/pdf

#### ¿Qué hace realmente?

Descarga un PDF de un modelo de impuestos (Modelo 303, 347, etc.) en formato PDF/A (archivable).

#### Cómo se usa

```bash
# Descargar PDF del Modelo 303 trimestral
GET /companies/comp-1/impuestos/modelos/modelo-303-2026-q1/pdf

# Response:
# Status: 200
# Content-Type: application/pdf
# Content-Disposition: attachment; filename="303_2026_Q1.pdf"
# <binary PDF data>
```

En navegador/JavaScript:
```javascript
// Descargar PDF
const response = await fetch(
  `/companies/${companyId}/impuestos/modelos/${modeloId}/pdf`
);
const blob = await response.blob();
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'modelo-303.pdf';
a.click();
```

#### Qué falta

- ❌ No documenta que retorna BINARY (PDF)
- ❌ No explica Content-Disposition header
- ❌ No documenta qué es modelo-303-2026-q1 (formato)
- ❌ No explica cuándo puede fallar (modelo no existe, etc)
- ❌ No documenta que requiere scope impuestos:read

#### Mejoras propuestas

1. **Documentar respuesta como binary:**
   - Content-Type: application/pdf
   - No JSON, sino PDF crudo

2. **Explicar Content-Disposition:**
   - attachment → descarga como archivo
   - filename → nombre sugerido para guardar

3. **Documentar modeloId format:**
   - Formato: `modelo-{tipo}-{año}-{período}`
   - Ejemplos: modelo-303-2026-q1, modelo-347-2026-1t

4. **Agregar errores:**
   - 404 si modelo no existe
   - 403 si usuario no tiene scope impuestos:read

---

## B. BLOQUES OPENAPI CORREGIDOS

### Listo para pegar en `src/docs/openapi.json`

Copia estos bloques bajo `paths:` en el JSON.

#### 1. POST /auth/login

```json
"/auth/login": {
  "post": {
    "tags": ["🔐 Autenticación"],
    "summary": "Autenticar usuario y obtener tokens JWT",
    "description": "Valida credenciales del usuario y retorna:\n\n- **Access Token**: JWT para usar en requests posteriores (corta duración)\n- **Refresh Token**: Para renovar access token cuando expire (7 días)\n- **Lista de empresas**: Empresas a las que el usuario tiene acceso\n- **Empresa seleccionada** (opcional): Si se especifica empresaCodigo\n\n### Flujo de dos pasos:\n\n1. **Sin empresaCodigo**: Devuelve lista de empresas. El frontend debe mostrar selector y hacer login nuevamente con empresaCodigo elegido.\n\n2. **Con empresaCodigo**: Valida acceso a esa empresa y devuelve empresa seleccionada.\n\n### Uso de tokens:\n\nEn requests posteriores, incluye el access token en el header:\n```\nAuthorization: Bearer eyJhbGc...\n```\n\nCuando el token expire (~15 min), usa refresh token para obtener uno nuevo:\n```\nPOST /auth/refresh\n{ \"refreshToken\": \"eyJhbGc...\" }\n```",
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "email": {
                "type": "string",
                "format": "email",
                "description": "Email del usuario"
              },
              "password": {
                "type": "string",
                "description": "Contraseña del usuario (sin encriptar en tránsito, usa HTTPS)"
              },
              "empresaCodigo": {
                "type": "string",
                "description": "Código de empresa (opcional). Si se envía, valida acceso y retorna esa empresa como seleccionada.",
                "example": "DEMO"
              }
            },
            "required": ["email", "password"]
          },
          "example": {
            "email": "contador@empresa.com",
            "password": "password123",
            "empresaCodigo": "DEMO"
          }
        }
      }
    },
    "responses": {
      "200": {
        "description": "Autenticación exitosa",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": true },
                "data": {
                  "type": "object",
                  "properties": {
                    "token": {
                      "type": "string",
                      "description": "JWT Access Token. Incluir en header Authorization: Bearer {token}"
                    },
                    "refreshToken": {
                      "type": "string",
                      "description": "JWT Refresh Token. Válido 7 días. Usar en POST /auth/refresh para renovar access token."
                    },
                    "user": {
                      "type": "object",
                      "properties": {
                        "id": { "type": "string" },
                        "email": { "type": "string" },
                        "roles": { 
                          "type": "array", 
                          "items": { "type": "string" },
                          "description": "Roles del usuario en empresas (contable, gerente, admin, etc)"
                        },
                        "companies": { 
                          "type": "array", 
                          "items": { "type": "string" },
                          "description": "IDs de empresas a las que tiene acceso"
                        },
                        "esAdminGlobal": {
                          "type": "boolean",
                          "description": "True si es admin global (acceso a todas empresas + panel admin)"
                        }
                      }
                    },
                    "empresas": {
                      "type": "array",
                      "description": "Lista completa de empresas a las que el usuario tiene acceso",
                      "items": {
                        "type": "object",
                        "properties": {
                          "companyId": { "type": "string" },
                          "codigo": { "type": "string", "description": "Código corto de empresa" },
                          "nombre": { "type": "string" }
                        }
                      }
                    },
                    "empresaSeleccionada": {
                      "type": "string",
                      "description": "ID de empresa seleccionada (solo si se envió empresaCodigo)",
                      "nullable": true
                    }
                  }
                }
              }
            },
            "example": {
              "ok": true,
              "data": {
                "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
                "user": {
                  "id": "user-123",
                  "email": "contador@empresa.com",
                  "roles": ["contable", "gerente"],
                  "companies": ["comp-1", "comp-2"],
                  "esAdminGlobal": false
                },
                "empresas": [
                  { "companyId": "comp-1", "codigo": "DEMO", "nombre": "Demo SL" },
                  { "companyId": "comp-2", "codigo": "PROD", "nombre": "Producción SL" }
                ],
                "empresaSeleccionada": "comp-1"
              }
            }
          }
        }
      },
      "401": {
        "description": "Autenticación fallida",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": false },
                "error": { "type": "string" }
              }
            },
            "examples": {
              "credenciales_invalidas": {
                "value": {
                  "ok": false,
                  "error": "Credenciales invalidas."
                }
              },
              "empresa_no_autorizada": {
                "value": {
                  "ok": false,
                  "error": "El usuario no tiene acceso a la empresa 'DEMO'."
                }
              }
            }
          }
        }
      }
    }
  }
}
```

#### 2. POST /auth/refresh

```json
"/auth/refresh": {
  "post": {
    "tags": ["🔐 Autenticación"],
    "summary": "Renovar access token usando refresh token",
    "description": "Cuando el access token está próximo a expirar (~15 min), usa el refresh token para obtener uno nuevo.\n\n**Validez:**\n- Access Token: ~15 minutos\n- Refresh Token: 7 días\n\n**Seguridad:**\n- Si el refresh token se reutiliza dos veces (token robado + uso original), la segunda llamada FALLA\n- Los roles/empresas se recargan desde BD, por lo que revocaciones surten efecto inmediato\n\n**Importante:** Nunca confíes en el access token en caché si hace más de 15 min que lo obtuviste. Siempre renovar con refresh token si está próximo a expirar.",
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "refreshToken": {
                "type": "string",
                "description": "Refresh token obtenido en /auth/login"
              }
            },
            "required": ["refreshToken"]
          },
          "example": {
            "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
          }
        }
      }
    },
    "responses": {
      "200": {
        "description": "Token renovado exitosamente",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": true },
                "data": {
                  "type": "object",
                  "description": "Misma estructura que POST /auth/login",
                  "properties": {
                    "token": { "type": "string" },
                    "refreshToken": { "type": "string" },
                    "user": { "type": "object" },
                    "empresas": { "type": "array" },
                    "empresaSeleccionada": { "type": "string", "nullable": true }
                  }
                }
              }
            }
          }
        }
      },
      "401": {
        "description": "Refresh token inválido, expirado o revocado",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": false },
                "error": { "type": "string" }
              }
            },
            "examples": {
              "token_expirado": {
                "value": {
                  "ok": false,
                  "error": "Refresh token invalido o expirado."
                }
              },
              "token_revocado": {
                "value": {
                  "ok": false,
                  "error": "Refresh token revocado. Inicia sesion de nuevo."
                }
              }
            }
          }
        }
      }
    }
  }
}
```

#### 3. POST /companies/{companyId}/income-reader/mobile-upload

```json
"/companies/{companyId}/income-reader/mobile-upload": {
  "post": {
    "tags": ["📸 Lector de Facturas"],
    "summary": "Subir factura desde móvil (foto)",
    "description": "Sube un archivo de factura (foto, PDF) desde una app móvil.\n\nSoporta 3 formas de envío:\n\n1. **Multipart (recomendado)**: Envía archivo como form-data\n2. **Binario crudo**: Envía binary data con header X-Filename\n3. **JSON + Base64**: Envía { nombreArchivo, mimeType, contenidoBase64 }\n\n**Proceso:**\n- Upload → Archivo guardado, estado UPLOADED\n- Backend procesa OCR en background con Claude Vision\n- Cliente hace polling: GET `/companies/{companyId}/income-reader/{id}`\n- Cuando estado = READY_FOR_VERIFICATION → Usuario revisa datos extraídos\n- Usuario verifica: POST `/companies/{companyId}/income-reader/{id}/verify`\n- Automáticamente se contabiliza",
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" },
        "description": "ID de la empresa"
      }
    ],
    "requestBody": {
      "required": true,
      "content": {
        "multipart/form-data": {
          "schema": {
            "type": "object",
            "properties": {
              "file": {
                "type": "string",
                "format": "binary",
                "description": "Archivo de factura (PDF, JPG, PNG). Máx 15MB"
              }
            },
            "required": ["file"]
          }
        }
      }
    },
    "security": [{ "bearerAuth": [] }],
    "responses": {
      "201": {
        "description": "Documento subido y enviado a procesamiento",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": true },
                "data": {
                  "type": "object",
                  "properties": {
                    "document": {
                      "type": "object",
                      "properties": {
                        "id": { "type": "string", "description": "ID del documento" },
                        "nombreArchivo": { "type": "string" },
                        "estado": { 
                          "type": "string",
                          "enum": ["UPLOADED", "READY_FOR_VERIFICATION", "VERIFIED", "REJECTED"],
                          "description": "Estado del documento. Inicialmente UPLOADED."
                        },
                        "createdAt": { "type": "string", "format": "date-time" }
                      }
                    }
                  }
                }
              }
            },
            "example": {
              "ok": true,
              "data": {
                "document": {
                  "id": "doc-abc123",
                  "nombreArchivo": "factura_001.jpg",
                  "estado": "UPLOADED",
                  "createdAt": "2026-06-30T14:30:00Z"
                }
              }
            }
          }
        }
      },
      "400": {
        "description": "Error en el archivo o formato",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": false },
                "error": { "type": "string" }
              }
            },
            "example": {
              "ok": false,
              "error": "No archivo recibido. Usa multipart (multer), binario o { nombreArchivo, mimeType, contenidoBase64 }."
            }
          }
        }
      },
      "401": {
        "description": "No autenticado o token expirado"
      }
    }
  }
}
```

#### 4. POST /companies/{companyId}/accounting/contabilizar/{invoiceId}

```json
"/companies/{companyId}/accounting/contabilizar/{invoiceId}": {
  "post": {
    "tags": ["📊 Contabilidad"],
    "summary": "Contabilizar factura automáticamente",
    "description": "Crea un asiento contable a partir de una factura de cliente (ingreso) o proveedor (gasto).\n\n**Parámetros requeridos:**\n- `tipo`: Tipo de factura (INGRESO = cliente, GASTO = proveedor)\n\n**Parámetros opcionales:**\n- `mode`: AUTO (por defecto) contabiliza inmediatamente. MANUAL crea en borrador para revisión.\n\n**Flujo:**\n1. POST contabilizar → Crea asiento, estado PENDING_REVIEW (o DRAFT si mode=MANUAL)\n2. Usuario revisa: GET `/companies/{companyId}/accounting/journal-entries/{journalEntryId}`\n3. Si correcto: POST `.../journal-entries/{journalEntryId}/approve` → estado POSTED (fijo)\n\n**Advertencias:** El asiento puede generarse con advertencias (ej: cliente sin cuenta asignada, se usó genérica). Revisar en response['data']['advertencias'].",
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" },
        "description": "ID de la empresa"
      },
      {
        "name": "invoiceId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" },
        "description": "ID de la factura a contabilizar"
      },
      {
        "name": "tipo",
        "in": "query",
        "required": true,
        "schema": { "type": "string", "enum": ["INGRESO", "GASTO"] },
        "description": "Tipo de factura: INGRESO (cliente) o GASTO (proveedor)"
      },
      {
        "name": "mode",
        "in": "query",
        "required": false,
        "schema": { "type": "string", "enum": ["AUTO", "MANUAL"], "default": "AUTO" },
        "description": "AUTO: contabiliza inmediatamente. MANUAL: crea en DRAFT para revisión manual."
      }
    ],
    "security": [{ "bearerAuth": [] }],
    "responses": {
      "200": {
        "description": "Asiento contable creado",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": true },
                "data": {
                  "type": "object",
                  "properties": {
                    "journalEntryId": { "type": "string", "description": "ID del asiento creado" },
                    "estado": { 
                      "type": "string",
                      "enum": ["DRAFT", "PENDING_REVIEW"],
                      "description": "DRAFT si mode=MANUAL. PENDING_REVIEW si mode=AUTO (o default)."
                    },
                    "advertencias": {
                      "type": "array",
                      "items": { "type": "string" },
                      "description": "Advertencias no bloqueantes (ej: cuenta genérica usada)"
                    }
                  }
                }
              }
            },
            "examples": {
              "exito_con_advertencias": {
                "value": {
                  "ok": true,
                  "data": {
                    "journalEntryId": "je-xyz789",
                    "estado": "PENDING_REVIEW",
                    "advertencias": [
                      "Cliente sin cuenta asignada: se usó cuenta genérica 430",
                      "IVA soportado 21% asumido (no especificado en factura)"
                    ]
                  }
                }
              }
            }
          }
        }
      },
      "400": {
        "description": "Parámetros inválidos",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean", "example": false },
                "error": { "type": "string" }
              }
            },
            "examples": {
              "tipo_invalido": {
                "value": {
                  "ok": false,
                  "error": "Parameter 'tipo' required and must be INGRESO or GASTO"
                }
              },
              "mode_invalido": {
                "value": {
                  "ok": false,
                  "error": "Parameter 'mode' must be AUTO or MANUAL"
                }
              }
            }
          }
        }
      },
      "404": {
        "description": "Factura o empresa no encontrada"
      },
      "401": {
        "description": "No autenticado"
      }
    }
  }
}
```

#### 5. GET /companies/{companyId}/impuestos/modelos/{modeloId}/pdf

```json
"/companies/{companyId}/impuestos/modelos/{modeloId}/pdf": {
  "get": {
    "tags": ["🏛️ Impuestos AEAT"],
    "summary": "Descargar PDF del modelo de impuestos",
    "description": "Descarga un archivo PDF del modelo de impuestos (Modelo 303, 347, 111, etc.) en formato PDF/A (archivable según normativa).\n\n**Formato de modeloId:**\n`modelo-{tipo}-{año}-{período}`\n- tipo: 303, 347, 349, 111, 115, 190, 200, etc.\n- año: 2026, 2025, etc.\n- período: q1, q2, q3, q4 (trimestral) o 1t, 2t, 3t (trimestral) o 0a (anual)\n\n**Ejemplos:**\n- `modelo-303-2026-q1` → Modelo 303 Q1 2026\n- `modelo-347-2026-0a` → Modelo 347 anual 2026\n\n**Respuesta:**\n- Binario PDF (no JSON)\n- Header `Content-Disposition: attachment` → descarga como archivo\n- Filename en header → nombre sugerido para guardar\n\n**Uso en navegador/JavaScript:**\n```javascript\nconst response = await fetch(`/companies/${companyId}/impuestos/modelos/${modeloId}/pdf`, {\n  headers: { 'Authorization': `Bearer ${token}` }\n});\nconst blob = await response.blob();\nconst url = URL.createObjectURL(blob);\nconst a = document.createElement('a');\na.href = url;\na.download = 'modelo.pdf';\na.click();\n```",
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" },
        "description": "ID de la empresa"
      },
      {
        "name": "modeloId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" },
        "description": "ID del modelo (formato: modelo-{tipo}-{año}-{período})",
        "example": "modelo-303-2026-q1"
      }
    ],
    "security": [{ "bearerAuth": [] }],
    "responses": {
      "200": {
        "description": "PDF del modelo",
        "content": {
          "application/pdf": {
            "schema": {
              "type": "string",
              "format": "binary"
            }
          }
        },
        "headers": {
          "Content-Disposition": {
            "schema": { "type": "string" },
            "description": "attachment; filename=\"303_2026_Q1.pdf\""
          }
        }
      },
      "404": {
        "description": "Modelo no encontrado"
      },
      "403": {
        "description": "Usuario sin permiso impuestos:read"
      },
      "401": {
        "description": "No autenticado"
      }
    }
  }
}
```

---

## C. RECOMENDACIONES DE USABILIDAD

### 🔴 CRÍTICO - Cambios necesarios

#### 1. **POST /accounting/contabilizar - Renombrar parámetro**

**ACTUAL:**
```
?tipo=INGRESO
```

**PROBLEMA:** No queda claro si `tipo` es el tipo de asiento, tipo de factura, etc.

**RECOMENDACIÓN:**
```
?tipoDocumento=INGRESO
O
?invoiceType=INGRESO
```

**Por qué:** Más legible, evita ambigüedad.

**Esfuerzo:** 30 min (cambiar ruta + documentación)

---

#### 2. **POST /income-reader/mobile-upload - Cambiar a multipart**

**ACTUAL OpenAPI:** Documentado genéricamente  
**PROBLEMA:** Chakra y clientes reales esperan multipart/form-data

**RECOMENDACIÓN:** Cambiar documentación a multipart como formato primario, pero mantener soporte para los otros 2 en notas.

**Por qué:** Standard de facto para file uploads  
**Esfuerzo:** 5 min (solo docum entación)

---

#### 3. **POST /accounting/contabilizar - Status HTTP 201**

**ACTUAL:** Probablemente retorna 200  
**PROBLEMA:** Creación de recurso debería ser 201 Created

**RECOMENDACIÓN:**
```javascript
// En accounting-engine.routes.ts
res.status(201).json(resultado);  // Cambiar de res.json() a res.status(201).json()
```

**Por qué:** Sigue RFC 7231  
**Esfuerzo:** 2 min de código

---

### 🟡 IMPORTANTE - Mejoras de usabilidad

#### 4. **Documentar ciclo de vida de tokens**

**Qué agregar:** Tabla clara en /auth/login y /auth/refresh

```
┌─────────────────────────────────────────┐
│ Access Token (JWT)                      │
├─────────────────────────────────────────┤
│ Validez: ~15 minutos                    │
│ Uso: Authorization: Bearer {token}      │
│ Cuando expire: POST /auth/refresh       │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│ Refresh Token (JWT)                     │
├─────────────────────────────────────────┤
│ Validez: 7 días                         │
│ Uso: POST /auth/refresh { refreshToken }│
│ Revocación: Automática si se reutiliza  │
│ Cuando expire: Login de nuevo           │
└─────────────────────────────────────────┘
```

---

#### 5. **Documentar estados de asiento en accounting**

**Qué agregar:** Schema de estados + transiciones

```
{
  "estado": {
    "type": "string",
    "enum": ["DRAFT", "PENDING_REVIEW", "POSTED", "REVERSED"],
    "description": "
      DRAFT: Asiento borrador, no revisado
      PENDING_REVIEW: Listo para revisar y aprobar
      POSTED: Contabilizado, fijo (no editable)
      REVERSED: Reversado/anulado
      
      Transiciones:
      DRAFT → PENDING_REVIEW → POSTED
      Cualquiera → REVERSED (anulación)
    "
  }
}
```

---

#### 6. **Documentar estados de documento en income-reader**

**Qué agregar:** Flujo visual

```
UPLOADED
   ↓ (OCR en background)
READY_FOR_VERIFICATION (usuario revisa)
   ├→ VERIFIED (contabilizar)
   └→ REJECTED (ignorar)
```

---

### 🟢 BONITO - Extras si hay tiempo

#### 7. Agregar ejemplos de error completos

Para cada endpoint, documentar:
- Qué puede fallar
- Qué status code retorna
- Qué error message muestra

#### 8. Agregar tiempos de procesamiento

Ej: "OCR toma ~5-10 segundos"

#### 9. Documentar límites y cuotas

Ej: "Máximo 15MB por archivo"

---

## D. PRIORIDAD & ROADMAP

### Si no da tiempo para los 5, hacer en este orden:

| # | Endpoint | Tiempo | Criticidad | Razón |
|---|----------|--------|-----------|-------|
| 1️⃣ | POST /auth/login | 30 min | 🔴 CRÍTICO | Todo depende de autenticación |
| 2️⃣ | POST /auth/refresh | 20 min | 🔴 CRÍTICO | Mantiene sesiones activas |
| 3️⃣ | POST /income-reader/mobile-upload | 40 min | 🔴 CRÍTICO | Flujo principal del sistema |
| 4️⃣ | POST /accounting/contabilizar | 35 min | 🔴 CRÍTICO | Core contable |
| 5️⃣ | GET /impuestos/pdf | 25 min | 🟡 IMPORTANTE | Secundario (descarga) |

**Total:** ~2 horas para todos  
**Mínimo viable:** 1-2 (auth)  
**Recomendado:** 1-4 (core del sistema)

---

## E. SIGUIENTES PASOS

### Hoy (Ahora)

- [ ] Copiar bloques OpenAPI de Sección B
- [ ] Pegar en `src/docs/openapi.json` bajo `paths:`
- [ ] Validar sintaxis: `npm run openapi:validate`

### Mañana

- [ ] Hacer cambios de código (renombrar tipo, status 201)
- [ ] Generar cliente TS: `npx openapi-generator-cli generate...`
- [ ] Actualizar Chakra para usar nuevo cliente

### Esta semana

- [ ] Documentar módulos secundarios (reportes, bancos, etc)
- [ ] Publicar /docs en Swagger UI
- [ ] Compartir con equipo frontend

---

**Status:** 🟢 LISTO PARA IMPLEMENTAR  
**Bloques:** Listos para copiar/pegar  
**Recomendaciones:** Concretas y priorizadas

¿Comenzamos por el bloque de auth o prefieres otro?
