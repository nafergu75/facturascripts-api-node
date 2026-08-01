# APLICACIÓN CONTABLE — CÓDIGO BASE COMPLETO

**Copia y pega estos archivos en tu proyecto Next.js**

---

## 1️⃣ TIPOS Y MODELOS

### `types/accounting.ts`

```typescript
export interface User {
  id: string;
  email: string;
  name: string;
  companyId: string;
  role: 'admin' | 'user' | 'viewer';
}

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

export interface MovementFilter {
  type?: 'income' | 'expense';
  category?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface MovementSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  movementCount: number;
  period: string;
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
  byCategory: Array<{
    category: string;
    income: number;
    expense: number;
    percentage: number;
  }>;
  byMonth: Array<{
    month: string;
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
}
```

### `types/index.ts`

```typescript
export * from './accounting';
```

---

## 2️⃣ SERVICIOS

### `services/api.ts`

```typescript
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'https://conta-api-alpha.vercel.app';

class ApiClient {
  private token: string | null = null;

  constructor() {
    // Cargar token del localStorage si existe
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth_token');
    }
  }

  setToken(token: string) {
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_token', token);
    }
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
    }
  }

  private getHeaders(isFormData = false) {
    const headers: Record<string, string> = {};
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async post<T>(path: string, body?: any, isFormData = false): Promise<T> {
    const options: RequestInit = {
      method: 'POST',
      headers: this.getHeaders(isFormData),
    };
    if (body) {
      options.body = isFormData ? body : JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE_URL}${path}`, options);
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async patch<T>(path: string, body: any): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'PATCH',
      headers: this.getHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }

  async delete<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
}

export const apiClient = new ApiClient();
```

### `services/movements.service.ts`

```typescript
import { apiClient } from './api';
import { Movement, CreateMovementDTO, MovementSummary, MovementFilter } from '@/types';

export const movementsService = {
  async getMovements(companyId: string, filters?: MovementFilter): Promise<Movement[]> {
    const params = new URLSearchParams();
    if (filters?.type) params.append('type', filters.type);
    if (filters?.category) params.append('category', filters.category);
    if (filters?.dateFrom) params.append('dateFrom', filters.dateFrom);
    if (filters?.dateTo) params.append('dateTo', filters.dateTo);
    const query = params.toString() ? `?${params.toString()}` : '';
    return apiClient.get(`/api/companies/${companyId}/movements${query}`);
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

### `services/documents.service.ts`

```typescript
import { apiClient } from './api';
import { Document } from '@/types';

export const documentsService = {
  async getDocuments(companyId: string, filters?: any): Promise<Document[]> {
    const params = new URLSearchParams(filters).toString();
    const query = params ? `?${params}` : '';
    return apiClient.get(`/api/companies/${companyId}/documents${query}`);
  },

  async getDocument(docId: string): Promise<Document> {
    return apiClient.get(`/api/income-reader/${docId}`);
  },

  async uploadDocument(companyId: string, file: File): Promise<Document> {
    const formData = new FormData();
    formData.append('archivo', file);
    return apiClient.post(`/api/income-reader/web-upload`, formData, true);
  },

  async linkMovement(docId: string, movementId: string): Promise<Document> {
    return apiClient.patch(`/api/income-reader/${docId}/link-movement`, { movementId });
  },

  async getStats(companyId: string): Promise<any> {
    return apiClient.get(`/api/companies/${companyId}/stats/documents`);
  },
};
```

### `services/auth.service.ts`

```typescript
import { apiClient } from './api';
import { User } from '@/types';

export const authService = {
  async login(email: string, password: string): Promise<{ token: string; user: User }> {
    const response = await apiClient.post('/api/auth/login', { email, password });
    if (response.token) {
      apiClient.setToken(response.token);
    }
    return response;
  },

  async logout() {
    apiClient.clearToken();
  },

  setToken(token: string) {
    apiClient.setToken(token);
  },
};
```

---

## 3️⃣ HOOKS

### `hooks/useAuth.ts`

```typescript
'use client';

import { useState, useEffect } from 'react';
import { User } from '@/types';
import { authService } from '@/services/auth.service';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
    if (token) {
      authService.setToken(token);
      // Aquí podrías hacer una llamada a /me para obtener usuario actual
      // Por ahora, asumimos que el token es válido
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    try {
      setLoading(true);
      const { token, user } = await authService.login(email, password);
      setUser(user);
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    authService.logout();
    setUser(null);
  };

  return { user, loading, error, login, logout, isAuthenticated: !!user };
}
```

### `hooks/useMovements.ts`

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Movement, MovementSummary, MovementFilter } from '@/types';
import { movementsService } from '@/services/movements.service';

export function useMovements(companyId: string | undefined, filters?: MovementFilter) {
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
          movementsService.getMovements(companyId, filters),
          movementsService.getSummary(companyId),
        ]);
        setMovements(movs);
        setSummary(summ);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [companyId, filters]);

  return { movements, summary, loading, error };
}
```

### `hooks/useDocuments.ts`

```typescript
'use client';

