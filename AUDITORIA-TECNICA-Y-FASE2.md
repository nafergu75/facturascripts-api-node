# AUDITORÍA TÉCNICA Y DISEÑO DE FASE 2 — Aplicación Contable

**Análisis profesional de calidad, arquitectura, UX y roadmap**

**Fecha:** 2026-06-30  
**Versión:** 1.0 (Baseline)  
**Auditor:** Evaluación crítica post-implementación  

---

## PARTE 1: RESUMEN ARQUITECTÓNICO ACTUAL

### Backend (conta-api)

```
Arquitectura Actual:
├─ Middleware
│  ├─ authMiddleware (JWT verification)
│  ├─ CORS handling
│  └─ Error middleware
├─ Routes Layer
│  ├─ movements.routes.ts (NEW)
│  ├─ companies.routes.ts (existing)
│  ├─ income-reader.routes.ts (existing)
│  └─ Others
├─ Controllers
│  ├─ movements.controller.ts (NEW)
│  └─ Others
├─ Services
│  ├─ movements.service.ts (NEW, business logic)
│  └─ Others
└─ Data Layer
   └─ Prisma ORM → MySQL
      ├─ Company
      ├─ Movement (NEW)
      ├─ IncomeReader
      └─ Others
```

**Key Characteristics:**
- Multi-tenant (companyId scoping)
- JWT-based authentication
- RESTful API design
- Prisma for type-safe DB access
- Decimal type for monetary values

### Frontend (Next.js 14)

```
Estructura Actual:
app/
├─ layout.tsx (Root layout + Header)
├─ page.tsx (Redirect → dashboard)
├─ dashboard/page.tsx (Statistics dashboard)
├─ movements/page.tsx (CRUD list)
├─ movements/new/page.tsx (Create form)
├─ documents/page.tsx (Document list)

components/
├─ common/ (Header, reusable)
├─ dashboard/ (StatsCard)
├─ movements/ (Table, Form)
├─ documents/ (List, Upload)

hooks/
├─ useAuth (JWT + user)
├─ useMovements (CRUD + stats)
├─ useStatistics (Dashboard data)

services/
├─ api.ts (HTTP client with JWT)
├─ movements.service.ts (Proxy to backend)
├─ documents.service.ts
├─ auth.service.ts

types/ (TypeScript interfaces)
utils/ (formatters, validators)
```

**Key Characteristics:**
- App Router (Next 14)
- Client-side components ('use client')
- React hooks for state
- Direct API calls (no middleware layer)
- TailwindCSS for styling

---

## PARTE 2: AUDITORÍA TÉCNICA

### 2.1 BACKEND AUDITORÍA

#### **FORTALEZAS**

✅ **Estructura correcta de capas**
- Controllers → Services → Prisma (separation of concerns)
- Servicios contienen toda la lógica (movementsService es completo)
- Controllers delegan, no duplican lógica

✅ **Tipado TypeScript**
- Interfaces definidas (CreateMovementDTO, MovementFilter, etc.)
- Tipos en parámetros y retornos
- Strong typing en Prisma schema

✅ **Validaciones básicas**
- Verifica campos requeridos (type, amount, category, date)
- Valida tipo de movimiento ('income' | 'expense')
- Validación de companyId (existe empresa)

✅ **Índices de BD**
- @@index([companyId]) — para búsquedas multi-tenant
- @@index([date]) — para queries por rango de fechas
- @@index([type]) — para filtros

✅ **Manejo multi-tenant**
- Todas las queries filtran por companyId
- Previene data leakage entre empresas
- Middleware de auth protege rutas

✅ **Respuestas HTTP apropiadas**
- 201 para CREATE
- 204 para DELETE
- 400 para validación
- 404 para no encontrado
- 500 para errores internos

---

#### **DEBILIDADES Y PUNTOS DE MEJORA**

⚠️ **1. Validación insuficiente**

**Problema:**
```typescript
// movementsController.ts línea ~20
if (!data.type || !data.amount || !data.category || !data.description || !data.date) {
  return res.status(400).json({ error: 'Missing required fields...' });
}
// Validación muy básica
```

**Issues:**
- No valida que `amount > 0`
- No valida rango de fechas (¿fecha futura?)
- No valida longitud de strings (description de 1 carácter válida)
- No normaliza/trimea strings

**Mejora:**
```typescript
// Usar librería como zod o joi
import { z } from 'zod';

const createMovementSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive('Amount must be > 0'),
  category: z.string().min(2).max(50).trim(),
  description: z.string().min(5).max(500).trim(),
  date: z.string().refine(
    (d) => new Date(d) <= new Date(),
    'Date cannot be in the future'
  ),
  referenceDocument: z.string().optional(),
});
```

---

⚠️ **2. Errores de servicios no diferenciados**

**Problema:**
```typescript
// movementsService.ts
catch (error) {
  console.error('Error creating movement:', error);
  return res.status(500).json({ error: 'Internal server error' });
}
```

**Issues:**
- `error instanceof Error` nunca se ejecuta correctamente
- No diferencia entre "empresa no existe" y "BD caída"
- Cliente no sabe qué pasó

**Mejora:**
```typescript
class CompanyNotFoundError extends Error {
  constructor(id: string) {
    super(`Company ${id} not found`);
    this.name = 'CompanyNotFoundError';
  }
}

// En service:
throw new CompanyNotFoundError(companyId);

// En controller:
catch (error) {
  if (error instanceof CompanyNotFoundError) {
    return res.status(404).json({ error: error.message });
  }
  if (error instanceof ValidationError) {
    return res.status(400).json({ error: error.message });
  }
  console.error('Unexpected error:', error);
  return res.status(500).json({ error: 'Internal server error' });
}
```

---

⚠️ **3. N+1 queries potential**

