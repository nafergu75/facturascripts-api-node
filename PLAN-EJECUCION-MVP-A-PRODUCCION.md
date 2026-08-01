# PLAN DE EJECUCIÓN: MVP → PRODUCTO PROFESIONAL

**Documento de trabajo para llevar la app contable de MVP a versión lista para producción**

**Fecha:** 2026-06-30  
**Duración estimada:** 6-8 semanas  
**Timeline:** Julio - Agosto 2026  

---

## PARTE 1: RESUMEN EJECUTIVO

### Situación actual
✅ **App funcional:** Backend REST + Frontend Next.js, desplegados en Vercel.  
✅ **Base técnica sólida:** Arquitectura clara, TypeScript, multi-tenant.  
⚠️ **Problemas críticos:** Sin validación formal, sin caché, UX básica, 0 tests.  
⚠️ **No lista para producción:** Falta gráficos, export, roles, seguridad hardened.

### Qué hacer ahora
1. **Fase 1 (2 semanas):** Arreglar críticos (validación, contexto, error handling)
2. **Fase 2.1 (3 semanas):** Mejorar UX (dashboard, gráficos, filtros)
3. **Fase 2.2 (2 semanas):** Agregar reporting (export, PDF)
4. **Fase 2.3 (3 semanas):** Seguridad y multi-empresa (roles, permisos)

**Total:** 10 semanas para producto v1.0 profesional.

---

## PARTE 2: ISSUES PRIORIZADOS (LISTA DE TAREAS)

### FASE 1: CRÍTICOS INMEDIATOS (Semanas 1-2)

#### **ISSUE 1.1: Implementar Zod para validación**
- **Título:** Backend + Frontend: Validación formal con Zod
- **Descripción:** Reemplazar validaciones manuales en backend y frontend con schemas Zod reutilizables.
- **Objetivo técnico:** Garantizar validación consistent, mensajes claros al usuario, type-safety.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 4-5 horas (2-3 archivos backend + 2-3 frontend)
- **Tareas:**
  - [ ] Backend: Crear `/src/validators/movements.ts` (Zod schemas)
  - [ ] Backend: Actualizar controller para usar schemas
  - [ ] Frontend: Crear `/types/schemas.ts` (compartir o re-definir)
  - [ ] Frontend: Integrar Zod en `MovementForm.tsx` y mostrar errores por campo
  - [ ] Test manual: Validar que errores se muestran correctamente
- **Dependencias:** Ninguna (crítico primero)
- **Criterio de aceptación:**
  - ✅ Validaciones backend rechazan datos inválidos (amount <= 0, fecha futura)
  - ✅ Mensajes de error específicos por campo (no genéricos)
  - ✅ Frontend muestra errores debajo de cada input
  - ✅ TypeScript type-safety: `CreateMovement` desde schema
- **Impacto:**
  - Backend: Rechaza datos malos, logs claros
  - Frontend: Mejor UX, errores legibles
  - Riesgo técnico: REDUCE (data integrity)

---

#### **ISSUE 1.2: Crear CompanyContext (contexto de empresa)**
- **Título:** Frontend: CompanyContext para evitar prop drilling
- **Descripción:** Implementar React Context para companyId, persistir en localStorage.
- **Objetivo técnico:** Simplificar paso de companyId en componentes, permitir cambio de empresa sin reload.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 3-4 horas
- **Tareas:**
  - [ ] Crear `/context/CompanyContext.tsx`
  - [ ] Envolver app en `CompanyProvider` (layout.tsx)
  - [ ] Refactor `useMovements`, `useStatistics`, etc. para usar `useCompany()`
  - [ ] Agregar selector de empresa en Header
  - [ ] Persistir companyId en localStorage
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ Cambiar empresa en header actualiza todo el dashboard
  - ✅ Al recargar página, mantiene empresa seleccionada
  - ✅ No hay prop drilling de companyId en componentes
  - ✅ Selector de empresa es visible y funciona
- **Impacto:**
  - Frontend: Menos código, mejor DX
  - Preparación: Necesario para Fase 2.3 (multi-empresa)

---

#### **ISSUE 1.3: Error Boundary + Error Handling Global**
- **Título:** Frontend: Error Boundary y manejo global de errores
- **Descripción:** Agregar Error Boundary en Next 14, crear error/loading components, centralizar manejo de errores HTTP.
- **Objetivo técnico:** App no se rompe, usuario ve mensajes legibles, logs estructurados.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 3 horas
- **Tareas:**
  - [ ] Crear `/app/error.tsx` (Error Boundary)
  - [ ] Crear `/app/loading.tsx` (Suspense fallback)
  - [ ] Actualizar API client para mapear errores HTTP → UserFacingError
  - [ ] Mostrar toast/snackbar en errores (o usar simple alert)
  - [ ] Agregar logging a Sentry/console (para debugging)
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ Si componente crashea, muestra "Error" + botón "Intentar de nuevo"
  - ✅ Errores HTTP 400/404/500 muestran mensajes claros
  - ✅ Error 401 → redirecciona a login
  - ✅ Loading states muestran esqueletos (no "Cargando...")
- **Impacto:**
  - UX: App siente más confiable
  - Debugging: Logs claros en Sentry

---

