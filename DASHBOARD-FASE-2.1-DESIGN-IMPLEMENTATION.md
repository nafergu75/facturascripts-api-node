# FASE 2.1: DASHBOARD CONTABLE PROFESIONAL

**Diseño, componentes y implementación completa del dashboard con gráficos y UX real**

---

## RESUMEN ESTRATEGIA

**Objetivo:** Convertir /dashboard en un panel contable profesional que se sienta como un producto real, con datos en vivo, gráficos intuitivos y experiencia de usuario clara.

**Enfoque:**
1. **Layout limpio:** contexto (empresa + período) → KPIs → gráficos → lista de movimientos → acciones
2. **Datos reales:** hooks SWR para stats/by-category/by-month, actualizaciones en vivo
3. **Gráficos visuales:** Chart.js con colores contables (verde=ingreso, rojo=gasto, azul=balance)
4. **Responsive:** adaptable a mobile/tablet/desktop
5. **Zero breaking changes:** construido sobre las Semanas 1-2

**Stack:**
- Chart.js (librería gráficos)
- react-chartjs-2 (wrapper React)
- SWR (caché de datos)
- TailwindCSS (diseño)
- TypeScript (tipos)

**Nuevos archivos:** 8 (componentes + hooks + página)  
**Modificaciones:** 2 (tipos + servicios si necesario)

---

## PARTE 1: LAYOUT Y UX DEL DASHBOARD

### 1.1 Diagrama textual del layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            HEADER (existente)                           │
│  Logo │ Nav (Dashboard/Movimientos/Documentos) │ [Empresa ▼] [Logout]  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  DASHBOARD                                                              │
├─────────────────────────────────────────────────────────────────────────┤
│
│  SECCIÓN 1: CONTEXTO Y CONTROLES
│  ┌─────────────────────────────────────────────────────────────────────┐
│  │ Período: [Este mes ▼] [Custom: De [__] A [__]]                     │
│  │ [Exportar CSV] [Exportar PDF] [Refrescar]                          │
│  └─────────────────────────────────────────────────────────────────────┘
│
│  SECCIÓN 2: KPIs PRINCIPALES (4 COLUMNAS)
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  │ 📈 Ingresos      │ │ 📉 Gastos        │ │ 💰 Balance       │ │ 📊 Movimientos   │
│  │ €16,500          │ │ €2,340           │ │ €14,160 ✅       │ │ 47               │
│  │ ↑ +15% vs mes    │ │ ↓ -8% vs mes     │ │ ↑ +22% vs mes    │ │ +5 vs mes        │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘ └──────────────────┘
│
│  SECCIÓN 3: GRÁFICOS (2 COLUMNAS)
│  ┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
│  │ Ingresos vs Gastos (últimos 6 meses) │ │ Gastos por Categoría (este mes)      │
│  │                                      │ │                                      │
│  │  [Gráfico de líneas]                 │ │  [Gráfico pie/donut]                 │
│  │  ▄                                   │ │                                      │
│  │  █ ▄▄█                               │ │         ╱╲                           │
│  │  █ █ █  ─ Ingresos                  │ │       ╱    ╲    Suministros: 30%    │
│  │  ──────  ─ Gastos                   │ │      │      │   Salarios: 45%      │
│  │                                      │ │       ╲    ╱    Otros: 25%         │
│  │                                      │ │         ╲╱                          │
│  └──────────────────────────────────────┘ └──────────────────────────────────┘
│
│  SECCIÓN 4: GRÁFICO EVOLUCIÓN BALANCE
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ Balance acumulado (últimos 12 meses)                                │
│  │                                                                      │
│  │  [Área chart: balance histórico]                                   │
│  │                                                                      │
│  └──────────────────────────────────────────────────────────────────────┘
│
│  SECCIÓN 5: ÚLTIMOS MOVIMIENTOS
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ Últimos 10 movimientos registrados                    [Ver todos →]  │
│  ├──────────────────────────────────────────────────────────────────────┤
│  │ Fecha      │ Tipo     │ Categoría      │ Descripción        │ Importe │
│  │ 30-Jun     │ Ingreso  │ Ventas         │ Factura cliente A  │ €5,000  │
│  │ 29-Jun     │ Gasto    │ Suministros    │ Material oficina    │ €250    │
│  │ 28-Jun     │ Ingreso  │ Servicios      │ Consultoría        │ €2,500  │
│  │ ...                                                                    │
│  │ 20-Jun     │ Gasto    │ Salarios       │ Nómina empleados   │ €4,000  │
│  └──────────────────────────────────────────────────────────────────────┘
│
│  SECCIÓN 6: ACCIONES RÁPIDAS
│  ┌──────────────────────────────────────────────────────────────────────┐
│  │ [+ Registrar Movimiento]  [+ Subir Documento]  [+ Crear Presupuesto] │
│  └──────────────────────────────────────────────────────────────────────┘
│
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Clases Tailwind por sección