**Problema:**
```typescript
// En getByCategory:
const movements = await prisma.movement.findMany({ where });
// Luego lógica in-memory:
movements.forEach((m) => { ... })
// Si hay 10k movimientos, carga todo en memoria
```

**Issues:**
- Agregaciones en memoria (lento, uso memoria)
- Sin paginación (10k registros → problema)
- No usa GROUP BY de SQL

**Mejora:**
```typescript
// Usar aggregation nativa de Prisma
const stats = await prisma.movement.groupBy({
  by: ['category', 'type'],
  where: { companyId, date: { gte, lte } },
  _sum: { amount: true },
  _count: true,
});
// Retorna: [{ category, type, _sum, _count }]
```

---

⚠️ **4. Sin paginación**

**Problema:**
```typescript
const movements = await prisma.movement.findMany({
  where,
  orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  // NO HAY PAGINACIÓN
});
```

**Issues:**
- 100k movimientos → cargar todos en memoria
- Endpoint sin limit retorna todo
- Lento en BD y red

**Mejora:**
```typescript
async getMovements(companyId: string, filters?: MovementFilter): Promise<{
  data: Movement[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = filters?.page || 1;
  const limit = Math.min(filters?.limit || 50, 500); // max 500
  const skip = (page - 1) * limit;

  const [movements, total] = await Promise.all([
    prisma.movement.findMany({
      where, orderBy, skip, take: limit,
    }),
    prisma.movement.count({ where }),
  ]);

  return { data: movements, total, page, limit };
}
```

---

⚠️ **5. Formato decimal inseguro**

**Problema:**
```typescript
// Service devuelve:
return {
  totalIncome: Number(totalIncome.toFixed(2)),
  // parseFloat puede perder precisión
};

// Frontend recibe:
{ "totalIncome": 1999.9999999999998 }
```

**Issues:**
- Floating point errors en dinero
- Inconsistencia contable

**Mejora:**
```typescript
// Guardar siempre como string o integer (centavos)
interface MovementResponse {
  amount: string; // "1999.99"
  // O usar centavos:
  amountCents: number; // 199999
}

// En formatos:
function formatCurrency(amount: string): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
  }).format(parseFloat(amount));
}
```

---

⚠️ **6. Sin caché HTTP ni ETag**

**Problema:**
- Dashboard hace 3 requests cada vez (summary, byCategory, byMonth)
- Sin Cache-Control headers
- Cada reload = 3 BD queries

**Mejora:**
```typescript
// En controllers:
res.set('Cache-Control', 'private, max-age=300'); // 5 min cache
res.set('ETag', `"${hash(data)}"`);

// O usar Redis para agregaciones caras
const cached = await redis.get(`stats:${companyId}:2026-06`);
if (cached) return cached;
```

---

⚠️ **7. Logs insuficientes**

**Problema:**
- Solo `console.error` (sin estructura)
- Sin información de contexto
- Difícil debugar en producción

**Mejora:**
```typescript
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});

// En service:
logger.info('Movement created', {
  movementId: movement.id,
  companyId,
  amount: movement.amount,
  timestamp: new Date().toISOString(),
});

logger.error('Movement creation failed', {
  error: error.message,
  companyId,
  input: data,
  stack: error.stack,
});
```

---

⚠️ **8. Sin límites de rate limiting**

**Problema:**
- Usuario malintencioñado: 1000 reqs/segundo
- Sin límite en BD
- DoS fácil

**Mejora:**
```typescript
import rateLimit from 'express-rate-limit';

const movementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100, // 100 requests per window
  keyGenerator: (req, res) => req.user.id, // Por usuario
  skip: (req) => req.user.role === 'admin', // Admin no limitado
});

app.use('/api/companies/:companyId/movements', movementLimiter);
```

---

### **RESUMEN BACKEND**

| Aspecto | Score | Crítico | Mejora |
|---------|-------|---------|--------|
| Arquitectura | ✅ 8/10 | No | Agregar repositorio pattern |
| Validación | ⚠️ 4/10 | **SÍ** | Usar zod o joi |
| Errores | ⚠️ 5/10 | Sí | Custom error classes |
| Performance | ⚠️ 5/10 | **SÍ** | Agregar paginación |
| Seguridad | ✅ 7/10 | No | Rate limiting + CORS stricter |
| Logs | ⚠️ 3/10 | Sí | Winston o similar |
| Testing | ❌ 0/10 | **SÍ** | Agregar tests |

---

### 2.2 FRONTEND AUDITORÍA

#### **FORTALEZAS**

✅ **Tipado TypeScript completo**
- Interfaces bien definidas en `types/`
- Props tipadas en componentes
- Return types en hooks

✅ **Separación clara de capas**
- Components = presentación
- Services = HTTP logic
- Hooks = state logic
- Types = contracts

✅ **CSS profesional con Tailwind**
- Responsive design
- Colores consistentes
- Espaciado uniforme

✅ **Componentes reutilizables**
- StatsCard, MovementsTable, etc.
- Props bien definidas

✅ **Gestión de estado limpia**
- Hooks locales (useState)
- Context no necesario aún
- Fetch on mount con useEffect

---

#### **DEBILIDADES Y PUNTOS DE MEJORA**

⚠️ **1. Falta de validación en frontend**

**Problema:**
```typescript
// MovementForm.tsx
const handleSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!form.amount || form.amount <= 0) {
    setError('El importe debe ser mayor a 0');
    return;
  }
  // Sin más validaciones
};
```

**Issues:**
- No valida longitud de strings
- No valida fecha futura
- No trimea inputs
- Mensajes de error genéricos