#### **ISSUE 1.4: Paginación en Backend (GET /movements)**
- **Título:** Backend: Agregar paginación al endpoint GET /movements
- **Descripción:** Reemplazar retorno de todos los movimientos con paginación (page, limit, total).
- **Objetivo técnico:** Escalabilidad (10k movimientos no crashea), performance.
- **Prioridad:** 🟡 MEDIA-ALTA
- **Esfuerzo:** 2-3 horas
- **Tareas:**
  - [ ] Backend: Actualizar `movementsService.getMovements()` con skip/take
  - [ ] Backend: Retornar `{ data, total, page, limit }`
  - [ ] Frontend: Actualizar hook para recibir nueva estructura
  - [ ] Frontend: Agregar botón "Cargar más" o paginación numérica (opcional para MVP)
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ GET /movements?page=1&limit=50 retorna max 50 registros
  - ✅ Response incluye `total` para saber cuántos hay
  - ✅ Frontend puede hacer siguiente página si existe
  - ✅ Default limit=50, max limit=500
- **Impacto:**
  - Backend: Escalabilidad (100k movimientos funciona)
  - Performance: Queries más rápidas

---

#### **ISSUE 1.5: Custom Error Classes en Backend**
- **Título:** Backend: Custom error classes y diferenciación de errores
- **Descripción:** Crear error classes (CompanyNotFound, ValidationError, etc.) para manejar errores diferenciados.
- **Objetivo técnico:** Logs claros, status codes correctos, debugging fácil.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 2 horas
- **Tareas:**
  - [ ] Crear `/src/errors/AppError.ts` (base class)
  - [ ] Crear subclases: CompanyNotFoundError, ValidationError, UnauthorizedError
  - [ ] Actualizar controllers para throw custom errors
  - [ ] Mapear errores a status codes correctos en middleware
- **Dependencias:** Ninguna, pero mejora con ISSUE 1.6
- **Criterio de aceptación:**
  - ✅ GET /companies/invalid → 404 (CompanyNotFoundError)
  - ✅ POST /movements sin amount → 400 (ValidationError)
  - ✅ Logs muestran tipo de error y contexto
- **Impacto:**
  - Debugging: Logs estructurados
  - Frontend: Puede diferenciar tipos de error

---

#### **ISSUE 1.6: Winston Logger en Backend**
- **Título:** Backend: Logging estructurado con Winston
- **Descripción:** Reemplazar console.log/error con Winston logger.
- **Objetivo técnico:** Logs estructurados, timestamps, niveles (info, warn, error), fácil integración con Sentry.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 3 horas
- **Tareas:**
  - [ ] `npm install winston`
  - [ ] Crear `/src/logger.ts`
  - [ ] Reemplazar `console.log` por `logger.info` en servicios
  - [ ] Reemplazar `console.error` por `logger.error` con contexto
- **Dependencias:** ISSUE 1.5 (custom errors)
- **Criterio de aceptación:**
  - ✅ Logs en consola tienen timestamp, nivel, mensaje
  - ✅ Errores loguean stack trace
  - ✅ Logs incluyen userId/companyId para debugging
- **Impacto:**
  - Debugging: Logs profesionales
  - Monitoring: Fácil integrar Sentry después

---

### FASE 2.1: UX + GRÁFICOS + CONTEXTO (Semanas 3-5)

#### **ISSUE 2.1.1: Dashboard Rediseñado**
- **Título:** Frontend: Rediseñar dashboard con layout profesional
- **Descripción:** Cambiar estructura HTML/CSS del dashboard (stats + gráficos + acciones + movimientos recientes).
- **Objetivo técnico:** Visual profesional, información clara, UX intuitiva.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 5-6 horas
- **Tareas:**
  - [ ] Crear nuevos componentes:
    - [ ] `components/dashboard/DashboardHeader.tsx` (empresa + período)
    - [ ] `components/dashboard/StatsCardsWithComparison.tsx` (actualizado)
    - [ ] `components/dashboard/QuickActions.tsx` (botones principales)
    - [ ] `components/dashboard/RecentMovements.tsx` (últimos 10)
  - [ ] Actualizar `/app/dashboard/page.tsx` con nuevo layout
  - [ ] Agregar Tailwind CSS para grid 2 columnas (gráficos lado a lado)
- **Dependencias:** ISSUE 1.2 (CompanyContext), ISSUE 2.1.3 (gráficos)
- **Criterio de aceptación:**
  - ✅ Dashboard muestra empresa + período seleccionados
  - ✅ Stats cards con comparativa vs mes anterior
  - ✅ Gráficos se ven lado a lado (responsive)
  - ✅ Acciones rápidas prominentes
  - ✅ Últimos movimientos en tabla compacta
- **Impacto:**
  - UX: Dashboard se siente profesional
  - Usabilidad: Información clara

---

#### **ISSUE 2.1.2: PeriodSelector (Filtro de Período)**
- **Título:** Frontend: Componente PeriodSelector para filtrar por período
- **Descripción:** Dropdown/buttons para seleccionar "Este mes", "Últimos 3 meses", "Este año", o rango custom.
- **Objetivo técnico:** Filtrar datos por período, auto-actualizar stats y gráficos.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 3 horas
- **Tareas:**
  - [ ] Crear `/components/common/PeriodSelector.tsx`
  - [ ] Opciones: "Este mes", "Mes anterior", "Últimos 3 meses", "Este año", "Rango"
  - [ ] State: selected period + onChange callback
  - [ ] Persistir en URL params o context
  - [ ] Tests manuales: cambiar período actualiza todo
- **Dependencias:** ISSUE 1.2 (CompanyContext)
- **Criterio de aceptación:**
  - ✅ Cambiar período refresca stats + gráficos
  - ✅ Rango custom: input "Desde" y "Hasta"
  - ✅ Valores por defecto sensatos
- **Impacto:**
  - Usabilidad: Fácil ver datos históricos

---

