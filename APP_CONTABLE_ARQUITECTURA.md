# APLICACIÓN CONTABLE PROFESIONAL — Arquitectura y Diseño

**Proyecto:** Frontend contable integrado con API conta-api  
**Fecha:** 2026-06-30  
**Stack:** Next.js 14 + TypeScript + TailwindCSS + Vercel  
**API Base:** https://conta-api-alpha.vercel.app  

---

## PARTE 1: DECISIONES DE ARQUITECTURA

### 1.1 Por qué Next.js y no React puro

| Aspecto | Next.js | React Puro |
|--------|---------|-----------|
| **Despliegue en Vercel** | ✅ Nativo, optimizado | ⚠️ Requiere setup extra |
| **Performance** | ✅ SSR/SSG, image optimization | ❌ CSR puro |
| **Rutas** | ✅ File-based routing | ❌ Requiere react-router |
| **API backend** | ✅ API routes propias | ⚠️ Requiere servidor separado |
| **SEO/Metadata** | ✅ Automático | ❌ Manual |
| **Curva aprendizaje** | ⚠️ Media | ✅ Simple |

**Decisión:** **Next.js 14** (App Router)
- Despliegue directo en Vercel
- API routes para middleware entre frontend y conta-api
- TypeScript obligatorio (mejor DX)
- Mejor performance y UX

### 1.2 Arquitectura en capas

```
┌─────────────────────────────────────────────────────┐
│          Next.js Frontend (Vercel)                  │
├─────────────────────────────────────────────────────┤
│  Pages (UI)     │  Components  │  Hooks             │
├─────────────────────────────────────────────────────┤
│           API Routes (Middleware)                   │
│  Proxy a conta-api + transformación de datos        │
├─────────────────────────────────────────────────────┤
│       conta-api Backend (https://conta-api-alpha.vercel.app)     │
│  Income Reader │ Registro Mercantil │ Contabilidad  │
└─────────────────────────────────────────────────────┘
```

**Ventajas:**
- Frontend y backend desacoplados
- Transformación de datos en la capa middleware
- Reutilización de API routes para múltiples clientes futuros
- Caché de datos sin afectar backend

---

## PARTE 2: MODELOS DE DATOS

### 2.1 Modelo de Movimiento Contable

```typescript
// types/accounting.ts

export interface Movement {
  id: string;                    // UUID
  companyId: string;            // Empresa (multi-tenant)
  type: 'income' | 'expense';    // Tipo
  amount: number;               // Importe (positivo)
  category: string;             // Categoría (ej: "ventas", "suministros")
  description: string;          // Descripción
  date: string;                 // YYYY-MM-DD
  referenceDocument?: string;   // ID de documento vinculado (Income Reader)
  fiscalYear: number;           // Año fiscal (ej: 2026)
  status: 'draft' | 'approved' | 'reconciled'; // Estado
  createdAt: string;
  updatedAt: string;
}

export interface MovementFilter {
  companyId?: string;
  type?: 'income' | 'expense';
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
}

export interface MovementSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  movementCount: number;
  period: 'month' | 'year' | 'custom';
}
```

### 2.2 Modelo de Documento

```typescript
// types/documents.ts

export interface Document {
  id: string;
  companyId: string;
  type: 'invoice' | 'receipt' | 'bill' | 'other';
  
  // Income Reader state
  incomeReaderState: 'UPLOADED' | 'PROCESSING' | 'READY_FOR_VERIFICATION' | 'REJECTED' | 'ERROR';
  incomeReaderId?: string;      // Link a Income Reader
  extractedData?: Record<string, any>; // Datos extraídos por OCR
  
  // Documento
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  processedAt?: string;
  
  // Versionado (Registro Mercantil)
  version: number;
  expiresAt?: string;           // Caducidad
  isObsolete: boolean;
  
  // Relación con movimiento
  linkedMovementId?: string;
  linkedMovement?: Movement;
  
  // Estado general
  status: 'pending' | 'verified' | 'rejected' | 'archived';
  errorMessage?: string;
  
  createdAt: string;
  updatedAt: string;
}

export interface DocumentFilter {
  companyId?: string;
  type?: string;
  status?: string;
  incomeReaderState?: string;
  dateFrom?: string;
  dateTo?: string;
}
```