**Mejora:**
```typescript
import { z } from 'zod';

const formSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.number().positive('Must be > 0').max(999999),
  category: z.string().min(2).max(50),
  description: z.string().min(5).max(500),
  date: z.string().refine(
    (d) => new Date(d) <= new Date(),
    'Cannot be in future'
  ),
});

type FormData = z.infer<typeof formSchema>;

const handleSubmit = async (e: React.FormEvent) => {
  try {
    const validated = formSchema.parse(form);
    await onSubmit(validated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      setError(error.errors[0].message);
    }
  }
};
```

---

⚠️ **2. Sin manejo de errores globales**

**Problema:**
```typescript
// useMovements.ts
const load = useCallback(async () => {
  try {
    const [movs, summ] = await Promise.all([
      movementsService.list(companyId, filters),
      movementsService.getSummary(companyId),
    ]);
    setMovements(movs);
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Error loading');
  }
}, [companyId, filters]);
```

**Issues:**
- Error message de BD se muestra al usuario
- Sin retry logic
- Sin fallback UI
- Sin toast/notificación

**Mejora:**
```typescript
// Crear wrapper para errores:
class UserFacingError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// En service:
if (response.status === 404) {
  throw new UserFacingError(
    'Company not found',
    'COMPANY_NOT_FOUND'
  );
}

// En hook:
catch (error) {
  if (error instanceof UserFacingError) {
    setError(error.message); // Seguro mostrar
  } else {
    setError('Unexpected error. Try again.');
    logger.error('Unexpected error', { error });
  }
}
```

---

⚠️ **3. Sin caché de datos**

**Problema:**
```typescript
// Dashboard se renderiza, hace 3 requests
// Usuario cambia tab y vuelve al dashboard
// Hace 3 requests OTRA VEZ
// Sin caché
```

**Issues:**
- Over-fetching (mismos datos)
- Lento
- Tráfico innecesario

**Mejora:**
```typescript
// Agregar caché simple:
const cache = new Map<string, {
  data: any;
  timestamp: number;
}>();

function getCached<T>(
  key: string,
  fetch: () => Promise<T>,
  ttl = 5 * 60 * 1000 // 5 min
): Promise<T> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < ttl) {
    return Promise.resolve(cached.data);
  }
  return fetch().then((data) => {
    cache.set(key, { data, timestamp: Date.now() });
    return data;
  });
}

// O usar SWR:
import useSWR from 'swr';

export function useMovements(companyId: string) {
  const { data, error, isLoading } = useSWR(
    companyId ? `/api/companies/${companyId}/movements` : null,
    movementsFetcher,
    { revalidateOnFocus: false, dedupingInterval: 60000 } // 1 min cache
  );
  return { movements: data || [], error, isLoading };
}
```

---

⚠️ **4. Falta de optimismo en actualiza**

**Problema:**
```typescript
const handleDelete = async (id: string) => {
  await remove(id); // Espera respuesta antes de actualizar UI
  // Usuario ve lag
};
```

**Issues:**
- UI no responde inmediatamente
- Parece lento
- Bad UX

**Mejora:**
```typescript
const handleDelete = async (id: string) => {
  // Optimistic update
  const previous = movements;
  setMovements(movements.filter((m) => m.id !== id));

  try {
    await remove(id);
  } catch (error) {
    // Rollback
    setMovements(previous);
    setError('Failed to delete. Try again.');
  }
};
```

---

⚠️ **5. Sin companyId context**

**Problema:**
```typescript
// En cada página:
const { user } = useAuth();
const { movements } = useMovements(user?.companyId);
// Hardcodeado en cada componente
```

**Issues:**
- Repetición
- Si usuario cambia empresa, hay que pasar manualmente
- No hay persistencia de empresa seleccionada

**Mejora:**
```typescript
// Crear CompanyContext:
interface CompanyContextType {
  companyId: string | null;
  setCompanyId: (id: string) => void;
}

const CompanyContext = createContext<CompanyContextType | null>(null);

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const [companyId, setCompanyId] = useState<string | null>(() => {
    // Persistir en localStorage
    return typeof window !== 'undefined'
      ? localStorage.getItem('selectedCompanyId')
      : null;
  });

  const handleSetCompanyId = (id: string) => {
    setCompanyId(id);
    localStorage.setItem('selectedCompanyId', id);
  };

  return (
    <CompanyContext.Provider value={{ companyId, setCompanyId: handleSetCompanyId }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (!context) throw new Error('useCompany must be in CompanyProvider');
  return context;
}

// Luego en componentes:
const { companyId } = useCompany();
const { movements } = useMovements(companyId);
// Sin pasar en cada sitio
```

---

⚠️ **6. Sin loading states apropiados**

**Problema:**
```typescript
// MovementsTable.tsx
if (loading) return <div>Cargando movimientos...</div>;
// Mensaje genérico, sin esqueleto
```

**Issues:**
- No visual feedback durante carga
- Parece "roto"
- Mala UX

**Mejora:**
```typescript
// Crear skeleton:
function MovementsSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="animate-pulse h-12 bg-gray-200 rounded" />
      ))}
    </div>
  );
}

// En tabla:
if (loading) return <MovementsSkeleton />;
```

---

⚠️ **7. Sin error boundary**

**Problema:**
- Si un componente crashea, whole page breaks
- Sin fallback UI

**Mejora:**
```typescript
// app/error.tsx (Next 14)
'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="p-8 text-center">
      <h1 className="text-2xl font-bold text-red-600">Oops!</h1>
      <p className="text-gray-600 mt-2">{error.message}</p>
      <button
        onClick={reset}
        className="mt-4 px-4 py-2 bg-blue-600 text-white rounded"
      >
        Try again
      </button>
    </div>
  );
}
```

---

⚠️ **8. Sin tests**

**Problema:**
- Refactoring asusta
- Regressions invisibles
- No hay confianza