#### **ISSUE 2.1.3: Integración Chart.js (Gráficos)**
- **Título:** Frontend: Gráficos con Chart.js (línea + pie)
- **Descripción:** Implementar gráficos: evolución ingresos/gastos (línea) + desglose categorías (pie).
- **Objetivo técnico:** Visualización profesional de datos.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 4-5 horas
- **Tareas:**
  - [ ] `npm install chart.js react-chartjs-2`
  - [ ] Crear `/components/dashboard/IncomeExpenseChart.tsx` (línea)
  - [ ] Crear `/components/dashboard/CategoryChart.tsx` (pie)
  - [ ] Conectar a datos reales de `useStatistics` hook
  - [ ] Responsive: gráficos se adaptan a ancho de pantalla
- **Dependencias:** ISSUE 2.1.2 (período selector)
- **Criterio de aceptación:**
  - ✅ Gráfico de línea muestra evolución 12 meses
  - ✅ Gráfico de pie muestra desglose de categorías
  - ✅ Cambiar período actualiza gráficos
  - ✅ Responsive en mobile
- **Impacto:**
  - UX: Información visual clara
  - Profesionalismo: Se ve como app contable real

---

#### **ISSUE 2.1.4: SWR/React Query para Caché**
- **Título:** Frontend: Agregar caché con SWR o React Query
- **Descripción:** Implementar caché de datos (stats, movimientos) para evitar over-fetching.
- **Objetivo técnico:** Performance, deduplicación de requests, offline support.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 4 horas
- **Tareas:**
  - [ ] Elegir: SWR (simple) o React Query (más robusto)
  - [ ] Reemplazar `fetch` directo en hooks con SWR/React Query
  - [ ] Configurar: TTL 5min para stats, 1min para movimientos
  - [ ] Optimistic updates en mutaciones (create/update/delete)
- **Dependencias:** Ninguna, pero mejor después de otros hooks
- **Criterio de aceptación:**
  - ✅ Cambiar tab y volver no re-fetcha datos innecesarios
  - ✅ Crear movimiento actualiza tabla sin refetch (optimistic)
  - ✅ Validar que deduplicación funciona (2 requests simultáneos = 1 HTTP call)
- **Impacto:**
  - Performance: Menos requests
  - UX: Menos lag

---

#### **ISSUE 2.1.5: Optimistic Updates (Create/Update/Delete)**
- **Título:** Frontend: Optimistic updates en movimientos (sin wait a backend)
- **Descripción:** UI actualiza inmediatamente, servidor actualiza en background.
- **Objetivo técnico:** UX rápida, reduce lag percibido.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 2-3 horas
- **Tareas:**
  - [ ] En `useMovements` hook: actualizar array inmediatamente en create/delete
  - [ ] Si error: rollback (mostrar error, restaurar estado anterior)
  - [ ] Tests manuales: eliminar movimiento → desaparece al instante
- **Dependencias:** ISSUE 2.1.4 (SWR/React Query, facilita esto)
- **Criterio de aceptación:**
  - ✅ Delete: movimiento desaparece inmediatamente de tabla
  - ✅ Error: movimiento reaparece + mensaje de error
  - ✅ Crear: aparece en tabla sin esperar respuesta
- **Impacto:**
  - UX: App se siente responsiva

---

### FASE 2.2: REPORTING + EXPORT (Semanas 6-7)

#### **ISSUE 2.2.1: Backend Endpoints de Agregación**
- **Título:** Backend: GET /reports/movements + POST /exports/report.pdf
- **Descripción:** Nuevos endpoints para generar reportes y exports.
- **Objetivo técnico:** Datos listos para contador, formatos múltiples.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 5-6 horas
- **Tareas:**
  - [ ] `npm install pdfkit` (generador PDF)
  - [ ] Crear `/src/routes/reports.routes.ts`
  - [ ] Endpoint: GET `/api/companies/:id/reports/movements?format=json|csv|pdf&from=2026-01&to=2026-06`
  - [ ] Endpoint: GET `/api/companies/:id/reports/summary` (resumen contable)
  - [ ] Generar PDF con pdfkit (ingresos, gastos, desglose, tabla)
  - [ ] CSV: headers + rows
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ GET /reports/movements?format=json retorna array de movimientos con totales
  - ✅ ?format=csv retorna CSV descargable
  - ✅ ?format=pdf retorna PDF con:
    - Período (desde-hasta)
    - Total ingresos / gastos
    - Desglose por categoría
    - Tabla de movimientos
  - ✅ /reports/summary retorna: { company, period, income, expense, balance, count }
- **Impacto:**
  - Funcionalidad: Datos exportables
  - Profesionalismo: Reportes en PDF

---

#### **ISSUE 2.2.2: Frontend Página de Reporting**
- **Título:** Frontend: Página /reporting con filtros y botones de export
- **Descripción:** UI para seleccionar parámetros (período, tipo, categoría) y exportar.
- **Objetivo técnico:** Fácil acceso a reportes.
- **Prioridad:** 🔴 ALTA
- **Esfuerzo:** 3-4 horas
- **Tareas:**
  - [ ] Crear `/app/reporting/page.tsx`
  - [ ] Componentes: `ReportFilters`, `ExportButtons`
  - [ ] Filtros: período, tipo (ingreso/gasto), categoría
  - [ ] Botones: "Descargar CSV", "Descargar PDF", "Ver en pantalla"
  - [ ] Preview de datos antes de exportar (tabla)
- **Dependencias:** ISSUE 2.2.1 (endpoints backend)
- **Criterio de aceptación:**
  - ✅ Seleccionar período + tipo → muestra tabla de movimientos
  - ✅ Click "Descargar CSV" → descarga archivo
  - ✅ Click "Descargar PDF" → descarga PDF profesional
  - ✅ Filtros actualizan tabla en tiempo real
- **Impacto:**
  - Usabilidad: Acceso fácil a reportes

