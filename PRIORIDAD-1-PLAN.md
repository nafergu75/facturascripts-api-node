# 🎯 PRIORIDAD 1 - Plan de Ejecución

**Objetivo:** Completar Swagger, estandarizar rutas y agregar paginación  
**Tiempo estimado:** 1 semana  
**Responsable:** Tech Lead + Backend Developer

---

## 📊 Estado Actual

| Métrica | Valor | Target |
|---------|-------|--------|
| Endpoints documentados | 107/172 | 172 (100%) |
| Rutas con :companyId | ~140 | 165+ |
| Endpoints con paginación | 0 | ~45 (todos los GET) |
| Tipos TS generados | No | Sí |

---

## 📋 TAREA 1: Completar OpenAPI/Swagger

### 1.1 Auditar endpoints faltantes

```bash
# Comparar inventario vs documentación
npm run script:list-endpoints > all-endpoints.json
# Comparar con openapi.json → identificar gaps
```

**Endpoints críticos sin documentación:**
- Income Reader: web-upload, mobile-upload, email-hook
- Accounting: contabilizar, journal-entries, approve
- Impuestos: modelos, recalcular, pdf
- Reports: balance, p&l, ledger
- Registro Mercantil: books, annual-accounts
- Datos Maestros: clientes, proveedores, productos

### 1.2 Completar OpenAPI.json

**Crear** `scripts/generate-openapi.ts`:
```typescript
// Lee todos los routers
// Extrae métodos HTTP y parámetros
// Genera spec OpenAPI completo
// Incluye ejemplos de request/response
// Valida consistencia
```

**Estructura por endpoint:**
```json
{
  "/companies/:companyId/income-reader/mobile-upload": {
    "post": {
      "tags": ["Income Reader"],
      "summary": "Subir factura desde móvil",
      "parameters": [
        {
          "name": "companyId",
          "in": "path",
          "required": true,
          "schema": { "type": "string" }
        }
      ],
      "requestBody": {
        "content": {
          "multipart/form-data": {
            "schema": {
              "type": "object",
              "properties": {
                "file": {
                  "type": "string",
                  "format": "binary",
                  "description": "Archivo PDF/imagen"
                }
              }
            }
          }
        }
      },
      "responses": {
        "200": {
          "description": "Documento subido",
          "content": {
            "application/json": {
              "schema": { "$ref": "#/components/schemas/InvoiceDocument" }
            }
          }
        }
      }
    }
  }
}
```

### 1.3 Validar + Actualizar

```bash
# Validar OpenAPI
npx openapi-validator openapi.json

# Generar cliente TS
npx openapi-generator-cli generate \
  -i openapi.json \
  -g typescript-axios \
  -o generated/api-client
```

**Checklist:**
- [ ] 172/172 endpoints documentados
- [ ] Ejemplos de request/response
- [ ] Parámetros y tipos definidos
- [ ] Security schemas claros
- [ ] Tags consistentes
- [ ] Descripción en español
- [ ] Cliente TS generado sin errores

---

## 📍 TAREA 2: Estandarizar Rutas Scoped

### 2.1 Identificar rutas inconsistentes

**Rutas que DEBEN cambiar:**
```
GET /annual-accounts/:id/download
  → GET /companies/:companyId/annual-accounts/:id/download

GET /fiscal-years/:fyId/books
  → GET /companies/:companyId/fiscal-years/:fyId/books

POST /fiscal-years/:fyId/annual-accounts/generate
  → POST /companies/:companyId/fiscal-years/:fyId/annual-accounts/generate

... (~25 endpoints más)
```

### 2.2 Plan de cambio