**Mejora:**
```typescript
// movements.test.ts
import { renderHook, act, waitFor } from '@testing-library/react';
import { useMovements } from '@/hooks/useMovements';

describe('useMovements', () => {
  it('loads movements and summary', async () => {
    const { result } = renderHook(
      () => useMovements('company-1')
    );

    await waitFor(() => {
      expect(result.current.movements).toHaveLength(10);
    });

    expect(result.current.summary?.totalIncome).toBe(5000);
  });

  it('creates movement optimistically', async () => {
    const { result } = renderHook(
      () => useMovements('company-1')
    );

    await act(async () => {
      await result.current.create({
        type: 'income',
        amount: 1000,
        category: 'Ventas',
        description: 'Test',
        date: '2026-06-30',
      });
    });

    expect(result.current.movements).toContainEqual(
      expect.objectContaining({ amount: 1000 })
    );
  });
});
```

---

### **RESUMEN FRONTEND**

| Aspecto | Score | Crítico | Mejora |
|---------|-------|---------|--------|
| TypeScript | ✅ 8/10 | No | Más strict mode |
| Validación | ⚠️ 3/10 | **SÍ** | Zod schemas |
| Errores | ⚠️ 4/10 | Sí | Error boundary + logging |
| Performance | ⚠️ 5/10 | Sí | SWR/React Query |
| UX | ⚠️ 4/10 | **SÍ** | Optimistic updates + context |
| Testing | ❌ 0/10 | **SÍ** | Vitest/Jest |
| Accessibility | ⚠️ 2/10 | Sí | ARIA labels |

---

## PARTE 3: MEJORA UX/UI PARA USO DIARIO

### 3.1 ESTADO ACTUAL DE UX

**Dashboard actual:**
```
┌─────────────────────────────────────┐
│        Header + Navegación          │
├─────────────────────────────────────┤
│ [4 Stats Cards]                     │
│ Ingresos | Gastos | Balance | Count │
├─────────────────────────────────────┤
│ [2 Secciones lado a lado]           │
│ Desglose Categoría | Últimos 6 Meses│
├─────────────────────────────────────┤
│ [Botón "+ Nuevo Movimiento"]        │
└─────────────────────────────────────┘
```

**Problemas:**
- Poco contexto (¿cuál es el período?)
- Stats cards sin contexto (¿vs. mes anterior?)
- Categorías solo top 5
- No hay filtro de período
- No hay export
- Movimientos recientes no visibles

---

### **PROPUESTA: NUEVO DASHBOARD**

```
┌─────────────────────────────────────────────────────────────┐
│ HEADER                                                       │
│ [Empresa: Mi Empresa ▼] [Período: Jun 2026 ▼]              │
├─────────────────────────────────────────────────────────────┤
│
│ RESUMEN PRINCIPAL (KPIs principales)
│ ┌────────────────┬────────────────┬────────────────┐
│ │ Ingresos       │ Gastos         │ Balance        │
│ │ €16,000        │ €1,950         │ €14,050 ✅     │
│ │ ↑ +12% vs mes  │ ↓ -8% vs mes   │ ↑ +15% vs mes  │
│ └────────────────┴────────────────┴────────────────┘
│
│ GRÁFICOS (2 col)
│ ┌──────────────────────┬──────────────────────┐
│ │ Evolución 12 meses   │ Gastos por Categoría │
│ │ [Line chart]         │ [Pie/Donut chart]    │
│ └──────────────────────┴──────────────────────┘
│
│ ACCIONES RÁPIDAS
│ [+ Movimiento] [+ Documento] [Exportar] [Filtros]
│
│ MOVIMIENTOS RECIENTES (Tabla compacta)
│ ┌─────────────────────────────────────┐
│ │ Última | Entrada | Salida | Balance │
│ │ 30-Jun│ Venta   │        │ 16000   │
│ │ 29-Jun│         │ Gasto  │ 15000   │
│ │...                                  │
│ └─────────────────────────────────────┘
│ [Ver todo] → /movements
│
└─────────────────────────────────────────────────────────────┘
```

**Mejoras clave:**
1. **Contexto claro:** Empresa + Período en header
2. **Comparativas:** "vs mes anterior" muestra tendencia
3. **Gráficos reales:** Chart.js con evolución y desglose
4. **Acciones visibles:** 4 CTAs principales
5. **Resumen compacto:** Últimos 10 movimientos inline
6. **Exportar:** Botón para descargar CSV/PDF

---

### 3.2 FLUJO: REGISTRAR MOVIMIENTO

**Actual (5 pasos, lento):**
```
1. Click "+ Nuevo Movimiento"
2. Rellenar 5 campos
3. Seleccionar categoría (dropdown)
4. Click "Guardar"
5. Redirección a /movements
```

**Propuesta mejorada (3 pasos, rápido):**

```
OPCIÓN A: Modal dialog (recomendado para UX rápida)
┌─────────────────────────────────────┐
│ Nuevo Movimiento               [X]  │
├─────────────────────────────────────┤
│ [Ingreso] [Gasto]                   │ ← Botones, no dropdown
├─────────────────────────────────────┤
│ Categoría     [Ventas ▼]             │ ← Autocomplete
│ Importe       [1000]                │ ← Auto-focus
│ Descripción   [____________]        │
│ Fecha         [2026-06-30]          │ ← Default = hoy
│ Empresa       [Mi Empresa] (readonly)
├─────────────────────────────────────┤
│ [Guardar] [Cancelar]                │
│
│ (Después de guardar)
│ ✅ Movimiento guardado
│ [Duplicar] [Ver en lista] [Nuevo]
└─────────────────────────────────────┘

OPCIÓN B: Formulario inline en Dashboard (aún más rápido)
┌──────────────────────────────────────────┐
│ Entrada rápida:                          │
│ [Ingreso/Gasto] [€] [Categoría] [Fecha] │
│ [Descripción...]             [Guardar]  │
└──────────────────────────────────────────┘
(Aparece abajo y se actualiza tabla)
```