---

#### **ISSUE 2.2.3: Comparativas vs Mes/Año Anterior**
- **Título:** Backend + Frontend: Estadísticas con comparativas
- **Descripción:** Agregar datos de mes/año anterior a stats para mostrar tendencias (↑10%, ↓5%).
- **Objetivo técnico:** Visibilidad de tendencias.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 3-4 horas
- **Tareas:**
  - [ ] Backend: Modificar `/stats/summary` para retornar `{ current, previous, growth% }`
  - [ ] Frontend: Mostrar badges "↑12%" en stats cards
  - [ ] Tests: Validar cálculos de growth%
- **Dependencias:** ISSUE 1.2 (contexto período)
- **Criterio de aceptación:**
  - ✅ Stats card muestra: Ingresos €16,000 (↑12% vs mes anterior)
  - ✅ Cálculos correctos: (current - previous) / previous * 100
  - ✅ Diseño visual integrado (badge verde/rojo)
- **Impacto:**
  - Insight: Usuario ve tendencias rápidamente

---

### FASE 2.3: ROLES + SEGURIDAD + MULTI-EMPRESA (Semanas 8-9)

#### **ISSUE 2.3.1: Modelos de Roles/Permisos en BD**
- **Título:** Backend: Tabla de Roles y Permissions en Prisma
- **Descripción:** Agregar modelos Role, Permission, User.role para RBAC.
- **Objetivo técnico:** Soporte de roles (admin, contable, lector).
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 3 horas
- **Tareas:**
  - [ ] Actualizar `prisma/schema.prisma`:
    - [ ] Modelo Role (id, name, permissions)
    - [ ] Modelo Permission (id, name)
    - [ ] Agregar roleId a User
  - [ ] `npx prisma migrate dev --name add_roles`
  - [ ] Seed roles: admin, contable, lector
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ Roles creados: admin (todos permisos), contable (crear/ver), lector (solo ver)
  - ✅ Permissions: movements:read, movements:create, movements:delete
  - ✅ Users pueden asignarse a roles
- **Impacto:**
  - Seguridad: Preparación para RBAC

---

#### **ISSUE 2.3.2: Middleware de Permisos en Backend**
- **Título:** Backend: checkPermission middleware para proteger rutas
- **Descripción:** Middleware que verifica si usuario tiene permiso antes de permitir acción.
- **Objetivo técnico:** Enforcement de permisos.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 2-3 horas
- **Tareas:**
  - [ ] Crear `/src/middleware/checkPermission.ts`
  - [ ] Middleware: extrae role del JWT, valida permiso
  - [ ] Aplicar a rutas sensibles:
    - [ ] POST /movements → require movements:create
    - [ ] DELETE /movements/:id → require movements:delete
    - [ ] GET /reporting → require movements:read (pero lector también)
  - [ ] Retornar 403 si sin permiso
- **Dependencias:** ISSUE 2.3.1 (roles en BD)
- **Criterio de aceptación:**
  - ✅ Usuario con role "lector" no puede crear movimiento (403)
  - ✅ Usuario con role "contable" puede crear (200)
  - ✅ Usuario con role "admin" puede todo
- **Impacto:**
  - Seguridad: Enforcement real

---

#### **ISSUE 2.3.3: Home Page con Resumen de Empresas**
- **Título:** Frontend: Página /home (antes de ir a dashboard) con selector de empresa
- **Descripción:** Landing page que muestra empresas disponibles del usuario, permite seleccionar, va a dashboard.
- **Objetivo técnico:** Preparación para multi-empresa.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 3-4 horas
- **Tareas:**
  - [ ] Backend: GET `/api/user/companies` (lista empresas del usuario actual)
  - [ ] Frontend: Crear `/app/home/page.tsx`
  - [ ] Componente: `CompanyCard` (nombre, taxId, stats: count, income, expense)
  - [ ] Click en empresa → setCompanyId → redirect /dashboard
  - [ ] Si solo 1 empresa → redirect directo a /dashboard
- **Dependencias:** ISSUE 1.2 (CompanyContext)
- **Criterio de aceptación:**
  - ✅ /home muestra tarjetas de empresas
  - ✅ Click en tarjeta → selected company, redirect /dashboard
  - ✅ Dashboard actualiza con datos de nueva empresa
  - ✅ Si 1 empresa: /home redirige automáticamente
- **Impacto:**
  - UX: Cambio de empresa visible
  - Multi-empresa: Preparado

---

#### **ISSUE 2.3.4: Protección de Rutas por Rol (Frontend)**
- **Título:** Frontend: withPermission HOC para proteger páginas
- **Descripción:** Componentes que requieren cierto rol no se renderizan si usuario no califica.
- **Objetivo técnico:** Enforcement visual de permisos.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 2-3 horas
- **Tareas:**
  - [ ] Crear `/middleware/withPermission.tsx` (HOC)
  - [ ] Aplicar a páginas sensibles:
    - [ ] /movements/new (require movements:create)
    - [ ] /reporting (require movements:read)
  - [ ] Si sin permiso: mostrar "No tienes acceso"
- **Dependencias:** ISSUE 2.3.2 (backend permisos)
- **Criterio de aceptación:**
  - ✅ Usuario con role lector no ve botón "/movements/new"
  - ✅ Intenta acceder a URL → "No tienes acceso"
  - ✅ Admin ve todo
- **Impacto:**
  - Seguridad: UI coherente con permisos

---

