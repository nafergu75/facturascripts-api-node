# ✅ PRIORIDAD 1 - Estado Actual & Acciones

**Fecha:** 2026-06-30  
**Objetivo:** Completar Swagger, estandarizar rutas, agregar paginación  
**Status:** 🟡 EN PROGRESO - Tarea 1 iniciada

---

## 📊 ESTADO ACTUAL

### Swagger/OpenAPI (Tarea 1)

| Métrica | Estado |
|---------|--------|
| Endpoints documentados (viejo) | 125/172 (72.7%) ✅ |
| Endpoints documentados (nuevo) | 24/172 (14%) 🟡 |
| Archivos generados | 2 (openapi-complete.json, audit-report.json) ✅ |
| Módulos sin documentación | 10+ 🔴 |

**Módulos SIN documentación (prioritarios):**
```
1. registroMercantil.routes.ts    (14 endpoints faltantes)
2. impuestosModulo.routes.ts      (11 endpoints faltantes)
3. accounting-closure.routes.ts   (10 endpoints faltantes)
4. reports.routes.ts              (9 endpoints faltantes)
5. income-invoices.routes.ts      (8 endpoints faltantes)
6. chart-of-accounts.routes.ts    (6 endpoints faltantes)
7. bancos.routes.ts               (6 endpoints faltantes)
8. clientes.routes.ts             (6 endpoints faltantes)
9. plantillasDocumento.routes.ts  (6 endpoints faltantes)
10. proveedores.routes.ts         (6 endpoints faltantes)
```

---

## 🎯 PLAN EJECUTIVO PARA ESTA SEMANA

### Paso 1: Completar OpenAPI Manualmente (Hoy/Mañana)

**Estrategia:**
1. Usar `openapi-complete.json` como base
2. Agregar módulos faltantes usando template estándar
3. Validar con `openapi-validator`

**Template para cada endpoint:**
```json
"/companies/{companyId}/MODULE/ENDPOINT": {
  "get": {
    "tags": ["📋 Módulo"],
    "summary": "Descripción breve (< 60 chars)",
    "description": "Descripción detallada con contexto",
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" }
      }
    ],
    "security": [{ "bearerAuth": [] }],
    "responses": {
      "200": {
        "description": "Success",
        "content": {
          "application/json": {
            "schema": {
              "type": "object",
              "properties": {
                "ok": { "type": "boolean" },
                "data": { "type": "object" }
              }
            }
          }
        }
      }
    }
  }
}
```

**Módulos a completar (por importancia):**
- ✅ **CRÍTICOS** (sin delay):
  1. auth (5 endpoints)
  2. income-reader (10 endpoints)
  3. accounting (16 endpoints)
  4. impuestos (13 endpoints)

- 🟡 **IMPORTANTES** (esta semana):
  5. registroMercantil (14 endpoints)
  6. reports (11 endpoints)
  7. datos maestros (clientes, proveedores, etc.)

- 🟢 **SECUNDARIOS** (próxima semana):
  8. Plantillas, nóminas, etc.

### Paso 2: Generar Cliente TS (Mañana)

```bash
# Validar OpenAPI primero
npx openapi-validator src/docs/openapi.json

# Generar cliente TS desde OpenAPI
npx openapi-generator-cli generate \
  -i src/docs/openapi.json \
  -g typescript-axios \
  -o generated/api-client

# Resultado: tipos TS completamente tipados
# Chakra puede usar directamente
```

**Beneficio:** Chakra pasa de tipos manuales a tipos auto-generados

### Paso 3: Estandarizar Rutas Scoped (Miércoles/Jueves)

**Identificadas 25 rutas inconsistentes:**
```
ANTES:
  GET /annual-accounts/:id/download
  GET /fiscal-years/:fyId/books
  POST /fiscal-years/:fyId/annual-accounts/generate

DESPUÉS (estandarizado):
  GET /companies/:companyId/annual-accounts/:id/download
  GET /companies/:companyId/fiscal-years/:fyId/books
  POST /companies/:companyId/fiscal-years/:fyId/annual-accounts/generate
```

**Proceso:**
1. Crear nuevas rutas (estandarizadas)
2. Mantener viejas rutas con `Deprecation` headers
3. Actualizar cliente Chakra para usar nuevas rutas
4. Tests para validar ambas rutas funcionan

