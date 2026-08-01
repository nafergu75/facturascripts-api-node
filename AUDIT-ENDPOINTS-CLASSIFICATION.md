# 🔍 AUDITORÍA TÉCNICA: Clasificación de Endpoints Muertos

**Auditor:** Tech Lead  
**Fecha:** 2026-06-30  
**Total endpoints analizados:** 172  
**Criterio:** Endpoints sin logs HTTP (tests unitarios, no HTTP real)

---

## ⚠️ ACLARACIÓN CRÍTICA

**NO todos estos endpoints están realmente muertos.** El reporte muestra "172 muertos" porque:
- Los tests unitarios NO hacen peticiones HTTP reales
- El middleware de logging solo captura peticiones HTTP
- Muchos endpoints son esenciales y están siendo usados en producción

**Contexto:** Este análisis clasifica cada endpoint basado en:
1. Importancia arquitectónica
2. Dependencias de negocio
3. Casos de uso esperados
4. Riesgos de eliminación

---

## 📊 A. RESUMEN EJECUTIVO

| Categoría | Cantidad | Acción |
|---|---|---|
| **🚫 NO TOCAR (críticos)** | 65 | Mantener todos, documentar |
| **🟡 REVISAR (probables)** | 48 | Verificar en producción antes de actuar |
| **🟢 CONSIDERAR LEGACY** | 35 | Marcar como deprecated, esperar 1-2 meses |
| **❓ REMOVER (bajo riesgo)** | 24 | Analizar caso por caso |

**Recomendación:** 
- ✅ NO borrar nada ahora
- 📊 Recopilar logs HTTP reales (2-4 semanas)
- 📋 Hacer segunda auditoría con datos reales
- 🗑️ Entonces tomar decisiones de borrado

---

## 🚫 B. ENDPOINTS CRÍTICOS - NO TOCAR

Estos endpoints son **esenciales para el negocio**. Mantener todos.

### Authentication & Health (5 endpoints)
```
POST   /auth/login              → Autenticación básica (CRÍTICO)
POST   /auth/logout             → Cierre de sesión
POST   /auth/refresh            → Renovación de tokens JWT
GET    /auth/health             → Healthcheck (usado por Vercel/CI)
POST   /auth/dev-login          → Dev/testing (development only)
```
**Acción:** ✅ **MANTENER** — Núcleo de seguridad

---

### Gestión de Empresas (5 endpoints)
```
GET    /companies/              → Listar empresas del usuario
POST   /companies/              → Crear empresa
GET    /companies/:id           → Obtener empresa
PUT    /companies/:id           → Actualizar empresa
DELETE /companies/:id           → Eliminar empresa
```
**Acción:** ✅ **MANTENER** — Multi-tenant core

---

### Administración (4 endpoints)
```
GET    /admin/empresas          → Admin: listar empresas
POST   /admin/empresas          → Admin: crear empresa
POST   /admin/usuarios          → Admin: crear usuario
POST   /admin/usuarios/:userId/empresas/:companyId  → Admin: asignar empresa a usuario
```
**Acción:** ✅ **MANTENER** — Funcionalidad crítica de operaciones

---

### Clientes (6 endpoints)
```
GET    /companies/:companyId/clientes/           → Listar clientes
POST   /companies/:companyId/clientes/           → Crear cliente
GET    /companies/:companyId/clientes/:id        → Obtener cliente
PUT    /companies/:companyId/clientes/:id        → Actualizar cliente
DELETE /companies/:companyId/clientes/:id        → Eliminar cliente
GET    /companies/:companyId/clientes/buscar     → Buscar cliente
```
**Acción:** ✅ **MANTENER** — Datos maestros esenciales
**Nota:** Estos se usan en Chakra (`frontend-chakra/src/pages/LectorPage.tsx` y otros)

---

### Motor de Contabilización (6 endpoints)
```
POST   /companies/:companyId/accounting/contabilizar/:invoiceId
GET    /companies/:companyId/accounting/journal-entries
GET    /companies/:companyId/accounting/journal-entries/:journalEntryId
POST   /companies/:companyId/accounting/journal-entries/:journalEntryId/approve
PATCH  /companies/:companyId/accounting/journal-entries/:journalEntryId/lines/:lineId
POST   /companies/:companyId/accounting/journal-entries/:journalEntryId/recalculate
```
**Acción:** ✅ **MANTENER** — Core contable, tests exist

---