### 2.3 Modelo de Estadísticas

```typescript
// types/statistics.ts

export interface DashboardStats {
  summary: MovementSummary;
  byCategory: Array<{
    category: string;
    income: number;
    expense: number;
    percentage: number;
  }>;
  byMonth: Array<{
    month: string;      // "2026-01", "2026-02", etc.
    income: number;
    expense: number;
    balance: number;
  }>;
  documentStats: {
    total: number;
    processing: number;
    rejected: number;
    verified: number;
  };
  topCategories: Array<{
    category: string;
    amount: number;
    count: number;
  }>;
}
```

---

## PARTE 3: ENDPOINTS NECESARIOS

### 3.1 Endpoints Existentes en conta-api que Usaremos

```
✅ GET  /api/health                           → Verificar API viva
✅ POST /api/auth/login                       → Autenticación
✅ GET  /api/companies/:id                    → Info empresa
✅ POST /api/income-reader/web-upload         → Subir documento
✅ GET  /api/income-reader/pending            → Listar pendientes
✅ GET  /api/income-reader/:id                → Detalle documento
```

### 3.2 Endpoints NUEVOS Necesarios en conta-api

Para que el frontend funcione correctamente, necesitamos agregar **endpoints mínimos**:

```typescript
// Backend conta-api NEW ENDPOINTS

// Movimientos contables
POST   /api/companies/:companyId/movements           // Crear movimiento
GET    /api/companies/:companyId/movements           // Listar movimientos (con filtros)
GET    /api/companies/:companyId/movements/:id       // Detalle
PATCH  /api/companies/:companyId/movements/:id       // Actualizar
DELETE /api/companies/:companyId/movements/:id       // Eliminar (soft delete)

// Estadísticas
GET    /api/companies/:companyId/stats/summary       // Resumen (total ingreso, gasto, balance)
GET    /api/companies/:companyId/stats/by-category   // Desglose por categoría
GET    /api/companies/:companyId/stats/by-month      // Desglose por mes
GET    /api/companies/:companyId/stats/documents     // Stats de documentos

// Documentos vinculados
PATCH  /api/income-reader/:docId/link-movement      // Vincular documento a movimiento
GET    /api/companies/:companyId/documents           // Listar documentos (con filtros)
```

**Cambios mínimos en backend:**
- Agregar tabla `movements` (si no existe)
- Agregar tabla `document_links` (relación documento-movimiento)
- Agregar estos 8 endpoints (rutas nuevas)
- **SIN refactorización de lógica existente**

---

## PARTE 4: ESTRUCTURA DEL FRONTEND

### 4.1 Árbol de carpetas

```
frontend-contable/
├── app/
│   ├── layout.tsx                    # Layout global
│   ├── page.tsx                      # Redirect a /dashboard
│   ├── dashboard/
│   │   └── page.tsx                  # Dashboard principal
│   ├── movements/
│   │   ├── page.tsx                  # Listado de movimientos
│   │   └── [id]/
│   │       └── page.tsx              # Detalle/edición movimiento
│   ├── documents/
│   │   └── page.tsx                  # Listado de documentos
│   ├── api/
│   │   ├── movements/                # Proxy a conta-api
│   │   ├── documents/
│   │   ├── statistics/
│   │   └── auth/
│   └── auth/
│       └── login/
│           └── page.tsx              # Página de login
├── components/
│   ├── common/
│   │   ├── Header.tsx
│   │   ├── Sidebar.tsx
│   │   ├── Card.tsx
│   │   └── Button.tsx
│   ├── dashboard/
│   │   ├── StatsCard.tsx
│   │   ├── ChartIncome.tsx
│   │   ├── ChartExpense.tsx
│   │   └── DocumentsWidget.tsx
│   ├── movements/
│   │   ├── MovementsTable.tsx
│   │   ├── MovementForm.tsx
│   │   └── MovementFilters.tsx
│   └── documents/
│       ├── DocumentsList.tsx
│       ├── DocumentUpload.tsx
│       └── DocumentStatusBadge.tsx
├── hooks/
│   ├── useAuth.ts
│   ├── useMovements.ts
│   ├── useDocuments.ts
│   ├── useStatistics.ts
│   └── useFetch.ts
├── services/
│   ├── api.ts                        # Cliente HTTP (fetch wrapper)
│   ├── movements.service.ts          # Lógica de movimientos
│   ├── documents.service.ts          # Lógica de documentos
│   └── auth.service.ts               # Lógica de auth
├── types/
│   ├── accounting.ts
│   ├── documents.ts
│   ├── statistics.ts
│   └── index.ts
├── context/
│   ├── AuthContext.tsx
│   └── CompanyContext.tsx
├── utils/
│   ├── dates.ts
│   ├── currency.ts
│   ├── validators.ts
│   └── formatters.ts
├── public/
│   └── (assets, icons)
├── styles/
│   └── globals.css
├── .env.local                        # Variables de entorno
├── tailwind.config.ts
├── tsconfig.json
├── next.config.ts
├── package.json
└── README.md
```