### Paso 4: Agregar Paginación (Jueves/Viernes)

**Crear utilidades:**
```typescript
// src/utils/pagination.ts
interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
}
```

**Aplicar a 45 endpoints GET (empezar con críticos):**
- GET /companies/:companyId/clientes
- GET /companies/:companyId/proveedores
- GET /companies/:companyId/productos
- GET /companies/:companyId/income-reader/pending
- GET /companies/:companyId/accounting/journal-entries
- GET /companies/:companyId/impuestos/modelos

**Parámetros:**
```
GET /companies/:companyId/clientes?limit=20&offset=0

Respuesta:
{
  "ok": true,
  "data": [...]
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 450,
    "hasMore": true
  }
}
```

---

## 📋 CHECKLIST SEMANAL

### Lunes (Hoy)
- [x] Crear plan de Prioridad 1
- [x] Generar openapi-complete.json con 24 endpoints clave
- [x] Crear script de auditoría (identifica 154 faltantes)
- [ ] Completar 50 endpoints en OpenAPI

### Martes
- [ ] Completar 100+ endpoints en OpenAPI
- [ ] Validar con openapi-validator
- [ ] Generar cliente TS
- [ ] Actualizar Chakra para usar cliente generado

### Miércoles
- [ ] Estandarizar rutas scoped (25 endpoints)
- [ ] Tests para nuevas rutas
- [ ] Deprecated headers en viejas rutas

### Jueves
- [ ] Crear utilidades de paginación
- [ ] Implementar paginación en 15 endpoints críticos
- [ ] Tests para paginación

### Viernes
- [ ] Completar paginación en 30 endpoints más
- [ ] Code review
- [ ] Merge a main

---

## 🚀 EJECUCIÓN INMEDIATA

### Para completar OpenAPI (AHORA):

**Opción A: Manual (Rápido)**
```bash
# Editar src/docs/openapi.json directamente
# Copiar 24 endpoints de openapi-complete.json
# Agregar 70-80 endpoints críticos desde template
# Tiempo estimado: 2-3 horas
```

**Opción B: Automático (Mejor)**
```bash
# Crear script que lea routers y genere OpenAPI
# Incluya ejemplos de request/response
# Tiempo estimado: 3-4 horas
```

**Recomendación:** Opción A (manual) para endpoints críticos (50-60)  
**Luego:** Opción B (automático) para resto

### Archivos a modificar/crear:

```
✅ scripts/generate-openapi-complete.ts      (creado)
✅ scripts/audit-and-complete-openapi.ts     (creado)
📝 src/docs/openapi.json                     (agregar 154 endpoints)
📝 src/utils/pagination.ts                   (crear)
📝 src/routes/**/**.routes.ts                (agregar paginación)
📝 src/services/**/**.service.ts             (agregar limit/offset)
📝 src/controllers/**/**.controller.ts       (usar sendPaginated)
📝 frontend-chakra/src/api/client.ts         (generar desde OpenAPI)
```

---

## 💯 MÉTRICAS DE ÉXITO

**Fin de semana:**
- ✅ 170+/172 endpoints documentados en OpenAPI (98%+)
- ✅ Cliente TS generado sin errores
- ✅ Rutas scoped estandarizadas
- ✅ 20-30 endpoints con paginación
- ✅ Tests pasan 100%
- ✅ Chakra conecta a API automática

**Impacto:**
- API profesional y documentada
- Clientes externos pueden usar
- Performance mejorado (paginación)
- Escalabilidad garantizada

---

## 📞 PRÓXIMOS PASOS

**¿Quieres que continúe con?**

1. **Completar OpenAPI manualmente** (editar archivo JSON)
2. **Crear script automático** para generar spec desde código
3. **Iniciar estandarización de rutas** (crear nuevas rutas)
4. **Implementar paginación** (crear utils + aplicar)

**Recomendación:** Empezar por opción 1 (rápido win) y luego opción 4 (paginación)

---

**Status:** 🟢 READY TO EXECUTE

Tenemos plan, scripts y entendimiento claro. Podemos terminar Prioridad 1 esta semana.

¿Ejecutamos?