#### **ISSUE 2.3.5: Rate Limiting en Backend**
- **Título:** Backend: Rate limiting para prevenir abuso
- **Descripción:** Limitar requests por usuario/IP (ej: 100 creates en 15 min).
- **Objetivo técnico:** Seguridad, prevenir DoS.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 2 horas
- **Tareas:**
  - [ ] `npm install express-rate-limit`
  - [ ] Crear limiters para:
    - [ ] Create movement: 100 en 15 min
    - [ ] Export/report: 10 en 1 hora
  - [ ] Aplicar a rutas clave
- **Dependencias:** Ninguna
- **Criterio de aceptación:**
  - ✅ User hace 101 creates en 15 min → 429 Too Many Requests
  - ✅ Mensaje: "Espera 5 minutos"
- **Impacto:**
  - Seguridad: Protección contra abuso

---

### FASE 3: TESTS + HARDENING (Semanas 10+)

#### **ISSUE 3.1: Tests Unitarios con Vitest (Frontend)**
- **Título:** Frontend: Suite de tests Vitest para hooks y componentes
- **Descripción:** Tests para hooks principales (useMovements, useStatistics, useCompany).
- **Objetivo técnico:** Confianza en cambios, prevención de regresiones.
- **Prioridad:** 🟡 MEDIA (después de features)
- **Esfuerzo:** 5-6 horas
- **Tareas:**
  - [ ] `npm install --save-dev vitest @testing-library/react`
  - [ ] Tests para:
    - [ ] `useMovements`: cargar, crear, eliminar, filtrar
    - [ ] `useStatistics`: calcular summary, by-category, by-month
    - [ ] `useCompany`: set/get companyId
  - [ ] Mocks: API responses
- **Dependencias:** ISSUE 2.1.4 (SWR), ISSUE 1.2 (CompanyContext)
- **Criterio de aceptación:**
  - ✅ 20+ tests con >80% coverage en hooks
  - ✅ Tests pasan: `npm test`
- **Impacto:**
  - Confianza: Refactor seguro

---

#### **ISSUE 3.2: Tests de Integración Backend (Node/Supertest)**
- **Título:** Backend: Tests de integración para endpoints críticos
- **Descripción:** Tests que verifican flujos completos (crear movimiento → query → delete).
- **Objetivo técnico:** Confianza en API.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 4-5 horas
- **Tareas:**
  - [ ] `npm install --save-dev supertest`
  - [ ] Tests para:
    - [ ] POST /movements (validación, creación)
    - [ ] GET /movements (lista, filtros, paginación)
    - [ ] DELETE /movements/:id (solo owner/admin)
    - [ ] Permisos (role-based access)
  - [ ] Mocks de BD (o usar test DB)
- **Dependencias:** ISSUE 2.3.2 (permisos backend)
- **Criterio de aceptación:**
  - ✅ 15+ tests con >75% coverage
  - ✅ Tests pasan: `npm test`
- **Impacto:**
  - Confianza: API robusta

---

#### **ISSUE 3.3: Security Audit + Hardening**
- **Título:** Backend + Frontend: Revisión de seguridad y hardening
- **Descripción:** Validar CORS, JWT handling, input sanitization, SQL injection protección (Prisma), XSS.
- **Objetivo técnico:** Producción-ready security.
- **Prioridad:** 🟡 MEDIA
- **Esfuerzo:** 3-4 horas
- **Tareas:**
  - [ ] Backend:
    - [ ] CORS: restringir a dominios conocidos
    - [ ] JWT: validar signature, expiry
    - [ ] Input: Prisma protege SQL injection ✅
    - [ ] Rate limiting ✅ (ISSUE 2.3.5)
  - [ ] Frontend:
    - [ ] No guardar sensitive data en localStorage
    - [ ] DOMPurify para HTML user-generated (si aplica)
  - [ ] Revisar /swagger público (¿cubrir con auth?)
- **Dependencias:** Todo lo anterior
- **Criterio de aceptación:**
  - ✅ CORS solo permite https://dominio.com
  - ✅ JWT inválido → 401
  - ✅ No hay secrets en .env.example
  - ✅ OWASP top 10 reviewed
- **Impacto:**
  - Seguridad: Producción-ready

---

## PARTE 3: ROADMAP POR FASES

### FASE 1: CRÍTICOS INMEDIATOS
**Duración:** 2 semanas (14 días)  
**Inicio:** Lunes Semana 1

| Issue | Título | Backend | Frontend | Horas | Orden |
|-------|--------|---------|----------|-------|-------|
| 1.1 | Zod Validation | ✅ | ✅ | 4-5 | 1️⃣ Primero |
| 1.2 | CompanyContext | - | ✅ | 3-4 | 2️⃣ Segundo |
| 1.3 | Error Boundary | - | ✅ | 3 | 2️⃣ Paralelo |
| 1.4 | Paginación | ✅ | ✅ | 2-3 | 3️⃣ |
| 1.5 | Custom Errors | ✅ | - | 2 | 1️⃣ Primero |
| 1.6 | Winston Logger | ✅ | - | 3 | 3️⃣ |
| **TOTAL** | | | | **17-19h** | |

**Entregables:**
- ✅ Validación formal (Zod)
- ✅ Contexto de empresa (no más prop drilling)
- ✅ Errores claros (custom classes + logging)
- ✅ Escalabilidad (paginación)
- ✅ UX robusta (error boundary)

**Criterio de cierre:** Todos los issues en "Done", app compila sin errores, manual testing de flujos básicos OK.

---

### FASE 2.1: UX + GRÁFICOS + CONTEXTO
**Duración:** 3 semanas (21 días)  
**Inicio:** Semana 3