**Paso 1:** Crear rutas NUEVAS (v1 coexistente)
```typescript
// En routers/registroMercantil.routes.ts

// NUEVA ruta (estandarizada)
router.get('/companies/:companyId/fiscal-years/:fyId/books', ...);

// Mantener VIEJA ruta por ahora (deprecated)
router.get('/fiscal-years/:fyId/books', (req, res) => {
  res.set('Deprecation', 'true');
  res.set('Sunset', 'Wed, 01 Jan 2027 00:00:00 GMT');
  // Redirect a nueva ruta
  res.redirect(301, `/companies/${req.companyId}/fiscal-years/${req.params.fyId}/books`);
});
```

**Paso 2:** Actualizar cliente Chakra
```typescript
// Cambiar en src/pages
- GET /fiscal-years/:fyId/books
+ GET /companies/:companyId/fiscal-years/:fyId/books
```

**Paso 3:** Tests
```bash
npm test -- src/tests/integration-endpoints.test.ts
# Verificar todas las rutas nuevas funcionan
```

**Paso 4:** Deprecar viejas rutas (en 2 semanas)
```typescript
// Cambiar redirect a error 410 Gone
if (req.path.match(/^\/fiscal-years\//)) {
  return res.status(410).json({
    ok: false,
    error: {
      code: 'DEPRECATED_ENDPOINT',
      message: 'Use /companies/:companyId/fiscal-years/... instead',
      migrateUrl: '/docs'
    }
  });
}
```

**Checklist:**
- [ ] Identificar 25+ rutas inconsistentes
- [ ] Crear nuevas rutas estandarizadas
- [ ] Mantener viejas rutas con deprecated headers
- [ ] Actualizar cliente Chakra
- [ ] Tests pasan 100%
- [ ] Documentar en OpenAPI

---

## 📄 TAREA 3: Agregar Paginación

### 3.1 Crear utilidad de paginación

**Crear** `src/utils/pagination.ts`:
```typescript
interface PaginationParams {
  limit?: number;
  offset?: number;
}

interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}

export function parsePaginationParams(query: Record<string, any>): PaginationParams {
  const limit = Math.min(Math.max(parseInt(query.limit || '20'), 1), 100);
  const offset = Math.max(parseInt(query.offset || '0'), 0);
  return { limit, offset };
}

export function sendPaginated<T>(
  res: any,
  data: T[],
  total: number,
  limit: number,
  offset: number
): void {
  res.json({
    ok: true,
    data,
    pagination: {
      limit,
      offset,
      total,
      hasMore: offset + limit < total
    }
  });
}
```

### 3.2 Endpoints que necesitan paginación

**GET endpoints (45 totales):**
```
[x] GET /companies/ → listar empresas
[x] GET /companies/:companyId/clientes/ → listar clientes
[x] GET /companies/:companyId/proveedores/ → listar proveedores
[x] GET /companies/:companyId/productos/ → listar productos
[x] GET /companies/:companyId/income-reader/pending → facturas pendientes
[x] GET /companies/:companyId/accounting/journal-entries → asientos
[x] GET /companies/:companyId/impuestos/modelos → modelos
[x] GET /companies/:companyId/reports/... → reportes (varios)
... (37 endpoints más)
```

### 3.3 Patrón de implementación

**ANTES:**
```typescript
export const clientesController = {
  listar: asyncHandler(async (req, res) => {
    const clientes = await clientesService.findAll(req.companyId!);
    sendOk(res, clientes);
  })
};
```

**DESPUÉS:**
```typescript
export const clientesController = {
  listar: asyncHandler(async (req, res) => {
    const { limit, offset } = parsePaginationParams(req.query);
    
    const [clientes, total] = await Promise.all([
      clientesService.findAll(req.companyId!, { limit, offset }),
      clientesService.count(req.companyId!)
    ]);
    
    sendPaginated(res, clientes, total, limit, offset);
  })
};
```

**En rutas:**
```typescript
/**
 * GET /companies/:companyId/clientes?limit=20&offset=0
 * 
 * Query parameters:
 *   - limit: Registros por página (1-100, default 20)
 *   - offset: Desplazamiento (default 0)
 */
router.get('/:companyId/clientes/', clientesController.listar);
```