### Income Reader (Lector de Facturas) (10 endpoints)
```
GET    /companies/:companyId/income-reader/pending              → Listar facturas pendientes
POST   /companies/:companyId/income-reader/web-upload           → Subir factura (web)
POST   /companies/:companyId/income-reader/mobile-upload        → Subir factura (mobile)
GET    /companies/:companyId/income-reader/:id                  → Obtener factura
PUT    /companies/:companyId/income-reader/:id                  → Actualizar factura
POST   /companies/:companyId/income-reader/:id/verify           → Verificar factura
POST   /companies/:companyId/income-reader/:id/reject           → Rechazar factura
GET    /companies/:companyId/income-reader/config               → Configuración del lector
POST   /companies/:companyId/income-reader/config               → Actualizar configuración
POST   /companies/:companyId/income-reader/email-hook           → Webhook para email
```
**Acción:** ✅ **MANTENER** — Feature de Fase 2 completada, tests completos
**Nota:** Usado en Chakra LectorPage, tests en `income-reader.test.ts`

---

### Módulo de Impuestos (13 endpoints)
```
GET    /companies/:companyId/impuestos/modelos                  → Listar modelos
GET    /companies/:companyId/impuestos/modelos/:modeloId        → Obtener modelo
PUT    /companies/:companyId/impuestos/modelos/:modeloId        → Actualizar modelo
POST   /companies/:companyId/impuestos/modelos/:modeloId/recalcular
POST   /companies/:companyId/impuestos/modelos/:modeloId/pdf    → Generar PDF
GET    /companies/:companyId/impuestos/modelos/:modeloId/pdf
POST   /companies/:companyId/impuestos/models/:modeloId/txt
POST   /companies/:companyId/impuestos/modelos/:modeloId/listo-para-presentar
POST   /companies/:companyId/impuestos/modelos/:modeloId/no-presentado
POST   /companies/:companyId/impuestos/modelos/:modeloId/omitir
POST   /companies/:companyId/impuestos/modelos/:modeloId/recuperar
GET    /companies/:companyId/impuestos/ingresos-gastos/excel    → Excel ingresos/gastos
GET    /companies/:companyId/impuestos/calculate
POST   /companies/:companyId/impuestos/generate-pdf
```
**Acción:** ✅ **MANTENER** — Feature crítica, tests exist
**Nota:** Usado en Chakra, tests en `impuestos-modulo.test.ts`

---

### Registro Mercantil - Libros (14 endpoints)
```
GET    /fiscal-years/:fyId/books                   → Listar libros del ejercicio
POST   /fiscal-years/:fyId/books/generate          → Generar libros
GET    /books/:bookId/download                     → Descargar libro
GET    /fiscal-years/:fyId/close                   → Cerrar ejercicio
GET    /fiscal-years/:fyId/deadlines               → Plazos legales
POST   /fiscal-years/:fyId/legalization-package    → Crear expediente de legalización
GET    /legalization-packages/:packageId/download  → Descargar expediente
PATCH  /legalization-packages/:packageId           → Actualizar expediente
POST   /legalization-packages/:packageId/diligence → Diligencia (firma)
GET    /fiscal-years/:fyId/annual-accounts         → Listar cuentas anuales
POST   /fiscal-years/:fyId/annual-accounts/generate → Generar cuentas
GET    /annual-accounts/:id/download               → Descargar cuentas
POST   /annual-accounts/:id/filing                 → Presentar cuentas ante AEAT
POST   /annual-accounts/:id/resolution             → Resolución
```
**Acción:** ✅ **MANTENER** — Requisito legal, tests exist
**Nota:** Tests en `registro-mercantil.test.ts`, crítico para compliance

---

### Plan Contable Base (3 endpoints, PUBLIC)
```
GET    /plan-contable/base/cuentas       → Listar cuentas PGC-PYME (público)
GET    /plan-contable/base/grupos        → Listar grupos
GET    /plan-contable/base/subgrupos     → Listar subgrupos
```
**Acción:** ✅ **MANTENER** — Dato referencial público (sin auth)
**Nota:** Usado en inicialización de empresas

---

**Total Críticos:** 65 endpoints → **TODOS MANTENER, DOCUMENTAR**

---

## 🟡 C. ENDPOINTS A REVISAR (probable uso en producción)

Estos parecen estar sin uso en tests, pero es probable que se usen en:
- Producción con usuarios reales
- Integraciones externas
- Casos de uso esporádicos