```typescript
// CONTENEDOR PRINCIPAL
className="min-h-screen bg-gray-50 py-8"

// SECCIÓN CONTEXTO
className="bg-white rounded-lg shadow-sm p-6 mb-8 border border-gray-200"

// HEADER SECCIÓN
className="text-lg font-semibold text-gray-900 mb-4"

// KPIs GRID (4 columnas)
className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8"

// GRÁFICOS GRID (2 columnas)
className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8"

// GRÁFICO CONTENEDOR
className="bg-white rounded-lg shadow-sm p-6 border border-gray-200"

// TABLA ÚLTIMOS MOVIMIENTOS
className="bg-white rounded-lg shadow-sm overflow-hidden"

// ACCIONES RÁPIDAS
className="bg-white rounded-lg shadow-sm p-6 border-t-4 border-blue-600"
```

---

## PARTE 2: TIPOS TYPESCRIPT Y DATOS

### 2.1 Tipos de respuesta de stats

**Archivo:** `types/dashboard.ts` (CREAR)

```typescript
export interface DashboardSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  movementCount: number;
  documentCount?: number;
  documentProcessing?: number;
  documentRejected?: number;
  // Comparativas (vs período anterior)
  previousIncome?: number;
  previousExpense?: number;
  previousBalance?: number;
  period: string; // "Jun 2026" o similar
}

export interface CategoryStat {
  category: string;
  income: number;
  expense: number;
  percentage: number;
  count: number;
}

export interface MonthlyStat {
  month: string; // "Jun" o "2026-06"
  income: number;
  expense: number;
  balance: number;
  movementCount: number;
}

export interface DashboardData {
  summary: DashboardSummary;
  byCategory: CategoryStat[];
  byMonth: MonthlyStat[];
  lastMovements: Movement[]; // Del tipo Movement existente
}

// Para comparativas
export interface PercentageChange {
  value: number;
  percentage: number;
  direction: 'up' | 'down' | 'neutral';
  label: string; // "↑12%" o "↓5%"
}

export function calculatePercentageChange(
  current: number,
  previous: number
): PercentageChange {
  if (previous === 0) {
    return {
      value: current,
      percentage: 0,
      direction: 'neutral',
      label: 'N/A',
    };
  }

  const change = ((current - previous) / previous) * 100;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';

  return {
    value: current,
    percentage: Math.abs(change),
    direction,
    label: `${direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'} ${Math.abs(change).toFixed(1)}%`,
  };
}
```

---

## PARTE 3: HOOKS SWR

### 3.1 Actualizar servicios con endpoints de stats

**Archivo:** `services/movements.service.ts` (VERIFICAR/ACTUALIZAR)

```typescript
// Asegúrate de que existen estos métodos:
export async function getSummary(companyId: string): Promise<DashboardSummary> {
  // GET /api/companies/:companyId/stats/summary
  const response = await apiClient.get(
    `/api/companies/${companyId}/stats/summary`
  );
  return response;
}

export async function getByCategory(companyId: string): Promise<CategoryStat[]> {
  // GET /api/companies/:companyId/stats/by-category
  const response = await apiClient.get(
    `/api/companies/${companyId}/stats/by-category`
  );
  return response;
}

export async function getByMonth(companyId: string): Promise<MonthlyStat[]> {
  // GET /api/companies/:companyId/stats/by-month
  const response = await apiClient.get(
    `/api/companies/${companyId}/stats/by-month`
  );
  return response;
}