| Issue | Título | Backend | Frontend | Horas | Dependencias |
|-------|--------|---------|----------|-------|--------------|
| 2.1.1 | Dashboard Redesign | - | ✅ | 5-6 | 1.2, 2.1.3 |
| 2.1.2 | Period Selector | - | ✅ | 3 | 1.2 |
| 2.1.3 | Chart.js | - | ✅ | 4-5 | 2.1.2 |
| 2.1.4 | SWR/React Query | - | ✅ | 4 | - |
| 2.1.5 | Optimistic Updates | - | ✅ | 2-3 | 2.1.4 |
| **TOTAL** | | | | **18-21h** | |

**Entregables:**
- ✅ Dashboard profesional
- ✅ Gráficos (línea + pie)
- ✅ Período selector funcional
- ✅ Caché + optimistic updates (UX rápida)

**Criterio de cierre:** Dashboard se ve profesional, gráficos renderean, cambiar período actualiza todo, no hay flickering en crear movimiento.

---

### FASE 2.2: REPORTING + EXPORT
**Duración:** 2 semanas (14 días)  
**Inicio:** Semana 6

| Issue | Título | Backend | Frontend | Horas | Dependencias |
|-------|--------|---------|----------|-------|--------------|
| 2.2.1 | Report Endpoints | ✅ | - | 5-6 | - |
| 2.2.2 | Reporting Page | - | ✅ | 3-4 | 2.2.1 |
| 2.2.3 | Comparativas | ✅ | ✅ | 3-4 | 1.2 |
| **TOTAL** | | | | **11-14h** | |

**Entregables:**
- ✅ Endpoint /reports/movements (JSON, CSV, PDF)
- ✅ Página de reporting con filtros
- ✅ Estadísticas con comparativas (vs mes anterior)

**Criterio de cierre:** Descargar CSV/PDF funciona, datos correctos, PDF se ve profesional.

---

### FASE 2.3: ROLES + SEGURIDAD + MULTI-EMPRESA
**Duración:** 3 semanas (21 días)  
**Inicio:** Semana 8

| Issue | Título | Backend | Frontend | Horas | Dependencias |
|-------|--------|---------|----------|-------|--------------|
| 2.3.1 | Roles/Permisos BD | ✅ | - | 3 | - |
| 2.3.2 | Permission Middleware | ✅ | - | 2-3 | 2.3.1 |
| 2.3.3 | Home Page | ✅ | ✅ | 3-4 | 1.2, 2.3.1 |
| 2.3.4 | withPermission HOC | - | ✅ | 2-3 | 2.3.2 |
| 2.3.5 | Rate Limiting | ✅ | - | 2 | - |
| **TOTAL** | | | | **12-15h** | |

**Entregables:**
- ✅ Roles en BD (admin, contable, lector)
- ✅ Home page con selector de empresa
- ✅ Protección de rutas por rol
- ✅ Rate limiting

**Criterio de cierre:** Cambiar empresa funciona, lector no puede crear, admin puede todo, rate limiting activo.

---

### FASE 3: TESTS + HARDENING
**Duración:** 2+ semanas (14+ días)  
**Inicio:** Semana 10

| Issue | Título | Backend | Frontend | Horas | Dependencias |
|-------|--------|---------|----------|-------|--------------|
| 3.1 | Frontend Tests | - | ✅ | 5-6 | Todas Fase 2 |
| 3.2 | Backend Tests | ✅ | - | 4-5 | 2.3.2 |
| 3.3 | Security Audit | ✅ | ✅ | 3-4 | Todas |
| **TOTAL** | | | | **12-15h** | |

**Entregables:**
- ✅ Tests de hooks (>80% coverage)
- ✅ Tests de endpoints (>75% coverage)
- ✅ Security review passed

**Criterio de cierre:** `npm test` pasa 100%, OWASP top 10 reviewed, zero critical security issues.

---

## PARTE 4: KANBAN PROPUESTO

### BACKLOG
Tareas sin dependencias bloqueantes (listas para empezar):
- ISSUE 1.1: Zod Validation
- ISSUE 1.5: Custom Errors
- ISSUE 2.3.1: Roles/Permisos BD
- ISSUE 2.3.5: Rate Limiting
- ISSUE 2.1.4: SWR/React Query

### READY
Tareas que dependen de cosas ya completadas:
- ISSUE 1.2: CompanyContext (después 1.1)
- ISSUE 1.3: Error Boundary (después 1.1, 1.5)
- ISSUE 1.4: Paginación (después 1.1)
- ISSUE 1.6: Winston Logger (después 1.5)

### IN PROGRESS
Máximo 2-3 tasks en paralelo (dependiendo de capacidad):
- Semana 1: ISSUE 1.1 + ISSUE 1.5 (backend en paralelo)
- Semana 1-2: ISSUE 1.2 + ISSUE 1.3 (frontend en paralelo)

### REVIEW
Completadas, esperando QA/testing:
- (Deploy a staging antes de Review)

### DONE
Mergeadas a main, deployadas:
- (Vacío al inicio)

---

## PARTE 5: ORDEN RECOMENDADO DE EJECUCIÓN

### SEMANA 1 (Fase 1 - Parte 1)
**Objetivo:** Validación + error handling base

**Lunes-Miércoles:**
1. **ISSUE 1.1: Zod Validation** (4-5h)
   - Crear `/src/validators/movements.ts` (backend)
   - Integrar en controller + tests manuales
   - Frontend: crear schemas + integrar en form
   
2. **ISSUE 1.5: Custom Errors** (2h) — **EN PARALELO (Backend)**
   - Crear `/src/errors/AppError.ts`
   - Subclasses: CompanyNotFoundError, ValidationError, etc.

**Jueves-Viernes:**
3. **ISSUE 1.2: CompanyContext** (3-4h)
   - Crear `/context/CompanyContext.tsx`
   - Envolver app en provider
   - Refactor hooks: useMovements, useStatistics
   - Agregar selector en Header