import { useState, useEffect } from 'react';
import { Document } from '@/types';
import { documentsService } from '@/services/documents.service';

export function useDocuments(companyId: string | undefined) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;

    const loadDocuments = async () => {
      try {
        setLoading(true);
        const docs = await documentsService.getDocuments(companyId);
        setDocuments(docs);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error');
      } finally {
        setLoading(false);
      }
    };

    loadDocuments();
  }, [companyId]);

  const uploadDocument = async (file: File) => {
    try {
      const doc = await documentsService.uploadDocument(companyId!, file);
      setDocuments([doc, ...documents]);
      return doc;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      throw err;
    }
  };

  return { documents, loading, error, uploadDocument };
}
```

---

## 4️⃣ COMPONENTES

### `components/common/Header.tsx`

```typescript
'use client';

import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';

export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="bg-white border-b border-gray-200">
      <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <Link href="/dashboard" className="text-xl font-bold text-blue-600">
          💰 Contabilidad
        </Link>
        <nav className="flex gap-6">
          <Link href="/dashboard" className="hover:text-blue-600">
            Dashboard
          </Link>
          <Link href="/movements" className="hover:text-blue-600">
            Movimientos
          </Link>
          <Link href="/documents" className="hover:text-blue-600">
            Documentos
          </Link>
        </nav>
        {user && (
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-600">{user.email}</span>
            <button
              onClick={logout}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
```

### `components/dashboard/StatsCard.tsx`

```typescript
interface StatsCardProps {
  title: string;
  value: string | number;
  trend?: string;
  color: 'green' | 'red' | 'blue' | 'yellow';
}

export function StatsCard({ title, value, trend, color }: StatsCardProps) {
  const colorClasses = {
    green: 'bg-green-50 border-green-500 text-green-600',
    red: 'bg-red-50 border-red-500 text-red-600',
    blue: 'bg-blue-50 border-blue-500 text-blue-600',
    yellow: 'bg-yellow-50 border-yellow-500 text-yellow-600',
  };

  const classes = colorClasses[color];

  return (
    <div className={`border-l-4 ${classes} p-6 rounded-lg shadow-sm`}>
      <p className="text-gray-600 text-sm font-medium">{title}</p>
      <p className="text-3xl font-bold mt-2">{value}</p>
      {trend && <p className="text-xs text-gray-500 mt-2">{trend}</p>}
    </div>
  );
}
```

### `components/movements/MovementsTable.tsx`

```typescript
'use client';

import { Movement } from '@/types';
import Link from 'next/link';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface MovementsTableProps {
  movements: Movement[];
  loading?: boolean;
}

export function MovementsTable({ movements, loading }: MovementsTableProps) {
  if (loading) return <div className="p-8 text-center">Cargando...</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100 border-b">
            <th className="px-4 py-2 text-left text-sm font-semibold">Fecha</th>
            <th className="px-4 py-2 text-left text-sm font-semibold">Tipo</th>
            <th className="px-4 py-2 text-left text-sm font-semibold">Categoría</th>
            <th className="px-4 py-2 text-left text-sm font-semibold">Descripción</th>
            <th className="px-4 py-2 text-right text-sm font-semibold">Importe</th>
            <th className="px-4 py-2 text-center text-sm font-semibold">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr key={m.id} className="border-b hover:bg-gray-50">
              <td className="px-4 py-2 text-sm">{formatDate(m.date)}</td>
              <td className="px-4 py-2 text-sm">
                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                  m.type === 'income' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}>
                  {m.type === 'income' ? 'Ingreso' : 'Gasto'}
                </span>
              </td>
              <td className="px-4 py-2 text-sm">{m.category}</td>
              <td className="px-4 py-2 text-sm">{m.description}</td>
              <td className="px-4 py-2 text-sm text-right font-semibold">
                {m.type === 'income' ? '+' : '-'} {formatCurrency(m.amount)}
              </td>
              <td className="px-4 py-2 text-center">
                <Link href={`/movements/${m.id}`} className="text-blue-600 hover:underline text-xs">
                  Ver
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### `components/movements/MovementForm.tsx`

```typescript
'use client';

import { useState } from 'react';
import { CreateMovementDTO } from '@/types';
import { movementsService } from '@/services/movements.service';

interface MovementFormProps {
  companyId: string;
  onSuccess?: () => void;
}

export function MovementForm({ companyId, onSuccess }: MovementFormProps) {
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState<CreateMovementDTO>({
    type: 'expense',
    amount: 0,
    category: '',
    description: '',
    date: new Date().toISOString().split('T')[0],
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setLoading(true);
      await movementsService.createMovement(companyId, form);
      setForm({
        type: 'expense',
        amount: 0,
        category: '',
        description: '',
        date: new Date().toISOString().split('T')[0],
      });
      onSuccess?.();
    } catch (error) {
      console.error('Error:', error);
      alert('Error creando movimiento');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-white p-6 rounded-lg shadow-sm">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-2">Tipo</label>
          <select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as any })}
            className="w-full border border-gray-300 rounded px-3 py-2"
          >
            <option value="income">Ingreso</option>
            <option value="expense">Gasto</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Importe (€)</label>
          <input
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: parseFloat(e.target.value) })}
            className="w-full border border-gray-300 rounded px-3 py-2"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Categoría</label>
          <input
            type="text"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2"
            required
            placeholder="ej: Ventas, Suministros"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Fecha</label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2"
            required
          />
        </div>

        <div className="md:col-span-2">
          <label className="block text-sm font-medium mb-2">Descripción</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full border border-gray-300 rounded px-3 py-2"
            rows={3}
            required
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={loading}
        className="mt-6 px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? 'Guardando...' : 'Guardar Movimiento'}
      </button>
    </form>
  );
}
```

---

## 5️⃣ UTILIDADES

### `utils/formatters.ts`

```typescript
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount);
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat('es-ES').format(new Date(date + 'T00:00:00'));
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
```

---

## 6️⃣ PÁGINAS

### `app/layout.tsx`

```typescript
import type { Metadata } from 'next';
import { Header } from '@/components/common/Header';
import './globals.css';

export const metadata: Metadata = {
  title: 'Aplicación Contable',
  description: 'Gestiona tu contabilidad profesional',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className="bg-gray-50">
        <Header />
        <main className="max-w-7xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
```

### `app/page.tsx`

```typescript
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/dashboard');
}
```

### `app/dashboard/page.tsx`

```typescript
'use client';

import { useAuth } from '@/hooks/useAuth';
import { useMovements } from '@/hooks/useMovements';
import { useDocuments } from '@/hooks/useDocuments';
import { StatsCard } from '@/components/dashboard/StatsCard';
import { formatCurrency } from '@/utils/formatters';

export default function DashboardPage() {
  const { user, loading: authLoading } = useAuth();
  const { summary, loading: movLoading } = useMovements(user?.companyId);
  const { documents, loading: docLoading } = useDocuments(user?.companyId);

  if (authLoading || movLoading) {
    return <div className="p-8 text-center">Cargando...</div>;
  }

  const processingDocs = documents.filter((d) => d.incomeReaderState === 'PROCESSING').length;
  const rejectedDocs = documents.filter((d) => d.incomeReaderState === 'REJECTED').length;

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard Contable</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <StatsCard
          title="Ingresos"
          value={formatCurrency(summary?.totalIncome || 0)}
          color="green"
        />
        <StatsCard
          title="Gastos"
          value={formatCurrency(summary?.totalExpense || 0)}
          color="red"
        />
        <StatsCard
          title="Balance"
          value={formatCurrency(summary?.balance || 0)}
          color={summary?.balance ?? 0 >= 0 ? 'green' : 'red'}
        />
        <StatsCard
          title="Movimientos"
          value={summary?.movementCount || 0}
          color="blue"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatsCard
          title="Documentos"
          value={documents.length}
          color="blue"
        />
        <StatsCard
          title="En proceso"
          value={processingDocs}
          color="yellow"
        />
        <StatsCard
          title="Rechazados"
          value={rejectedDocs}
          color="red"
        />
      </div>
    </div>
  );
}
```

### `app/movements/page.tsx`

```typescript
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { useMovements } from '@/hooks/useMovements';
import { MovementsTable } from '@/components/movements/MovementsTable';
import { Movement } from '@/types';

export default function MovementsPage() {
  const { user } = useAuth();
  const { movements, loading } = useMovements(user?.companyId);
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');

  const filtered = movements.filter((m: Movement) => {
    if (typeFilter === 'all') return true;
    return m.type === typeFilter;
  });

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Movimientos</h1>
        <Link href="/movements/new" className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
          + Nuevo Movimiento
        </Link>
      </div>

      <div className="mb-6 flex gap-4">
        <button
          onClick={() => setTypeFilter('all')}
          className={`px-4 py-2 rounded ${typeFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-200'}`}
        >
          Todos
        </button>
        <button
          onClick={() => setTypeFilter('income')}
          className={`px-4 py-2 rounded ${typeFilter === 'income' ? 'bg-green-600 text-white' : 'bg-gray-200'}`}
        >
          Ingresos
        </button>
        <button
          onClick={() => setTypeFilter('expense')}
          className={`px-4 py-2 rounded ${typeFilter === 'expense' ? 'bg-red-600 text-white' : 'bg-gray-200'}`}
        >
          Gastos
        </button>
      </div>

      <MovementsTable movements={filtered} loading={loading} />
    </div>
  );
}
```

### `app/movements/new/page.tsx`

```typescript
'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { MovementForm } from '@/components/movements/MovementForm';

export default function NewMovementPage() {
  const router = useRouter();
  const { user } = useAuth();

  if (!user) {
    return <div className="p-8">No autorizado</div>;
  }

  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold mb-8">Nuevo Movimiento</h1>
      <MovementForm
        companyId={user.companyId}
        onSuccess={() => router.push('/movements')}
      />
    </div>
  );
}
```

---

## 7️⃣ CONFIGURACIÓN

### `package.json`

```json
{
  "name": "frontend-contable",
  "version": "1.0.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "^14.0.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "chart.js": "^4.4.0",
    "react-chartjs-2": "^5.2.0",
    "date-fns": "^2.30.0"
  },
  "devDependencies": {
    "@types/node": "^20",
    "@types/react": "^18",
    "@types/react-dom": "^18",
    "typescript": "^5",
    "tailwindcss": "^3.3.0",
    "postcss": "^8",
    "autoprefixer": "^10.4.14"
  }
}
```

### `.env.local`

```bash
NEXT_PUBLIC_API_URL=https://conta-api-alpha.vercel.app
NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000
```

### `tailwind.config.ts`

```typescript
import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

export default config
```

---

**¡LISTO PARA USAR!** 🚀

Copia estos archivos a tu proyecto Next.js y tendrás una aplicación contable funcional.