export async function listRecent(companyId: string, limit = 10): Promise<Movement[]> {
  // GET /api/companies/:companyId/movements?limit=10&order=desc
  const response = await apiClient.get(
    `/api/companies/${companyId}/movements?pageSize=${limit}&page=1`
  );
  return response.data || response; // Adaptar a paginación
}
```

### 3.2 Crear hooks para dashboard

**Archivo:** `hooks/useDashboard.ts` (CREAR)

```typescript
'use client';

import useSWR from 'swr';
import { useCompany } from '@/context/CompanyContext';
import { DashboardSummary, CategoryStat, MonthlyStat, Movement } from '@/types';
import { movementsService } from '@/services/movements.service';

interface DashboardFilters {
  period?: 'current-month' | 'last-3-months' | 'current-year' | 'custom';
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Hook para datos del dashboard (summary + by-category + by-month)
 */
export function useDashboard(filters?: DashboardFilters) {
  const { companyId } = useCompany();

  // Key para SWR (incluir filtros para caché separado)
  const filterKey = filters ? JSON.stringify(filters) : '';
  const key = companyId ? `/dashboard/${companyId}${filterKey}` : null;

  const fetcher = async () => {
    if (!companyId) throw new Error('No company selected');

    // Ejecutar en paralelo
    const [summary, byCategory, byMonth, lastMovements] = await Promise.all([
      movementsService.getSummary(companyId),
      movementsService.getByCategory(companyId),
      movementsService.getByMonth(companyId),
      movementsService.listRecent(companyId, 10),
    ]);

    return {
      summary,
      byCategory,
      byMonth,
      lastMovements,
    };
  };

  const { data, error, isLoading, mutate } = useSWR(key, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60 * 1000, // 5 min
    revalidateIfStale: false,
  });

  return {
    data: data || null,
    summary: data?.summary || null,
    byCategory: data?.byCategory || [],
    byMonth: data?.byMonth || [],
    lastMovements: data?.lastMovements || [],
    loading: isLoading,
    error,
    refresh: mutate,
  };
}

/**
 * Hook específico para summary (para reutilizar)
 */
export function useDashboardSummary() {
  const { companyId } = useCompany();
  const key = companyId ? `/stats/summary/${companyId}` : null;

  const { data, error, isLoading } = useSWR(
    key,
    () => movementsService.getSummary(companyId!),
    { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 }
  );

  return { summary: data || null, loading: isLoading, error };
}

/**
 * Hook específico para categorías
 */
export function useDashboardByCategory() {
  const { companyId } = useCompany();
  const key = companyId ? `/stats/by-category/${companyId}` : null;

  const { data, error, isLoading } = useSWR(
    key,
    () => movementsService.getByCategory(companyId!),
    { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 }
  );

  return { byCategory: data || [], loading: isLoading, error };
}

/**
 * Hook específico para meses
 */
export function useDashboardByMonth() {
  const { companyId } = useCompany();
  const key = companyId ? `/stats/by-month/${companyId}` : null;

  const { data, error, isLoading } = useSWR(
    key,
    () => movementsService.getByMonth(companyId!),
    { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 }
  );

  return { byMonth: data || [], loading: isLoading, error };
}
```

---

## PARTE 4: COMPONENTES DE GRÁFICOS

### 4.1 Instalar Chart.js

```bash
npm install chart.js react-chartjs-2
```

### 4.2 LineChartIncomeExpense

**Archivo:** `components/dashboard/LineChartIncomeExpense.tsx`

```typescript
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
  Filler,
} from 'chart.js';
import { MonthlyStat } from '@/types';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface LineChartIncomeExpenseProps {
  data: MonthlyStat[];
  loading?: boolean;
}