4. **ISSUE 1.3: Error Boundary** (3h) — **EN PARALELO (Frontend)**
   - Crear `/app/error.tsx`
   - Mapear errores HTTP
   - Tests: componente crashea → ve "Error" + retry

**Status al fin de Semana 1:** 4 issues completados, app con validación + errores claros

---

### SEMANA 2 (Fase 1 - Parte 2)
**Objetivo:** Escalabilidad + logging + UI robusta

**Lunes-Martes:**
5. **ISSUE 1.4: Paginación** (2-3h)
   - Backend: skip/take en `getMovements()`
   - Frontend: actualizar hook para nueva estructura
   - Tests: page=1&limit=50 funciona

6. **ISSUE 1.6: Winston Logger** (3h) — **EN PARALELO**
   - `npm install winston`
   - Crear `/src/logger.ts`
   - Reemplazar `console.log` en servicios

**Miércoles-Viernes:**
7. **ISSUE 2.1.4: SWR/React Query** (4h)
   - Elegir SWR (recomendado para MVP)
   - `npm install swr`
   - Refactor hooks: `useMovements`, `useStatistics`
   - Configurar TTL (5min stats, 1min movimientos)

8. **ISSUE 2.1.5: Optimistic Updates** (2-3h) — **EN PARALELO**
   - Actualizar tabla al crear/eliminar
   - Rollback en error
   - Tests: delete desaparece → error → reaparece

**Status al fin de Semana 2:** FASE 1 COMPLETADA ✅
- Validación robusta
- Errores claros
- Escalable (paginación)
- Logging profesional
- UX rápida (caché + optimistic)

---

### SEMANA 3 (Fase 2.1 - Parte 1)
**Objetivo:** UX mejorada + gráficos

**Lunes-Miércoles:**
9. **ISSUE 2.1.2: PeriodSelector** (3h)
   - Crear componente con opciones (Este mes, 3 meses, año, custom)
   - State + onChange callback
   - Persistir en context o URL

10. **ISSUE 2.1.3: Chart.js** (4-5h) — **EN PARALELO**
    - `npm install chart.js react-chartjs-2`
    - Componentes: IncomeExpenseChart, CategoryChart
    - Conectar a datos reales

**Jueves-Viernes:**
11. **ISSUE 2.1.1: Dashboard Redesign** (5-6h)
    - Componentes: DashboardHeader, StatsCardsWithComparison, QuickActions, RecentMovements
    - Layout grid 2 columnas
    - Responsive

**Status al fin de Semana 3:** Dashboard profesional + gráficos ✅

---

### SEMANA 4 (Fase 2.1 - Parte 2)
**Objetivo:** Filtros completados, dashboard pulido

**Todo:** Pulido y testing manual del dashboard completo
- Cambiar período → actualiza stats + gráficos
- Cambiar empresa → actualiza todo
- Tests manuales: responsive en mobile

---

### SEMANA 5 (Fase 2.2 - Parte 1)
**Objetivo:** Reporting backend + endpoints

**Lunes-Martes:**
12. **ISSUE 2.2.1: Report Endpoints** (5-6h)
    - `npm install pdfkit`
    - POST /reports/movements (JSON, CSV, PDF)
    - GET /reports/summary
    - Generador PDF

**Miércoles:**
13. **ISSUE 2.2.3: Comparativas** (3-4h)
    - Modificar `/stats/summary` para retornar growth%
    - Frontend: mostrar badges "↑12%"

**Jueves-Viernes:**
14. **ISSUE 2.2.2: Reporting Page** (3-4h)
    - Crear `/app/reporting/page.tsx`
    - Filtros + botones de export
    - Preview de tabla

**Status al fin de Semana 5:** Reporting funcional ✅

---

### SEMANA 6 (Fase 2.3 - Parte 1)
**Objetivo:** Multi-empresa + roles backend

**Lunes-Martes:**
15. **ISSUE 2.3.1: Roles/Permisos BD** (3h)
    - Actualizar Prisma schema
    - Migration
    - Seed roles

16. **ISSUE 2.3.5: Rate Limiting** (2h) — **EN PARALELO**
    - `npm install express-rate-limit`
    - Limiters en rutas sensibles

**Miércoles-Viernes:**
17. **ISSUE 2.3.2: Permission Middleware** (2-3h)
    - Crear `/src/middleware/checkPermission.ts`
    - Aplicar a rutas
    - Tests: 403 si sin permiso

18. **ISSUE 2.3.3: Home Page** (3-4h) — **EN PARALELO**
    - Backend: GET `/api/user/companies`
    - Frontend: `/app/home/page.tsx`
    - Selector de empresa

**Status al fin de Semana 6:** Multi-empresa + roles implementados ✅

---

### SEMANA 7 (Fase 2.3 - Parte 2)
**Objetivo:** Protección de rutas + hardening

**Lunes-Miércoles:**
19. **ISSUE 2.3.4: withPermission HOC** (2-3h)
    - Crear HOC para proteger componentes
    - Aplicar a /movements/new, /reporting

**Jueves-Viernes:**
20. **ISSUE 3.3: Security Audit** (3-4h)
    - CORS stricto
    - JWT validation
    - Secrets check
    - OWASP top 10 review

**Status al fin de Semana 7:** FASE 2 COMPLETADA ✅ (UX + Reporting + Roles)

---

### SEMANA 8-9 (Fase 3 - Tests + Hardening)
**Objetivo:** Tests + seguridad

**Semana 8:**
21. **ISSUE 3.1: Frontend Tests** (5-6h)
    - Vitest setup
    - Tests para hooks
    - >80% coverage