**Mejoras:**
- Modal = no abandona contexto
- Botones (Ingreso/Gasto) más rápido que dropdown
- Autocomplete en categoría
- Fecha = hoy por defecto
- Después guardar: opciones (duplicar, nuevo, ver)

---

### 3.3 FLUJO: SUBIR Y VINCULAR DOCUMENTO

**Actual (no implementado):**
- Página de documentos solo muestra lista
- Sin subir documentos desde UI
- Sin vincular a movimiento

**Propuesta:**

```
PÁGINA: Documentos
┌─────────────────────────────────────┐
│ Documentos                          │
│ [Subir documento] [Filtros]         │
├─────────────────────────────────────┤
│ Drop zone: "Arrastra PDF/foto"      │
│ o [Seleccionar archivo]             │
│                                     │
│ LISTA DE DOCUMENTOS                 │
│ ┌──────────────────────────────────┐
│ │ Nombre | Estado | Fecha | Acciones
│ │ Fact001 | ✅ READY | 30-Jun | ⚙️ Opciones
│ │ Receipt2 | ⏳ PROCESSING | 29-Jun
│ │ Exp003 | ❌ REJECTED | 28-Jun
│ │
│ └──────────────────────────────────┘
│
│ DETALLE DE DOCUMENTO (Modal)
│ ┌──────────────────────────────┐
│ │ Fact001.pdf                  │
│ │ Estado: ✅ READY             │
│ │ Datos extraídos (OCR):       │
│ │ ├─ Proveedor: ACME Corp      │
│ │ ├─ Importe: €1,250           │
│ │ ├─ Fecha: 2026-06-25         │
│ │ └─ Concepto: Suministros     │
│ │                              │
│ │ [Vincular a Movimiento]      │
│ │ [Aceptar]  [Rechazar]        │
│ │ [Descargar PDF]              │
│ └──────────────────────────────┘
```

**Mejoras:**
- Drag & drop = más fácil
- Estados visuales con emojis
- Datos OCR visibles
- Botón "Vincular a Movimiento" abre modal con búsqueda
- Acciones contextuales (Aceptar/Rechazar)

---

### 3.4 FLUJO: REVISAR ESTADÍSTICAS DE PERÍODO

**Actual:**
- Dashboard solo muestra mes actual
- Sin filtro por período
- Sin export

**Propuesta:**

```
DASHBOARD MEJORADO + FILTROS
┌──────────────────────────────────┐
│ Período: [Seleccionar ▼]         │
│ ├─ Este mes (Jun 2026)           │
│ ├─ Mes anterior (May 2026)       │
│ ├─ Últimas 3 meses               │
│ ├─ Este año (2026)               │
│ ├─ Rango custom [De] [A]         │
│ └─ Trimestral [Q1/Q2/Q3/Q4]      │
└──────────────────────────────────┘

[Stats cards actualizadas automáticamente]
[Gráficos se re-renderizan]

EXPORTAR OPCIONES
[CSV] [Excel] [PDF] [Email]

PDF incluye:
- Resumen financiero
- Gráficos
- Desglose por categoría
- Todos los movimientos del período
```

**Mejoras:**
- Selector de período = contextual
- Auto-actualiza todo al cambiar período
- Export con opción de PDF profesional
- Datos listos para contador

---

### **MICROCOPYS MEJORES**

**Actual** → **Propuesto**

| Elemento | Actual | Propuesto |
|----------|--------|-----------|
| Botón crear | "+ Nuevo Movimiento" | "+ Registrar entrada" (si es ingreso) |
| Error vacío | "Error loading" | "No hay movimientos. Comienza a registrar." |
| Label tipo | "Tipo" | "¿Es un ingreso o un gasto?" |
| Label importe | "Importe (€)" | "¿Cuánto dinero?" |
| Label fecha | "Fecha" | "¿Cuándo?" (con default = hoy) |
| Error validación | "Missing required fields" | "Falta la categoría. Selecciona una para continuar." |
| Éxito guardado | (sin feedback) | "✅ Movimiento guardado. [Duplicar] [Nuevo]" |
| Documento rechazado | "Status: REJECTED" | "⚠️ Documento rechazado. Sube una copia más clara." |
| Sin datos | "No movements" | "No hay movimientos este período. Quieres [Cambiar período] o [Crear uno]?" |

---

## PARTE 4: PROPUESTA FASE 2 (ROADMAP)

### 4.1 VISIÓN FASE 2

**Objetivo:** Convertir "app contable" en "herramienta contable profesional usable día a día"

**Fase 2 desglosa en 3 sub-fases:**

```
Fase 2.1 (3-4 semanas) — UX + Gráficos + Contexto
├─ Dashboard mejorado (propuesta arriba)
├─ Gráficos con Chart.js
├─ CompanyContext + Company selector
├─ Filtros de período
└─ Validación con Zod

Fase 2.2 (2-3 semanas) — Reporting + Export
├─ Export CSV/Excel/PDF
├─ Vistas de reporting (por categoría, por empresa, etc.)
├─ Comparativas (vs mes anterior, vs año anterior)
└─ Documento contable básico (sin AEAT aún)

Fase 2.3 (3-4 semanas) — Roles, Multi-empresa, Seguridad
├─ Roles: admin, contable, lector
├─ Permisos por pantalla
├─ Home page con resumen de empresas
├─ Rate limiting + validaciones
└─ Tests (Vitest)
```

**Total Fase 2:** 8-11 semanas  
**Impacto:** Pasa de "MVP" a "producto usable profesional"

---