export function LineChartIncomeExpense({
  data,
  loading,
}: LineChartIncomeExpenseProps) {
  if (loading) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Cargando gráfico...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Sin datos
      </div>
    );
  }

  const chartData = {
    labels: data.map((d) => {
      // Extraer mes/año de formato "2026-06" o "Jun"
      const month = d.month.includes('-')
        ? d.month.split('-')[1]
        : d.month;
      return month;
    }),
    datasets: [
      {
        label: 'Ingresos',
        data: data.map((d) => d.income),
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22, 163, 74, 0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#16a34a',
        pointBorderColor: '#fff',
        pointRadius: 5,
        pointHoverRadius: 7,
      },
      {
        label: 'Gastos',
        data: data.map((d) => d.expense),
        borderColor: '#dc2626',
        backgroundColor: 'rgba(220, 38, 38, 0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#dc2626',
        pointBorderColor: '#fff',
        pointRadius: 5,
        pointHoverRadius: 7,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'top' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          font: { size: 14, weight: '600' as const },
          color: '#374151',
        },
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        titleFont: { size: 14, weight: 'bold' as const },
        bodyFont: { size: 13 },
        displayColors: true,
        callbacks: {
          label: (context: any) => {
            const value = context.parsed.y;
            return `${context.dataset.label}: €${value.toLocaleString('es-ES')}`;
          },
        },
      },
    },
    scales: {
      y: {
        ticks: {
          callback: (value: any) => `€${value.toLocaleString('es-ES')}`,
          color: '#6b7280',
          font: { size: 12 },
        },
        grid: {
          color: 'rgba(0, 0, 0, 0.05)',
        },
      },
      x: {
        ticks: {
          color: '#6b7280',
          font: { size: 12 },
        },
        grid: {
          display: false,
        },
      },
    },
  };

  return (
    <div className="h-80">
      <Line data={chartData} options={options} />
    </div>
  );
}
```

### 4.3 PieChartExpensesByCategory

**Archivo:** `components/dashboard/PieChartExpensesByCategory.tsx`

```typescript
'use client';

import { Pie } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { CategoryStat } from '@/types';

ChartJS.register(ArcElement, Tooltip, Legend);

interface PieChartExpensesByCategoryProps {
  data: CategoryStat[];
  loading?: boolean;
}

const COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#f59e0b', // amber
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
];

export function PieChartExpensesByCategory({
  data,
  loading,
}: PieChartExpensesByCategoryProps) {
  if (loading) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Cargando gráfico...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Sin datos
      </div>
    );
  }

  // Filtrar solo gastos (expense) o total, según lo que devuelva el backend
  // Asumir que data tiene expense field
  const chartData = {
    labels: data.map((d) => d.category),
    datasets: [
      {
        label: 'Gastos por categoría',
        data: data.map((d) => d.expense || d.percentage),
        backgroundColor: COLORS.slice(0, data.length),
        borderColor: '#fff',
        borderWidth: 2,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          usePointStyle: true,
          padding: 20,
          font: { size: 13, weight: '500' as const },
          color: '#374151',
        },
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        titleFont: { size: 14, weight: 'bold' as const },
        bodyFont: { size: 13 },
        callbacks: {
          label: (context: any) => {
            const value = context.parsed;
            const percentage =
              data[context.dataIndex]?.percentage || 0;
            return `€${value.toLocaleString('es-ES')} (${percentage.toFixed(1)}%)`;
          },
        },
      },
    },
  };

  return (
    <div className="h-80">
      <Pie data={chartData} options={options} />
    </div>
  );
}
```

### 4.4 AreaChartBalance

**Archivo:** `components/dashboard/AreaChartBalance.tsx`

```typescript
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
  Filler,
} from 'chart.js';
import { MonthlyStat } from '@/types';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Filler
);

interface AreaChartBalanceProps {
  data: MonthlyStat[];
  loading?: boolean;
}

export function AreaChartBalance({ data, loading }: AreaChartBalanceProps) {
  if (loading) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Cargando...
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-gray-500">
        Sin datos
      </div>
    );
  }

  const chartData = {
    labels: data.map((d) => {
      const month = d.month.includes('-')
        ? d.month.split('-')[1]
        : d.month;
      return month;
    }),
    datasets: [
      {
        label: 'Balance acumulado',
        data: data.map((d) => d.balance),
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.15)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#2563eb',
        pointBorderColor: '#fff',
        pointRadius: 4,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        padding: 12,
        callbacks: {
          label: (context: any) => {
            const value = context.parsed.y;
            return `Balance: €${value.toLocaleString('es-ES')}`;
          },
        },
      },
    },
    scales: {
      y: {
        ticks: {
          callback: (value: any) => `€${value.toLocaleString('es-ES')}`,
          color: '#6b7280',
        },
        grid: {
          color: 'rgba(0, 0, 0, 0.05)',
        },
      },
      x: {
        ticks: {
          color: '#6b7280',
        },
        grid: {
          display: false,
        },
      },
    },
  };

  return (
    <div className="h-80">
      <Line data={chartData} options={options} />
    </div>
  );
}
```

---

## PARTE 5: STATS CARD MEJORADA

**Archivo:** `components/dashboard/StatsCard.tsx` (REFACTOR)

```typescript
'use client';