### 4.2 Flujo de navegación

```
Login
  ↓
Dashboard (Resumen de ingresos, gastos, gráficos)
  ├─→ Movimientos (Tabla filtrable de ingresos/gastos)
  │   └─→ Crear/Editar movimiento
  ├─→ Documentos (Listado de documentos OCR)
  │   ├─→ Subir documento
  │   └─→ Vincular a movimiento
  └─→ Configuración (Empresa, categorías, etc.)
```

---

## PARTE 5: IMPLEMENTACIÓN BASE

### 5.1 `types/accounting.ts` (Modelos)

```typescript
// types/accounting.ts

export interface Movement {
  id: string;
  companyId: string;
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  date: string; // YYYY-MM-DD
  referenceDocument?: string;
  fiscalYear: number;
  status: 'draft' | 'approved' | 'reconciled';
  createdAt: string;
  updatedAt: string;
}

export interface CreateMovementDTO {
  type: 'income' | 'expense';
  amount: number;
  category: string;
  description: string;
  date: string;
  referenceDocument?: string;
}

export interface MovementSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  movementCount: number;
}

export interface Document {
  id: string;
  companyId: string;
  type: 'invoice' | 'receipt' | 'bill' | 'other';
  incomeReaderState: 'UPLOADED' | 'PROCESSING' | 'READY_FOR_VERIFICATION' | 'REJECTED' | 'ERROR';
  incomeReaderId?: string;
  extractedData?: Record<string, any>;
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  processedAt?: string;
  version: number;
  expiresAt?: string;
  isObsolete: boolean;
  linkedMovementId?: string;
  status: 'pending' | 'verified' | 'rejected' | 'archived';
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardStats {
  summary: MovementSummary;
  byCategory: Array<{ category: string; income: number; expense: number; percentage: number }>;
  byMonth: Array<{ month: string; income: number; expense: number; balance: number }>;
  documentStats: { total: number; processing: number; rejected: number; verified: number };
}
```

### 5.2 `services/api.ts` (Cliente HTTP)

```typescript
// services/api.ts

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://conta-api-alpha.vercel.app';

class ApiClient {
  private token: string | null = null;

  setToken(token: string) {
    this.token = token;
  }

  private getHeaders() {
    return {
      'Content-Type': 'application/json',
      ...(this.token && { Authorization: `Bearer ${this.token}` }),
    };
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  async post<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  async patch<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    return res.json();
  }
}

export const apiClient = new ApiClient();
```

### 5.3 `services/movements.service.ts`