### 4.2 FASE 2.1: UX + GRÁFICOS + CONTEXTO

**Cambios en Backend:**

1. **Agregar endpoint de comparativas:**

```typescript
// /api/companies/:companyId/stats/compare?from=2026-05&to=2026-06
GET /api/companies/:companyId/stats/compare
→ {
  periods: [
    { month: '2026-05', income: 12000, expense: 1500 },
    { month: '2026-06', income: 16000, expense: 1950 },
  ],
  growth: { income: '+33%', expense: '+30%' }
}
```

2. **Mejorar endpoint de byMonth con más datos:**

```typescript
→ {
  month: '2026-06',
  income: 16000,
  expense: 1950,
  balance: 14050,
  topCategory: { name: 'Ventas', amount: 10000 },
  movementCount: 47,
  avgMovementSize: 341
}
```

3. **Agregar endpoint de trend (últimos 12 meses):**

```typescript
GET /api/companies/:companyId/stats/trend?months=12
→ Array de últimos 12 meses con income/expense
(Para gráfico de línea)
```

**Cambios en Frontend:**

1. **Agregar Chart.js integration:**

```typescript
// components/dashboard/IncomeExpenseChart.tsx
import { Line } from 'react-chartjs-2';

export function IncomeExpenseChart({ data }: { data: MonthlyStat[] }) {
  const chartData = {
    labels: data.map((d) => d.month),
    datasets: [
      {
        label: 'Ingresos',
        data: data.map((d) => d.income),
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22, 163, 74, 0.1)',
        tension: 0.3,
      },
      {
        label: 'Gastos',
        data: data.map((d) => d.expense),
        borderColor: '#dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.1)',
        tension: 0.3,
      },
    ],
  };

  return <Line data={chartData} />;
}
```

2. **Crear CompanyContext:**

```typescript
// context/CompanyContext.tsx
export const CompanyContext = createContext<{
  companyId: string | null;
  setCompanyId: (id: string) => void;
} | null>(null);

export function useCompany() {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error('useCompany debe estar dentro de CompanyProvider');
  return ctx;
}
```

3. **Agregar período selector:**

```typescript
// components/PeriodSelector.tsx
export function PeriodSelector({
  selected,
  onChange,
}: {
  selected: string; // 'current-month' | 'current-year' | 'range'
  onChange: (period: string) => void;
}) {
  // Dropdown con opciones
}
```

**Entregables Fase 2.1:**

- ✅ Dashboard nuevo (estructura HTML)
- ✅ 3 gráficos (ingresos vs gastos, categorías, trend)
- ✅ CompanyContext + selector
- ✅ PeriodSelector con auto-update
- ✅ Zod validation en formularios
- ✅ Stats comparativas (vs mes anterior)

**Esfuerzo:** ~3-4 semanas  
**Impacto:** Muy visible en UX, usuario ve mejora inmediata

---

### 4.3 FASE 2.2: REPORTING + EXPORT

**Cambios en Backend:**

1. **Agregar endpoints de agregación:**

```typescript
// /api/companies/:companyId/reports/by-category
GET /api/companies/:companyId/reports/movements
Query params:
  - format: 'json' | 'csv' | 'pdf'
  - from: '2026-01'
  - to: '2026-06'
  - type: 'income' | 'expense' | 'all'
→ Array de movimientos formateados

// /api/companies/:companyId/reports/summary
GET /api/companies/:companyId/reports/summary?from=2026-01&to=2026-06
→ Documento contable básico:
{
  company: { name, taxId },
  period: { from, to },
  income: { total, byCategory: [...] },
  expense: { total, byCategory: [...] },
  balance: { gross, net },
  movementCount: 150,
  generatedAt: new Date(),
}
```

2. **Integrar librería de PDF (pdfkit o jsPDF):**

```typescript
import PDFDocument from 'pdfkit';

app.get('/api/companies/:companyId/exports/report.pdf', async (req, res) => {
  const data = await getReportData(req.params.companyId, req.query);
  const doc = new PDFDocument();

  doc.fontSize(18).text(`Informe Contable - ${data.period.from}`);
  doc.fontSize(12).text(`Ingresos: €${data.income.total}`);
  doc.text(`Gastos: €${data.expense.total}`);
  doc.text(`Balance: €${data.balance.gross}`);

  // Tabla de movimientos
  doc.table(data.movements.map((m) => [
    m.date,
    m.description,
    m.amount,
  ]));

  doc.pipe(res);
  doc.end();
});
```

**Cambios en Frontend:**

1. **Crear página de reporting:**

```typescript
// app/reporting/page.tsx
export default function ReportingPage() {
  return (
    <div>
      <h1>Reportes</h1>
      <ReportBuilder /> {/* Selector de parámetros */}
      <ExportOptions /> {/* Botones CSV/Excel/PDF */}
    </div>
  );
}
```

2. **Agregar funciones de export:**

```typescript
// services/export.service.ts
export async function exportMovementsCSV(
  companyId: string,
  filters: MovementFilter
): Promise<Blob> {
  const movements = await movementsService.list(companyId, filters);
  const csv = [
    ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Importe'].join(','),
    ...movements.map((m) =>
      [
        m.date,
        m.type,
        m.category,
        m.description,
        m.amount,
      ].join(',')
    ),
  ].join('\n');

  return new Blob([csv], { type: 'text/csv' });
}

export async function downloadCSV(
  filename: string,
  blob: Blob
) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// En componente:
const handleExportCSV = async () => {
  const blob = await exportMovementsCSV(companyId, filters);
  downloadCSV(`movimientos-${new Date().toISOString()}.csv`, blob);
};
```

**Entregables Fase 2.2:**