import { PercentageChange } from '@/types';

interface StatsCardProps {
  icon: string;
  title: string;
  value: number | string;
  format?: 'currency' | 'number';
  type: 'income' | 'expense' | 'balance' | 'neutral';
  change?: PercentageChange;
  subtitle?: string;
}

export function StatsCard({
  icon,
  title,
  value,
  format = 'currency',
  type,
  change,
  subtitle,
}: StatsCardProps) {
  // Colores por tipo
  const colorClasses = {
    income: 'bg-green-50 border-green-500 text-green-700',
    expense: 'bg-red-50 border-red-500 text-red-700',
    balance: 'bg-blue-50 border-blue-500 text-blue-700',
    neutral: 'bg-gray-50 border-gray-300 text-gray-700',
  };

  const valueColorClasses = {
    income: 'text-green-600',
    expense: 'text-red-600',
    balance: 'text-blue-600',
    neutral: 'text-gray-600',
  };

  // Formatear valor
  const formattedValue =
    format === 'currency'
      ? `€${Number(value).toLocaleString('es-ES', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })}`
      : Number(value).toLocaleString('es-ES');

  // Color de cambio
  const changeColorClass =
    change?.direction === 'up'
      ? 'text-green-600'
      : change?.direction === 'down'
        ? 'text-red-600'
        : 'text-gray-600';

  return (
    <div className={`border-l-4 rounded-lg p-6 ${colorClasses[type]}`}>
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600 mb-2">{title}</p>
          <p className={`text-3xl font-bold ${valueColorClasses[type]}`}>
            {formattedValue}
          </p>

          {change && (
            <div className={`text-sm font-semibold mt-2 ${changeColorClass}`}>
              {change.label}
              {subtitle && <span className="text-gray-500"> vs {subtitle}</span>}
            </div>
          )}
        </div>

        <div className="text-4xl">{icon}</div>
      </div>
    </div>
  );
}
```

---

## PARTE 6: TABLA DE ÚLTIMOS MOVIMIENTOS

**Archivo:** `components/dashboard/RecentMovementsTable.tsx` (CREAR)

```typescript
'use client';

import Link from 'next/link';
import { Movement } from '@/types';
import { formatDate, formatCurrency } from '@/utils/formatters';

interface RecentMovementsTableProps {
  movements: Movement[];
  loading?: boolean;
}