```typescript
// services/movements.service.ts

import { apiClient } from './api';
import { Movement, CreateMovementDTO, MovementSummary } from '@/types/accounting';

export const movementsService = {
  async getMovements(companyId: string, filters?: any): Promise<Movement[]> {
    const params = new URLSearchParams(filters).toString();
    return apiClient.get(`/api/companies/${companyId}/movements?${params}`);
  },

  async getMovement(companyId: string, id: string): Promise<Movement> {
    return apiClient.get(`/api/companies/${companyId}/movements/${id}`);
  },

  async createMovement(companyId: string, data: CreateMovementDTO): Promise<Movement> {
    return apiClient.post(`/api/companies/${companyId}/movements`, data);
  },

  async updateMovement(companyId: string, id: string, data: Partial<Movement>): Promise<Movement> {
    return apiClient.patch(`/api/companies/${companyId}/movements/${id}`, data);
  },

  async deleteMovement(companyId: string, id: string): Promise<void> {
    await apiClient.delete(`/api/companies/${companyId}/movements/${id}`);
  },

  async getSummary(companyId: string): Promise<MovementSummary> {
    return apiClient.get(`/api/companies/${companyId}/stats/summary`);
  },

  async getByCategory(companyId: string): Promise<any[]> {
    return apiClient.get(`/api/companies/${companyId}/stats/by-category`);
  },

  async getByMonth(companyId: string): Promise<any[]> {
    return apiClient.get(`/api/companies/${companyId}/stats/by-month`);
  },
};
```

### 5.4 `hooks/useMovements.ts`

```typescript
// hooks/useMovements.ts

import { useState, useEffect } from 'react';
import { Movement, MovementSummary } from '@/types/accounting';
import { movementsService } from '@/services/movements.service';

export function useMovements(companyId: string) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [summary, setSummary] = useState<MovementSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;

    const loadData = async () => {
      try {
        setLoading(true);
        const [movs, summ] = await Promise.all([
          movementsService.getMovements(companyId),
          movementsService.getSummary(companyId),
        ]);
        setMovements(movs);
        setSummary(summ);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error loading movements');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [companyId]);

  return { movements, summary, loading, error };
}
```

### 5.5 `app/dashboard/page.tsx` (Dashboard)

```typescript
// app/dashboard/page.tsx

'use client';

import { useAuth } from '@/hooks/useAuth';
import { useMovements } from '@/hooks/useMovements';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { ChartIncome } from '@/components/dashboard/ChartIncome';
import { DocumentsWidget } from '@/components/dashboard/DocumentsWidget';

export default function DashboardPage() {
  const { user } = useAuth();
  const { summary, loading } = useMovements(user?.companyId);

  if (loading) return <div className="p-8">Cargando...</div>;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Contable</h1>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatsCard
          title="Ingresos"
          value={`€${(summary?.totalIncome || 0).toFixed(2)}`}
          trend="+5.2%"
          color="green"
        />
        <StatsCard
          title="Gastos"
          value={`€${(summary?.totalExpense || 0).toFixed(2)}`}
          trend="-2.1%"
          color="red"
        />
        <StatsCard
          title="Balance"
          value={`€${(summary?.balance || 0).toFixed(2)}`}
          color={summary?.balance >= 0 ? 'green' : 'red'}
        />
        <StatsCard
          title="Movimientos"
          value={summary?.movementCount || 0}
          color="blue"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
        <ChartIncome companyId={user?.companyId} />
        <ChartIncome type="expense" companyId={user?.companyId} />
      </div>

      {/* Documents */}
      <DocumentsWidget companyId={user?.companyId} />
    </div>
  );
}
```

### 5.6 `app/movements/page.tsx` (Listado movimientos)

```typescript
// app/movements/page.tsx

'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useMovements } from '@/hooks/useMovements';
import { MovementsTable } from '@/components/movements/MovementsTable';
import { MovementFilters } from '@/components/movements/MovementFilters';
import Link from 'next/link';

export default function MovementsPage() {
  const { user } = useAuth();
  const { movements, loading } = useMovements(user?.companyId);
  const [filters, setFilters] = useState({});

  const filtered = movements.filter((m) => {
    if (filters.type && m.type !== filters.type) return false;
    if (filters.category && m.category !== filters.category) return false;
    if (filters.dateFrom && m.date < filters.dateFrom) return false;
    if (filters.dateTo && m.date > filters.dateTo) return false;
    return true;
  });

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Movimientos</h1>
        <Link href="/movements/new" className="px-4 py-2 bg-blue-600 text-white rounded">
          + Nuevo Movimiento
        </Link>
      </div>

      <MovementFilters onFilter={setFilters} />
      <MovementsTable movements={filtered} loading={loading} />
    </div>
  );
}
```