- ✅ Endpoint /reports/movements (JSON)
- ✅ Endpoint /exports/report.pdf
- ✅ Export a CSV desde frontend
- ✅ Página de reporting con filtros
- ✅ Documento contable básico (PDF profesional)

**Esfuerzo:** ~2-3 semanas  
**Impacto:** Contador puede usar datos, genera PDFs profesionales

---

### 4.4 FASE 2.3: ROLES + SEGURIDAD + MULTI-EMPRESA

**Cambios en Backend:**

1. **Agregar tabla de Roles/Permissions:**

```prisma
model Role {
  id    String    @id @default(cuid())
  name  String    // "admin" | "contable" | "lector"
  users User[]
  permissions Permission[]
}

model Permission {
  id     String   @id @default(cuid())
  name   String   // "movements:read", "movements:create", etc.
  roles  Role[]
}

model User {
  id    String @id @default(cuid())
  email String @unique
  role  Role   @relation(fields: [roleId], references: [id])
  roleId String
}
```

2. **Agregar middleware de permisos:**

```typescript
// middleware/checkPermission.ts
export function checkPermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user; // From auth middleware
    if (!user.role.permissions.some((p) => p.name === permission)) {
      return res.status(403).json({ error: 'Permission denied' });
    }
    next();
  };
}

// En ruta:
router.post(
  '/',
  checkPermission('movements:create'),
  movementsController.createMovement
);
```

3. **Agregar rate limiting:**

```typescript
import rateLimit from 'express-rate-limit';

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100, // 100 creates per 15 min
  keyGenerator: (req) => (req as any).user.id,
});

router.post('/', createLimiter, movementsController.createMovement);
```

4. **Home page con resumen de empresas:**

```typescript
// GET /api/user/companies
→ [{
  id: 'company-1',
  name: 'Mi Empresa',
  taxId: '12345678A',
  stats: {
    movementCount: 150,
    totalIncome: 50000,
    totalExpense: 5000,
  }
}, ...]
```

**Cambios en Frontend:**

1. **Crear Home page:**

```typescript
// app/dashboard/page.tsx → app/home/page.tsx
export default function HomePage() {
  const { companies } = useCompanies();
  
  return (
    <div>
      <h1>Mis Empresas</h1>
      <div className="grid grid-cols-3 gap-4">
        {companies.map((c) => (
          <CompanyCard
            key={c.id}
            company={c}
            onClick={() => {
              setCompanyId(c.id);
              router.push('/dashboard');
            }}
          />
        ))}
      </div>
    </div>
  );
}
```

2. **Proteger rutas por permiso:**

```typescript
// app/movements/new/page.tsx
import { withPermission } from '@/middleware/withPermission';

export default withPermission('movements:create', function NewMovementPage() {
  // Solo visible si user tiene permiso
});
```

3. **Tests:**

```typescript
// hooks/useMovements.test.ts
describe('useMovements', () => {
  it('creates movement', async () => {
    // Test...
  });

  it('handles permission error', async () => {
    // Test...
  });
});
```

**Entregables Fase 2.3:**

- ✅ Home page con empresas
- ✅ Roles (admin, contable, lector) en BD
- ✅ Middleware de permisos
- ✅ Rate limiting
- ✅ Tests básicos (Vitest)
- ✅ Protección de rutas

**Esfuerzo:** ~3-4 semanas  
**Impacto:** App lista para multi-usuario, segura

---

### 4.5 ROADMAP VISUAL

```
Jun 2026  |████████ MVP                    (implementado)
Jul 2026  |████████████ Fase 2.1 (UX)     (3-4 sem)
Aug 2026  |████████ Fase 2.2 (Reporting)  (2-3 sem)
Sep 2026  |████████████ Fase 2.3 (Roles)  (3-4 sem)
Oct 2026  |████████ Pulido final           (1-2 sem)
          
Timeline total: 6 meses hasta producto v1.0 profesional
```

---

## PARTE 5: ACCIONES INMEDIATAS (TOP 5)

### **1. VALIDACIÓN CON ZOD (Impacto: Alto, Esfuerzo: Bajo)**

**Qué hacer:**
```bash
npm install zod
```

**En backend:**
```typescript
// src/validators/movements.ts
import { z } from 'zod';

export const createMovementSchema = z.object({
  type: z.enum(['income', 'expense']),
  amount: z.coerce.number().positive('Must be > 0').max(999999),
  category: z.string().min(2).max(50).trim(),
  description: z.string().min(5).max(500).trim(),
  date: z.string()
    .refine((d) => new Date(d) <= new Date(), 'Cannot be future'),
  referenceDocument: z.string().optional(),
});

export type CreateMovement = z.infer<typeof createMovementSchema>;
```

**En controller:**
```typescript
try {
  const data = createMovementSchema.parse(req.body);
  const movement = await movementsService.createMovement(companyId, data);
  return res.status(201).json(movement);
} catch (error) {
  if (error instanceof z.ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: error.errors,
    });
  }
  // ...
}
```

**En frontend:**
```typescript
// hooks/useMovementForm.ts
import { createMovementSchema } from '@/types/schemas';

const [errors, setErrors] = useState<Record<string, string>>({});

const handleSubmit = async (form: typeof initialForm) => {
  try {
    const validated = createMovementSchema.parse(form);
    await onSubmit(validated);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const fieldErrors: Record<string, string> = {};
      error.errors.forEach((err) => {
        const path = err.path[0];
        if (path) fieldErrors[path] = err.message;
      });
      setErrors(fieldErrors);
    }
  }
};
```

**Tiempo:** 2 horas  
**Impacto:** Validación robusta, mensajes claros, tipo-seguro

---

### **2. COMPANY CONTEXT (Impacto: Alto, Esfuerzo: Medio)**

**Qué hacer:**