### 3.4 Actualizar servicios

**Modify** `src/services/clientes.service.ts`:
```typescript
export const clientesService = {
  // NUEVO método con paginación
  findAll: async (companyId: string, options?: { limit?: number; offset?: number }) => {
    const { limit = 20, offset = 0 } = options || {};
    return prisma.cliente.findMany({
      where: { companyId },
      take: limit,
      skip: offset,
      orderBy: { createdAt: 'desc' }
    });
  },

  // NUEVO método para total
  count: async (companyId: string) => {
    return prisma.cliente.count({ where: { companyId } });
  }
};
```

**Checklist:**
- [ ] Crear utilidades de paginación
- [ ] Actualizar 45 endpoints GET
- [ ] Actualizar servicios (add limit/offset)
- [ ] Tests para paginación
- [ ] OpenAPI documenta query params
- [ ] Cliente Chakra usa paginación
- [ ] Respuestas incluyen total y hasMore

---

## 🚀 ORDEN DE EJECUCIÓN

### Semana 1 (Esta semana)

**Día 1-2: Tarea 1 (Swagger)**
- [ ] Auditar endpoints faltantes
- [ ] Crear generator de OpenAPI
- [ ] Completar 65 endpoints en spec
- [ ] Validar OpenAPI

**Día 3: Tarea 2 (Rutas Scoped)**
- [ ] Identificar 25+ rutas inconsistentes
- [ ] Crear nuevas rutas
- [ ] Deprecated headers en viejas
- [ ] Tests

**Día 4-5: Tarea 3 (Paginación)**
- [ ] Crear utilidades
- [ ] Implementar en 10-15 endpoints críticos (clientes, proveedores, productos, etc.)
- [ ] Actualizar servicios
- [ ] Tests

### Semana 2

- [ ] Completar paginación en 30 endpoints restantes
- [ ] Generar cliente TS desde OpenAPI
- [ ] Actualizar Chakra para usar nuevas rutas
- [ ] Code review + merge

---

## 📦 DELIVERABLES

Por cada tarea:

1. **Swagger/OpenAPI**
   - openapi.json actualizado (172 endpoints)
   - Cliente TS generado
   - Documentación en /docs

2. **Rutas Scoped**
   - Nuevas rutas estandarizadas
   - Viejas rutas con deprecated headers
   - Chakra actualizado
   - Tests pasan

3. **Paginación**
   - Utilidades en src/utils/pagination.ts
   - 45 endpoints GET con paginación
   - Servicios actualizados
   - Tests para paginación

---

## 🧪 VALIDACIÓN

```bash
# 1. Swagger valida
npx openapi-validator src/docs/openapi.json

# 2. Tests pasan
npm test

# 3. Cliente TS genera sin errores
npx openapi-generator-cli generate -i openapi.json -g typescript-axios

# 4. Chakra puede conectar
npm run dev:chakra

# 5. Dashboard muestra cambios
npm run script:list-endpoints
```

---

## 💰 IMPACTO

| Antes | Después |
|-------|---------|
| API sin documentación | 172/172 endpoints documentados |
| 10 rutas inconsistentes | Rutas estandarizadas y escalables |
| Cliente manual-tipado | Cliente TS generado automáticamente |
| Sin paginación | 45 endpoints con paginación |
| Chakra hardcoded | Chakra usa cliente generado |

---

## 🎓 RESUMEN

**Prioridad 1 = 3 tareas que transforman la API de "correcta" a "profesional"**

✅ **Swagger completo** → Documentación autogenerada  
✅ **Rutas estandarizadas** → Consistency + escalabilidad  
✅ **Paginación** → Performance + usabilidad  

**Resultado:** API lista para:
- Clientes externos (integradores)
- Generación automática de SDKs
- Análisis de performance (paginación)
- Escalabilidad (sin overload)

---

**¿Empezamos por Tarea 1 (Swagger)?**