export function RecentMovementsTable({
  movements,
  loading,
}: RecentMovementsTableProps) {
  if (loading) {
    return (
      <div className="p-8 text-center text-gray-500">
        Cargando movimientos...
      </div>
    );
  }

  if (!movements || movements.length === 0) {
    return (
      <div className="p-8 text-center text-gray-500">
        No hay movimientos
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-gray-100">
          <tr className="border-b">
            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
              Fecha
            </th>
            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
              Tipo
            </th>
            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
              Categoría
            </th>
            <th className="px-6 py-3 text-left text-sm font-semibold text-gray-900">
              Descripción
            </th>
            <th className="px-6 py-3 text-right text-sm font-semibold text-gray-900">
              Importe
            </th>
            <th className="px-6 py-3 text-center text-sm font-semibold text-gray-900">
              Acciones
            </th>
          </tr>
        </thead>
        <tbody>
          {movements.map((movement, idx) => (
            <tr
              key={movement.id}
              className={`border-b hover:bg-gray-50 transition ${
                idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
              }`}
            >
              <td className="px-6 py-3 text-sm text-gray-900">
                {formatDate(movement.date)}
              </td>
              <td className="px-6 py-3 text-sm">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold ${
                    movement.type === 'income'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-red-100 text-red-800'
                  }`}
                >
                  {movement.type === 'income' ? 'Ingreso' : 'Gasto'}
                </span>
              </td>
              <td className="px-6 py-3 text-sm text-gray-900">
                {movement.category}
              </td>
              <td className="px-6 py-3 text-sm text-gray-700">
                {movement.description}
              </td>
              <td className="px-6 py-3 text-sm text-right font-semibold text-gray-900">
                <span
                  className={
                    movement.type === 'income'
                      ? 'text-green-600'
                      : 'text-red-600'
                  }
                >
                  {movement.type === 'income' ? '+' : '-'}{' '}
                  {formatCurrency(movement.amount)}
                </span>
              </td>
              <td className="px-6 py-3 text-sm text-center">
                <Link
                  href={`/movements/${movement.id}`}
                  className="text-blue-600 hover:text-blue-800 font-medium"
                >
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="px-6 py-4 border-t text-center">
        <Link
          href="/movements"
          className="text-blue-600 hover:text-blue-800 font-medium text-sm"
        >
          Ver todos los movimientos →
        </Link>
      </div>
    </div>
  );
}
```

---

## PARTE 7: PÁGINA /DASHBOARD COMPLETA

**Archivo:** `app/dashboard/page.tsx` (REFACTOR COMPLETO)

```typescript
'use client';

import { useCompany } from '@/context/CompanyContext';
import { useDashboard } from '@/hooks/useDashboard';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { LineChartIncomeExpense } from '@/components/dashboard/LineChartIncomeExpense';
import { PieChartExpensesByCategory } from '@/components/dashboard/PieChartExpensesByCategory';
import { AreaChartBalance } from '@/components/dashboard/AreaChartBalance';
import { RecentMovementsTable } from '@/components/dashboard/RecentMovementsTable';
import { calculatePercentageChange } from '@/types/dashboard';
import { useState } from 'react';
import Link from 'next/link';

export default function DashboardPage() {
  const { companyId, loading: companyLoading } = useCompany();
  const { summary, byMonth, byCategory, lastMovements, loading, error, refresh } =
    useDashboard();
  const [period, setPeriod] = useState<'month' | '3months' | 'year'>('month');

  if (companyLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-600">Cargando empresa...</p>
        </div>
      </div>
    );
  }

  if (!companyId) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600 font-semibold">No hay empresa seleccionada</p>
      </div>
    );
  }

  // Calcular cambios porcentuales
  const incomeChange =
    summary && summary.previousIncome
      ? calculatePercentageChange(summary.totalIncome, summary.previousIncome)
      : undefined;

  const expenseChange =
    summary && summary.previousExpense
      ? calculatePercentageChange(summary.totalExpense, summary.previousExpense)
      : undefined;

  const balanceChange =
    summary && summary.previousBalance
      ? calculatePercentageChange(summary.balance, summary.previousBalance)
      : undefined;

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4">
        {/* ENCABEZADO */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Dashboard Contable</h1>
          <button
            onClick={() => refresh()}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            ↻ Actualizar
          </button>
        </div>

        {/* SELECTOR DE PERÍODO */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-8 border border-gray-200">
          <label className="block text-sm font-medium text-gray-900 mb-3">
            Período:
          </label>
          <div className="flex gap-4">
            <button
              onClick={() => setPeriod('month')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                period === 'month'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Este mes
            </button>
            <button
              onClick={() => setPeriod('3months')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                period === '3months'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Últimos 3 meses
            </button>
            <button
              onClick={() => setPeriod('year')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                period === 'year'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Este año
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded text-red-700">
            Error cargando datos: {error.message}
          </div>
        )}

        {/* KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <StatsCard
            icon="📈"
            title="Ingresos"
            value={summary?.totalIncome || 0}
            type="income"
            change={incomeChange}
            subtitle="mes anterior"
          />
          <StatsCard
            icon="📉"
            title="Gastos"
            value={summary?.totalExpense || 0}
            type="expense"
            change={expenseChange}
            subtitle="mes anterior"
          />
          <StatsCard
            icon="💰"
            title="Balance"
            value={summary?.balance || 0}
            type="balance"
            change={balanceChange}
            subtitle="mes anterior"
          />
          <StatsCard
            icon="📊"
            title="Movimientos"
            value={summary?.movementCount || 0}
            format="number"
            type="neutral"
          />
        </div>

        {/* GRÁFICOS */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          {/* Línea: Ingresos vs Gastos */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Ingresos vs Gastos (últimos 6 meses)
            </h3>
            <LineChartIncomeExpense data={byMonth} loading={loading} />
          </div>

          {/* Pie: Gastos por categoría */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Gastos por Categoría
            </h3>
            <PieChartExpensesByCategory data={byCategory} loading={loading} />
          </div>
        </div>

        {/* ÁREA: Balance acumulado */}
        <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200 mb-8">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Balance Acumulado (últimos 12 meses)
          </h3>
          <AreaChartBalance data={byMonth} loading={loading} />
        </div>

        {/* ÚLTIMOS MOVIMIENTOS */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 mb-8">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900">
              Últimos 10 Movimientos
            </h3>
          </div>
          <RecentMovementsTable
            movements={lastMovements}
            loading={loading}
          />
        </div>

        {/* ACCIONES RÁPIDAS */}
        <div className="bg-white rounded-lg shadow-sm p-6 border-t-4 border-blue-600">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Acciones Rápidas
          </h3>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/movements/new"
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition"
            >
              + Registrar Movimiento
            </Link>
            <Link
              href="/documents"
              className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 font-medium transition"
            >
              + Subir Documento
            </Link>
            <button
              className="px-6 py-3 bg-orange-600 text-white rounded-lg hover:bg-orange-700 font-medium transition"
              disabled
            >
              📊 Exportar (próximamente)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## CHECKLIST DE INTEGRACIÓN

### Preparación (antes de empezar)

- [ ] `npm install chart.js react-chartjs-2`
- [ ] Semanas 1-2 completadas (CompanyContext, SWR, tipos, servicios)
- [ ] Backend devuelve stats en endpoints correctos

### Crear archivos nuevos

- [ ] `types/dashboard.ts` (tipos + helpers)
- [ ] `hooks/useDashboard.ts` (hooks SWR)
- [ ] `components/dashboard/LineChartIncomeExpense.tsx`
- [ ] `components/dashboard/PieChartExpensesByCategory.tsx`
- [ ] `components/dashboard/AreaChartBalance.tsx`
- [ ] `components/dashboard/RecentMovementsTable.tsx`

### Modificar archivos existentes

- [ ] `components/dashboard/StatsCard.tsx` (refactor con PercentageChange)
- [ ] `app/dashboard/page.tsx` (nueva implementación completa)

### Verificar servicios

- [ ] `services/movements.service.ts` tiene `getSummary()`
- [ ] `services/movements.service.ts` tiene `getByCategory()`
- [ ] `services/movements.service.ts` tiene `getByMonth()`
- [ ] `services/movements.service.ts` tiene `listRecent()`

### Tests manuales

- [ ] Dashboard carga sin errores
- [ ] KPIs muestran valores correctos
- [ ] Gráficos renderizan datos
- [ ] Cambiar período actualiza todo
- [ ] Cambiar empresa actualiza todo
- [ ] Tabla de movimientos muestra últimos 10
- [ ] Responsive: funciona en mobile/tablet

### Deployment

```bash
git add .
git commit -m "feat: Implement professional dashboard with charts (Fase 2.1)

- Dashboard with KPIs, graphs, and recent movements
- Chart.js integration (line, pie, area charts)
- SWR hooks for data fetching and caching
- Responsive TailwindCSS design
- Period selector (month/3months/year)
- Professional accounting UX"

git push origin main
# Vercel auto-deploys
```

---

## RESULTADO FINAL

Al completar Fase 2.1, tendrás:

✅ **Dashboard profesional** que parece una app contable real  
✅ **Gráficos visuales** mostrando tendencias  
✅ **KPIs claros** (ingresos, gastos, balance)  
✅ **Última lista de movimientos** en tabla  
✅ **Acciones rápidas** destacadas  
✅ **Responsive** en todos los dispositivos  
✅ **Caché inteligente** (SWR, sin refetch innecesarios)  
✅ **Listo para usar a diario** como herramienta de trabajo  

**Próximo paso:** Fase 2.2 (Reporting + Export)