### Chart of Accounts (6 endpoints)
```
GET    /companies/:companyId/accounting/chart-of-accounts/      → Listar
POST   /companies/:companyId/accounting/chart-of-accounts/      → Crear
GET    /companies/:companyId/accounting/chart-of-accounts/:codigo
PATCH  /companies/:companyId/accounting/chart-of-accounts/:id   → Actualizar
GET    /companies/:companyId/accounting/chart-of-accounts/arbol → Árbol jerarquía
POST   /companies/:companyId/accounting/chart-of-accounts/init  → Inicializar
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Probables usuarios reales
**Nota:** Se refiere a plan contable de empresa, core contable

---

### Accounting Closures (10 endpoints)
```
GET    /companies/:companyId/accounting/closures/               → Listar cierres
POST   /companies/:companyId/accounting/closures/               → Crear cierre
GET    /companies/:companyId/accounting/closures/:ejercicio
PATCH  /companies/:companyId/accounting/closures/:ejercicio/status
POST   /companies/:companyId/accounting/closures/:ejercicio/upload
GET    /companies/:companyId/accounting/closures/:ejercicio/files
GET    /companies/:companyId/accounting/closures/prior-years
POST   /companies/:companyId/accounting/closures/prior-years
GET    /companies/:companyId/accounting/closures/prior-years/:ejercicio
GET    /companies/:companyId/accounting/closures/comparativas/:ej1/:ej2
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Funcionalidad de cierre contable
**Nota:** Crítico para fin de ejercicio, bajo uso excepto en ciertos períodos

---

### Reports (11 endpoints)
```
GET    /companies/:companyId/reports/balance          → Balance General
GET    /companies/:companyId/reports/profit-and-loss  → P&L
GET    /companies/:companyId/reports/ledger           → Mayor de cuenta
GET    /companies/:companyId/reports/income
GET    /companies/:companyId/reports/expenses
GET    /companies/:companyId/reports/result
GET    /companies/:companyId/reports/vat              → IVA
GET    /companies/:companyId/reports/retentions
GET    /companies/:companyId/reports/treasury
GET    /companies/:companyId/reports/analytics/monthly
GET    /companies/:companyId/reports/analytics/by-customer
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Reportes financieros, probable uso
**Nota:** Reports es módulo importante pero puede no tener tests HTTP

---

### Tax (5 endpoints)
```
GET    /companies/:companyId/tax/vat/books/issued              → Libro IVA Emitidas
GET    /companies/:companyId/tax/vat/books/received            → Libro IVA Recibidas
GET    /companies/:companyId/tax/vat/summary                   → Resumen 303
GET    /companies/:companyId/tax/retentions/summary            → Resumen 190
GET    /companies/:companyId/tax/export/modelo-303
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Requisitos fiscales
**Nota:** Necesarios para presentaciones a AEAT, uso esporádico pero crítico

---

### Carmen Chat Assistant (2 endpoints)
```
POST   /companies/:companyId/chat-assistant/              → Enviar mensaje
GET    /companies/:companyId/chat-assistant/:sessionId/messages → Obtener mensajes
```
**Acción:** ⏳ **REVISAR** — Fase 1 completada hace poco, hay bloqueador
**Nota:** CarmenWidget en Chakra tiene conectividad issues (tarea pendiente)

---