22. **ISSUE 3.2: Backend Tests** (4-5h) — **EN PARALELO**
    - Supertest setup
    - Tests para endpoints
    - >75% coverage

**Semana 9:**
- Polish + final testing
- Documentation
- Deployment prep

**Status al fin de Semana 9:** FASE 3 COMPLETADA ✅ (Tests + Security)

---

## PARTE 6: CRITERIOS DE CIERRE POR FASE

### FASE 1: CRÍTICOS INMEDIATOS ✅
**Cierre cuando:**
- [ ] Todos los 6 issues en "Done"
- [ ] `npm run build` sin errores (backend)
- [ ] `npm run build` sin errores (frontend)
- [ ] Tests manuales OK:
  - [ ] Crear movimiento con datos inválidos → error legible en frontend
  - [ ] Cambiar empresa → dashboard actualiza
  - [ ] Eliminar movimiento → desaparece + aparece en siguiente página
  - [ ] Componente crashea → ve error + retry button
  - [ ] Logs en consola tienen timestamp + nivel

### FASE 2.1: UX + GRÁFICOS ✅
**Cierre cuando:**
- [ ] Todos los 5 issues en "Done"
- [ ] Dashboard se ve profesional (visual review)
- [ ] Gráficos renderizan correctamente
- [ ] Tests manuales OK:
  - [ ] Seleccionar período → stats + gráficos actualizan
  - [ ] Cambiar empresa → todo se actualiza
  - [ ] Crear movimiento → aparece inmediatamente (sin lag)
  - [ ] Responsive en mobile (iPad, iPhone)
- [ ] Performance: no flickering, <500ms para actualizar

### FASE 2.2: REPORTING + EXPORT ✅
**Cierre cuando:**
- [ ] Todos los 3 issues en "Done"
- [ ] Tests manuales OK:
  - [ ] Descargar CSV → archivo válido con datos correctos
  - [ ] Descargar PDF → PDF profesional, legible
  - [ ] Filtros en reporting page funcionan
  - [ ] Comparativas muestran ↑% o ↓% correctamente

### FASE 2.3: ROLES + SEGURIDAD ✅
**Cierre cuando:**
- [ ] Todos los 5 issues en "Done"
- [ ] Tests manuales OK:
  - [ ] Cambiar empresa funciona (home page)
  - [ ] Usuario con role lector no ve botón crear
  - [ ] Admin ve todo
  - [ ] Rate limiting activo (100 requests → 429)
  - [ ] CORS funciona (no cross-origin permitido)
- [ ] Security audit passed (OWASP top 10)

### FASE 3: TESTS + HARDENING ✅
**Cierre cuando:**
- [ ] `npm test` pasa 100% (backend + frontend)
- [ ] Coverage >80% frontend, >75% backend
- [ ] Security audit completed
- [ ] Deployment checklist OK
- [ ] App ready for daily use

---

## PARTE 7: RESUMEN EJECUTIVO FINAL

### Duración Total
**10 semanas de desarrollo** (Semana 1 - Semana 10)

### Fases
| Fase | Semanas | Horas | Status |
|------|---------|-------|--------|
| 1: Críticos | 2 | 17-19h | ▓▓░░░░░░░ |
| 2.1: UX+Gráficos | 3 | 18-21h | ▓▓▓░░░░░░ |
| 2.2: Reporting | 2 | 11-14h | ▓▓▓▓░░░░░ |
| 2.3: Roles | 3 | 12-15h | ▓▓▓▓▓░░░░ |
| 3: Tests | 2+ | 12-15h | ▓▓▓▓▓▓░░░ |
| **TOTAL** | **10+** | **70-84h** | |

### Entregas Clave
1. **Fin Semana 2:** FASE 1 ✅ (validación + errores + escalabilidad)
2. **Fin Semana 4:** FASE 2.1 ✅ (dashboard profesional + gráficos)
3. **Fin Semana 5:** FASE 2.2 ✅ (reporting + export)
4. **Fin Semana 7:** FASE 2 completa ✅ (UX + Roles)
5. **Fin Semana 9:** Versión 1.0 ✅ (listo para producción)

### Recursos Requeridos
- **1 desarrollador full-stack** (o 2 en paralelo: backend + frontend)
- **10 semanas** (a 40h/semana)
- **Herramientas:** Zod, SWR, Chart.js, pdfkit, Winston, Vitest, Supertest, express-rate-limit

### Resultado Final
**Aplicación contable profesional:**
- ✅ Validación robusta
- ✅ UX intuitiva (dashboard + gráficos)
- ✅ Reporting (CSV + PDF)
- ✅ Multi-empresa + roles
- ✅ Tests + seguridad
- ✅ Ready for production

---

## APÉNDICE: CÓMO USAR ESTE PLAN

### Copiar a Tu Tablero Kanban (Trello, GitHub Projects, Jira)
```
1. Copiar cada ISSUE como tarjeta
2. Asignar columnas: Backlog → Ready → In Progress → Review → Done
3. Poner días estimados en cada tarjeta
4. Asignar a desarrollador(es)
```

### Seguimiento Semanal
```
Cada lunes:
1. Revisar qué issues se completaron en semana anterior
2. Mover completados a "Done"
3. Iniciar issues de la semana siguiente
4. Bloqueantes? Actualizar dependencias

Cada viernes:
1. Status: ¿en tiempo?
2. QA de cambios
3. Merge a main si tests OK
```

### CI/CD
```
Antes de merge:
1. Compilación sin errores ✅
2. Tests (nuevo + existentes) ✅
3. Linting/formatting ✅
4. Manual testing OK ✅
5. Merge a main
6. Auto-deploy a staging
```