### 5.7 `components/dashboard/StatsCard.tsx`

```typescript
// components/dashboard/StatsCard.tsx

interface StatsCardProps {
  title: string;
  value: string | number;
  trend?: string;
  color: 'green' | 'red' | 'blue' | 'yellow';
}

export function StatsCard({ title, value, trend, color }: StatsCardProps) {
  const colorClass = {
    green: 'border-green-500 bg-green-50',
    red: 'border-red-500 bg-red-50',
    blue: 'border-blue-500 bg-blue-50',
    yellow: 'border-yellow-500 bg-yellow-50',
  }[color];

  return (
    <div className={`border-l-4 ${colorClass} p-6 rounded-lg`}>
      <p className="text-gray-600 text-sm font-medium">{title}</p>
      <p className="text-2xl font-bold mt-2">{value}</p>
      {trend && <p className="text-xs text-gray-500 mt-2">{trend}</p>}
    </div>
  );
}
```

### 5.8 `app/api/health/route.ts` (Health check proxy)

```typescript
// app/api/health/route.ts

import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await fetch('https://conta-api-alpha.vercel.app/api/health');
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json({ error: 'API unavailable' }, { status: 503 });
  }
}
```

---

## PARTE 6: VARIABLES DE ENTORNO

### `.env.local`

```bash
# API
NEXT_PUBLIC_API_URL=https://conta-api-alpha.vercel.app
NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000

# Auth (si necesita implementar JWT token storage)
NEXT_PUBLIC_JWT_STORAGE_KEY=conta_api_token

# Analytics (opcional)
NEXT_PUBLIC_ANALYTICS_ID=
```

---

## PARTE 7: PASOS DE DESPLIEGUE

### 7.1 Crear proyecto Next.js localmente

```bash
# Crear proyecto
npx create-next-app@latest frontend-contable --typescript --tailwind --app

cd frontend-contable

# Instalar dependencias adicionales
npm install chart.js react-chartjs-2 date-fns

# Crear estructura de carpetas
mkdir -p app/{dashboard,movements,documents,auth/login}
mkdir -p components/{common,dashboard,movements,documents}
mkdir -p hooks services types context utils
```

### 7.2 Estructura de archivos base

Copiar los archivos que he proporcionado en la sección 5 a sus respectivas carpetas.

### 7.3 Configurar Next.js

```typescript
// next.config.ts

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  swcMinify: true,
};

export default nextConfig;
```

```typescript
// tailwind.config.ts

import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
```

### 7.4 Probar localmente

```bash
npm run dev
# Abre http://localhost:3000
```

### 7.5 Desplegar en Vercel

```bash
# Opción 1: Push a GitHub
git add .
git commit -m "feat: Add professional accounting app frontend"
git push origin main

# Vercel auto-deploys

# Opción 2: Vercel CLI
npm install -g vercel
vercel deploy --prod
```

### 7.6 Variables de entorno en Vercel Dashboard

En https://vercel.com/nafergu75s-projects/frontend-contable/settings/environment-variables:

```
NEXT_PUBLIC_API_URL = https://conta-api-alpha.vercel.app
NEXT_PUBLIC_FRONTEND_URL = https://frontend-contable-xxx.vercel.app
```

---

## PARTE 8: ENDPOINTS DEL BACKEND A IMPLEMENTAR

Para que esto funcione, necesitas agregar estos **8 endpoints** en tu backend conta-api:

### Backend: `src/routes/movements.routes.ts` (NUEVO)