```typescript
// context/CompanyContext.tsx
'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

interface CompanyContextType {
  companyId: string | null;
  setCompanyId: (id: string) => void;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('selectedCompanyId');
  });

  const handleSetCompanyId = (id: string) => {
    setCompanyId(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem('selectedCompanyId', id);
    }
  };

  return (
    <CompanyContext.Provider value={{ companyId, setCompanyId: handleSetCompanyId }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error('useCompany must be used within CompanyProvider');
  }
  return context;
}
```

**En app/layout.tsx:**
```typescript
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <CompanyProvider>
          <Header />
          <main>{children}</main>
        </CompanyProvider>
      </body>
    </html>
  );
}
```

**En componentes:**
```typescript
// Antes:
const { user } = useAuth();
const { movements } = useMovements(user?.companyId);

// Después:
const { companyId } = useCompany();
const { movements } = useMovements(companyId);
// Sin pasar en cada lugar
```

**Tiempo:** 3 horas  
**Impacto:** Menos prop drilling, contexto persistente

---

### **3. DASHBOARD MEJORADO (Impacto: Alto, Esfuerzo: Medio)**

**Qué hacer:**

Nueva estructura HTML en `app/dashboard/page.tsx`:

```typescript
'use client';

import { PeriodSelector } from '@/components/PeriodSelector';
import { StatsCards } from '@/components/dashboard/StatsCards';
import { IncomeExpenseChart } from '@/components/dashboard/IncomeExpenseChart';
import { CategoryChart } from '@/components/dashboard/CategoryChart';
import { RecentMovements } from '@/components/dashboard/RecentMovements';
import { QuickActions } from '@/components/dashboard/QuickActions';

export default function DashboardPage() {
  const { companyId } = useCompany();
  const [period, setPeriod] = useState('current-month');
  const { stats, loading } = useStatistics(companyId, { period });

  return (
    <div className="p-8">
      {/* Header */}
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <PeriodSelector selected={period} onChange={setPeriod} />
      </div>

      {/* Stats Cards - con comparativas */}
      {stats && <StatsCards stats={stats} />}

      {/* Charts - 2 columnas */}
      <div className="grid grid-cols-2 gap-8 my-8">
        <IncomeExpenseChart data={stats?.byMonth || []} />
        <CategoryChart data={stats?.byCategory || []} />
      </div>

      {/* Quick Actions */}
      <QuickActions />

      {/* Recent Movements */}
      <RecentMovements limit={10} />
    </div>
  );
}
```

**Tiempo:** 4-5 horas  
**Impacto:** Visual muy mejorada, usuario entiende estado financiero de inmediato

---

### **4. CHART.JS INTEGRATION (Impacto: Alto, Esfuerzo: Bajo)**

**Qué hacer:**

```bash
npm install chart.js react-chartjs-2
```

**Componente línea:**
```typescript
// components/dashboard/IncomeExpenseChart.tsx
'use client';

import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

export function IncomeExpenseChart({ data }: { data: MonthlyStat[] }) {
  if (!data.length) return <div>No data</div>;

  const chartData = {
    labels: data.map((d) => d.month),
    datasets: [
      {
        label: 'Ingresos',
        data: data.map((d) => d.income),
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22, 163, 74, 0.05)',
        tension: 0.4,
        fill: true,
      },
      {
        label: 'Gastos',
        data: data.map((d) => d.expense),
        borderColor: '#dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.05)',
        tension: 0.4,
        fill: true,
      },
    ],
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-4">Evolución de ingresos y gastos</h3>
      <Line data={chartData} />
    </div>
  );
}
```

**Tiempo:** 2-3 horas  
**Impacto:** Visualización profesional, usuario ve tendencias

---

### **5. ERROR BOUNDARY (Impacto: Medio, Esfuerzo: Bajo)**

**Qué hacer:**

```typescript
// app/error.tsx
'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error tracking service (Sentry, etc)
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-red-50">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-red-600 mb-4">Oops!</h1>
        <p className="text-gray-600 mb-2">Algo salió mal.</p>
        <p className="text-sm text-gray-500 mb-6">{error.message}</p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Intentar de nuevo
        </button>
      </div>
    </div>
  );
}

// app/layout.tsx
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body>
        <CompanyProvider>
          <Suspense fallback={<Loading />}>
            {children}
          </Suspense>
        </CompanyProvider>
      </body>
    </html>
  );
}
```

**Tiempo:** 1-2 horas  
**Impacto:** App no se rompe, usuario ve mensaje claro

---

### **RESUMEN TOP 5 ACCIONES**

| Acción | Tiempo | Impacto | Prioridad |
|--------|--------|---------|-----------|
| 1. Zod Validation | 2h | Alto | ⭐⭐⭐ |
| 2. CompanyContext | 3h | Alto | ⭐⭐⭐ |
| 3. Dashboard mejorado | 5h | Alto | ⭐⭐⭐ |
| 4. Chart.js | 3h | Alto | ⭐⭐ |
| 5. Error Boundary | 2h | Medio | ⭐⭐ |
| **TOTAL** | **15h** | **Muy Alto** | **Do ASAP** |

**Timeline:** 2-3 días de desarrollo  
**Resultado:** App se siente profesional, usuario confía en ella

---

## CONCLUSIÓN

Tu app es un **MVP funcional** (✅ base sólida) pero necesita **pulido para producción** (⚠️ puntos críticos).

**Próximas 2 semanas:**
- Implementa las 5 acciones inmediatas
- Suma validación Zod + charts
- Dashboard se ve profesional

**Siguiente 4 semanas:**
- Fase 2.1 (UX mejorada)
- Gráficos avanzados
- Contexto multi-empresa

**En 2-3 meses:**
- Producto contable **profesional y usable** para trabajo real

¡La base está bien! Ahora es pulido y features avanzadas.