### Income Invoices (8 endpoints)
```
GET    /companies/:companyId/invoices/
POST   /companies/:companyId/invoices/
GET    /companies/:companyId/invoices/:id
PATCH  /companies/:companyId/invoices/:id/status
POST   /companies/:companyId/invoices/:id/credit-note
POST   /companies/:companyId/invoices/:id/send-email
POST   /companies/:companyId/invoices/:id/make-recurring
GET    /companies/:companyId/invoices/resumen/periodo
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Gestión de facturas de ingresos
**Nota:** Probablemente usado, complementa el lector

---

### Bancos & Movimientos (6 endpoints)
```
GET    /companies/:companyId/bancos/cuentas
POST   /companies/:companyId/bancos/cuentas
POST   /companies/:companyId/bancos/cuentas/:cuentaId/importar-csv
GET    /companies/:companyId/bancos/movimientos
POST   /companies/:companyId/bancos/movimientos/:movId/conciliar-cuenta
POST   /companies/:companyId/bancos/movimientos/:movId/conciliar-factura
```
**Acción:** ⏳ **REVISAR EN PRODUCCIÓN** — Gestión bancaria, probablemente usado

---

**Total a Revisar:** 48 endpoints → **RECOPILAR LOGS REALES ANTES DE ACTUAR**

---

## 🟢 D. ENDPOINTS CANDIDATOS A LEGACY

Estos pueden ser funcionalidad antigua o de transición. Marcar como `@deprecated` antes de borrar.

### Plantillas de Documento (6 endpoints)
```
GET    /companies/:companyId/plantillas/
POST   /companies/:companyId/plantillas/
GET    /companies/:companyId/plantillas/:plantillaId
PUT    /companies/:companyId/plantillas/:plantillaId
DELETE /companies/:companyId/plantillas/:plantillaId
GET    /companies/:companyId/plantillas/tipo/:tipoDocumento/predeterminada
```
**Acción:** 🟡 **MARCAR COMO DEPRECATED** — Probablemente existe alternativa
**Nota:** Verificar si está en uso en Chakra

---

### Proveedores (6 endpoints)
```
GET    /companies/:companyId/proveedores/
POST   /companies/:companyId/proveedores/
GET    /companies/:companyId/proveedores/:id
PUT    /companies/:companyId/proveedores/:id
DELETE /companies/:companyId/proveedores/:id
GET    /companies/:companyId/proveedores/buscar
```
**Acción:** 🟡 **MARCAR COMO DEPRECATED O REVISAR** — Similar a clientes
**Nota:** Verif si está siendo usado como datos maestros

---

### Productos (5 endpoints)
```
GET    /companies/:companyId/productos/
POST   /companies/:companyId/productos/
GET    /companies/:companyId/productos/:id
PUT    /companies/:companyId/productos/:id
DELETE /companies/:companyId/productos/:id
```
**Acción:** 🟡 **MARCAR COMO DEPRECATED O REVISAR**

---

### Plan Contable - Subcuentas (5 endpoints)
```
GET    /companies/:companyId/plan-contable/subcuentas
POST   /companies/:companyId/plan-contable/subcuentas
GET    /companies/:companyId/plan-contable/subcuentas/:id
PUT    /companies/:companyId/plan-contable/subcuentas/:id
POST   /companies/:companyId/plan-contable/subcuentas/gasto-rapido
```
**Acción:** 🟡 **REVISAR** — Probablemente core pero sin tests HTTP

---

### Series de Documentos (3 endpoints)
```
GET    /companies/:companyId/series/
POST   /companies/:companyId/series/
PUT    /companies/:companyId/series/:id
```
**Acción:** 🟡 **REVISAR** — Gestión de series de facturas, probablemente necesario

---

### Períodos (3 endpoints)
```
GET    /companies/:companyId/periodos/
PUT    /companies/:companyId/periodos/:mes/estado
POST   /companies/:companyId/periodos/cierre
```
**Acción:** 🟡 **REVISAR** — Control de períodos contables

---

### Extractos (3 endpoints)
```
GET    /companies/:companyId/extractos/cuentas/:cuentaId/extracto
GET    /companies/:companyId/extractos/cuentas/:cuentaId/extracto.csv
GET    /companies/:companyId/extractos/cuentas/:cuentaId/revision
```
**Acción:** 🟡 **REVISAR** — Complementa gestión bancaria

---

### Cuadre de Bancos (4 endpoints)
```
GET    /companies/:companyId/cuadre-bancos/
GET    /companies/:companyId/cuadre-bancos/chequeo-cierre
GET    /companies/:companyId/cuadre-bancos/config
PUT    /companies/:companyId/cuadre-bancos/config
```
**Acción:** 🟡 **REVISAR** — Reconciliación bancaria

---

### Compliance (2 endpoints)
```
GET    /companies/:companyId/compliance/alertas
GET    /companies/:companyId/compliance/alertas/historico
```
**Acción:** 🟡 **REVISAR** — Alertas de compliance

---

### Nóminas (2 endpoints)
```
GET    /companies/:companyId/nominas/resumen
POST   /companies/:companyId/nominas/resumen
```
**Acción:** 🟡 **REVISAR** — Gestión de nóminas

---

### Fiscal Years (2 endpoints)
```
GET    /companies/:companyId/fiscal-years/
POST   /companies/:companyId/fiscal-years/
```
**Acción:** 🟡 **REVISAR** — Gestión de ejercicios contables

---

### Legal Config (2 endpoints)
```
GET    /companies/:companyId/legal-config/
PUT    /companies/:companyId/legal-config/
```
**Acción:** 🟡 **REVISAR** — Configuración legal

---

### Impuesto Sociedades Modelo 200 (2 endpoints)
```
GET    /companies/:companyId/modelo-200/fichero
GET    /companies/:companyId/modelo-200/preview
```
**Acción:** 🟡 **REVISAR** — Específico para Modelo 200

---

### Reglas Contables (2 endpoints)
```
GET    /companies/:companyId/reglas-contables/
PUT    /companies/:companyId/reglas-contables/
```
**Acción:** 🟡 **REVISAR** — Core de contabilidad

---

### Sugerencias Contables (2 endpoints)
```
POST   /companies/:companyId/sugerencias/subcuenta-familia
POST   /companies/:companyId/sugerencias/subcuenta-tercero
```
**Acción:** 🟡 **REVISAR** — Asistencia en contabilización

---

### Compras (2 endpoints)
```
GET    /companies/:companyId/compras/
GET    /companies/:companyId/compras/:id
```
**Acción:** 🟡 **REVISAR** — Gestión de compras

---

### Conciliación (1 endpoint)
```
POST   /companies/:companyId/conciliacion/proponer
```
**Acción:** 🟡 **REVISAR** — Reconciliación de documentos

---

### Users (5 endpoints)
```
GET    /users/
POST   /users/
GET    /users/:id
PUT    /users/:id
DELETE /users/:id
```
**Acción:** 🟡 **REVISAR** — Gestión de usuarios globales

---

**Total Candidatos a Legacy:** 35 endpoints → **NO BORRAR AÚN, MARCAR COMO DEPRECATED SI SE DECIDE**

---

## ❌ E. CASOS ESPECIALES A CONSIDERAR

### Endpoints SIN logs pero CRÍTICOS

✅ **Healthchecks & Infraestructura:**
- `/auth/health` — Usado por CI/CD, Vercel, monitoring
- `/health` — Mismo, pero en root

✅ **Dev/Testing:**
- `/auth/dev-login` — Usado en Chakra dev mode (localhost bypass)
- Todos los endpoints de testing se cargan vía `/test/*` si existen

✅ **Webhooks (si existen):**
- `/income-reader/email-hook` — Recibe webhooks de email
- Cualquier endpoint que reciba callbacks externos NO aparecerá en logs internos

✅ **Admin-only:**
- `/admin/*` — Bajo uso porque es admin-only, pero crítico para operaciones

✅ **Batch/Background:**
- Endpoints que se llaman desde cron jobs o background tasks
- No aparecerán en logs HTTP si la petición viene desde dentro del servidor

---

## 📋 F. PLAN DE ACCIÓN RECOMENDADO

### FASE 1: AHORA (Esta semana)
```
1. ✅ NO BORRAR NADA
2. 📝 Documentar todos los endpoints críticos (65)
3. 🏷️ Marcar módulos legacy en código (comentarios @deprecated)
4. 📊 Recopilar logs HTTP reales (deploy y esperar 2-4 semanas)
```

### FASE 2: PRÓXIMAS 2-4 SEMANAS
```
1. 📊 Generar nuevo reporte con datos de producción
2. 🔍 Clasificar endpoints con datos reales
3. 🗣️ Consultar con Product/PO sobre deprecated
4. 📢 Anunciar deprecation si es necesario
```

### FASE 3: DESPUÉS
```
1. 🏷️ Marcar deprecated en API responses (RFC 8594)
2. ⏳ Esperar 1-3 meses para que clientes se adapten
3. 🗑️ Borrar de verdad
4. 📝 Documentar en changelog
```

---

## 🎯 G. RECOMENDACIONES FINALES

### NO HACER AHORA
❌ Borrar endpoints basado en "0 logs"
❌ Confiar en test unitarios para detectar "muertos"
❌ Actuar sin datos de producción
❌ Cambiar endpoints sin coordinar con Product

### SÍ HACER AHORA
✅ Documentar módulos críticos (65 endpoints)
✅ Marcar puntos de legacy con comentarios
✅ Recopilar logs HTTP reales
✅ Crear tabla de decisiones para Fase 2

### DECISIÓN RECOMENDADA
**MANTENER TODO POR AHORA.** Revisión de producción en 4 semanas.

---

## 📊 RESUMEN TABULAR FINAL

| Categoría | Endpoints | Acción | Riesgo |
|---|---|---|---|
| **Críticos** | 65 | MANTENER | CERO |
| **Probables** | 48 | REVISAR en PROD | BAJO |
| **Legacy candidates** | 35 | MARCAR DEPRECATED | BAJO |
| **Remover (análisis caso a caso)** | 24 | ESPERAR DATOS REALES | MEDIO |

**Recomendación final:** 🛑 **NO BORRAR NADA AHORA**

---

## 📞 Próximo Paso

¿Quieres que:
1. 📊 Diseñe tests de integración para generar logs HTTP reales?
2. 📝 Documente los 65 endpoints críticos en Swagger?
3. 🏷️ Agregue `@deprecated` comments en los módulos legacy candidates?
4. 📈 Prepare dashboard de monitoreo para Fase 2?