```typescript
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router({ mergeParams: true });

// Crear movimiento
router.post('/', authMiddleware, async (req, res) => {
  const { companyId } = req.params;
  const { type, amount, category, description, date } = req.body;
  
  // Validar
  if (!type || !amount || !category || !date) {
    return res.status(400).json({ error: 'Campos requeridos faltantes' });
  }
  
  try {
    // Guardar en BD (Prisma)
    const movement = await prisma.movement.create({
      data: {
        companyId,
        type,
        amount,
        category,
        description,
        date: new Date(date),
        status: 'approved',
      },
    });
    
    return res.status(201).json(movement);
  } catch (error) {
    return res.status(500).json({ error: 'Error creando movimiento' });
  }
});

// Listar movimientos (con filtros)
router.get('/', authMiddleware, async (req, res) => {
  const { companyId } = req.params;
  const { type, category, dateFrom, dateTo } = req.query;
  
  try {
    const where = { companyId };
    if (type) Object.assign(where, { type });
    if (category) Object.assign(where, { category });
    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.gte = new Date(dateFrom as string);
      if (dateTo) where.date.lte = new Date(dateTo as string);
    }
    
    const movements = await prisma.movement.findMany({
      where,
      orderBy: { date: 'desc' },
    });
    
    return res.json(movements);
  } catch (error) {
    return res.status(500).json({ error: 'Error listando movimientos' });
  }
});

// Resumen
router.get('/stats/summary', authMiddleware, async (req, res) => {
  const { companyId } = req.params;
  
  try {
    const movements = await prisma.movement.findMany({ where: { companyId } });
    
    const totalIncome = movements
      .filter((m) => m.type === 'income')
      .reduce((sum, m) => sum + m.amount, 0);
    
    const totalExpense = movements
      .filter((m) => m.type === 'expense')
      .reduce((sum, m) => sum + m.amount, 0);
    
    return res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      movementCount: movements.length,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Error calculando resumen' });
  }
});

// ... más endpoints

export default router;
```

---

## PARTE 9: GUÍA DE USO

### Flujo básico de un usuario

**1. Login**
- Usuario entra a https://frontend-contable.vercel.app
- Login con email/password
- Token guardado en localStorage

**2. Ver Dashboard**
- Ve resumen de ingresos, gastos, balance
- Gráficos por mes
- Widgets de documentos pendientes

**3. Registrar Movimiento (Ingreso)**
- Click en "+ Nuevo Movimiento"
- Rellena:
  - Tipo: Ingreso
  - Importe: 5000 €
  - Categoría: Ventas
  - Descripción: Factura cliente X
  - Fecha: 2026-06-30
- Click "Guardar"
- Aparece en lista de movimientos y se actualiza dashboard

**4. Subir Documento (Factura)**
- Sección "Documentos"
- Drag & drop de PDF/foto
- Income Reader procesa (OCR)
- Espera estado READY_FOR_VERIFICATION
- Opcional: Vincular a movimiento existente

**5. Ver Estadísticas**
- Dashboard muestra:
  - Total ingresos / gastos del mes
  - Desglose por categoría
  - Evolución mensual
  - Documentos procesados vs. rechazados

---

## PARTE 10: PRÓXIMOS PASOS OPCIONALES

Después de la versión base, puedes agregar:

1. **Exportar a Excel/PDF** — Reportes contables
2. **Multi-empresa** — Selector de empresa en UI
3. **Categorías personalizadas** — CRUD de categorías
4. **Reconciliación bancaria** — Comparar movimientos con extractos
5. **Notificaciones** — Alertas de documentos rechazados
6. **Dark mode** — Toggle en settings
7. **API de terceros** — Integración con otros contables

---

## RESUMEN FINAL

✅ **Arquitectura:** Next.js + TypeScript + TailwindCSS  
✅ **Despliegue:** Vercel (mismo que backend)  
✅ **Modelos:** Movimientos + Documentos + Estadísticas  
✅ **Endpoints:** 8 nuevos en backend (cambios mínimos)  
✅ **UX:** Dashboard, movimientos, documentos, formularios  
✅ **Código base:** Listo para copiar y pegar  
✅ **Guía:** Pasos de despliegue y uso  

**Tiempo estimado de implementación:** 2-3 días para versión MVP  
**Complejidad técnica:** Media-Alta (pero bien estructurada)  

¡Listo para ser una app contable profesional! 🚀

