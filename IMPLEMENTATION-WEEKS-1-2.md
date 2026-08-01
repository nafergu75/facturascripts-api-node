# IMPLEMENTACIÓN SEMANAS 1-2: CÓDIGO REAL Y LISTO

**Guía concreta para implementar validación, errores, contexto, logging, paginación, caché y optimism**

---

## RESUMEN ESTRATEGIA

**Objetivo:** Dar base técnica sólida a la app en 2 semanas sin romper nada.

**Enfoque:**
1. Backend primero: validación (Zod) + errores custom + logging (Winston) + paginación
2. Frontend después: contexto (React Context) + validación Zod + error boundary + caché (SWR)
3. Sin breaking changes: código nuevo en archivos separados, refactor gradual

**Dependencias:** 
- Backend: `zod`, `winston`, `express-rate-limit`
- Frontend: `zod`, `swr`

**Total código:** ~80-100 líneas backend + ~120-150 líneas frontend (nuevos archivos)

---

## ISSUE 1.1: ZOD VALIDATION (BACKEND)

### Paso 1: Instalar Zod

```bash
cd /path/to/conta-api
npm install zod
```

### Paso 2: Crear archivo de schemas

**Archivo:** `src/validators/movements.ts`

```typescript
import { z } from 'zod';

// Enum para tipos
const MovementType = z.enum(['income', 'expense']);

// Schema para crear movimiento
export const createMovementSchema = z.object({
  type: MovementType,
  amount: z.coerce
    .number()
    .positive('El importe debe ser mayor a 0')
    .max(999999999.99, 'Importe muy grande'),
  category: z.string()
    .min(2, 'La categoría debe tener al menos 2 caracteres')
    .max(50, 'Máximo 50 caracteres')
    .trim(),
  description: z.string()
    .min(5, 'Descripción mínimo 5 caracteres')
    .max(500, 'Máximo 500 caracteres')
    .trim(),
  date: z.string()
    .refine(
      (dateStr) => {
        const date = new Date(dateStr);
        return date <= new Date() && !isNaN(date.getTime());
      },
      'Fecha inválida o en el futuro'
    ),
  referenceDocument: z.string().optional(),
});

// Schema para actualizar movimiento (todos los campos opcionales)
export const updateMovementSchema = createMovementSchema.partial();

// Tipos derivados de schemas
export type CreateMovement = z.infer<typeof createMovementSchema>;
export type UpdateMovement = z.infer<typeof updateMovementSchema>;

// Función helper para validar
export function validateMovement(data: unknown, schema: z.ZodSchema) {
  try {
    return { data: schema.parse(data), error: null };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { data: null, error: error.errors };
    }
    throw error;
  }
}
```

### Paso 3: Middleware genérico de validación

**Archivo:** `src/middleware/validateRequest.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Middleware factory para validar request body con Zod
 * @param schema Zod schema a usar
 * @returns Middleware Express
 */
export function validateRequest(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const validated = schema.parse(req.body);
      req.body = validated;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(400).json({
          error: 'Validation failed',
          details: error.errors.map((err) => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      next(error);
    }
  };
}
```

### Paso 4: Aplicar a rutas de movimientos

**Archivo:** `src/routes/movements.routes.ts` (MODIFICAR EXISTENTE)

```typescript
import { Router } from 'express';
import { validateRequest } from '../middleware/validateRequest';
import { createMovementSchema, updateMovementSchema } from '../validators/movements';
import * as movementsController from '../controllers/movements.controller';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Proteger todas las rutas
router.use(authMiddleware);

// POST: crear movimiento (CON VALIDACIÓN)
router.post(
  '/',
  validateRequest(createMovementSchema),
  movementsController.createMovement
);

// GET: listar movimientos
router.get('/', movementsController.getMovements);

// GET: movimiento por ID
router.get('/:id', movementsController.getMovement);

// PATCH: actualizar movimiento (CON VALIDACIÓN)
router.patch(
  '/:id',
  validateRequest(updateMovementSchema),
  movementsController.updateMovement
);

// DELETE: eliminar movimiento
router.delete('/:id', movementsController.deleteMovement);

export default router;
```

### Paso 5: Actualizar controlador

**Archivo:** `src/controllers/movements.controller.ts` (MODIFICAR EXISTENTE)

```typescript
import { Request, Response, NextFunction } from 'express';
import { CreateMovement, UpdateMovement } from '../validators/movements';
import * as movementsService from '../services/movements.service';

export async function createMovement(
  req: Request<{ companyId: string }, {}, CreateMovement>,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = req.params;
    const data = req.body; // Ya validado por middleware
    
    const movement = await movementsService.createMovement(companyId, data);
    return res.status(201).json(movement);
  } catch (error) {
    next(error); // Pasar a error middleware
  }
}

// updateMovement similar...
export async function updateMovement(
  req: Request<{ companyId: string; id: string }, {}, UpdateMovement>,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId, id } = req.params;
    const data = req.body;
    
    const movement = await movementsService.updateMovement(companyId, id, data);
    return res.status(200).json(movement);
  } catch (error) {
    next(error);
  }
}

// getMovements, getMovement, deleteMovement sin cambios significativos
```

### Paso 6: Test

```bash
# 1. Terminal: npm run dev

# 2. Test POST /movements con datos inválidos
curl -X POST http://localhost:3000/api/companies/company-1/movements \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT" \
  -d '{
    "type": "income",
    "amount": -100,
    "category": "X",
    "description": "Test"
  }'

# Esperado:
# {
#   "error": "Validation failed",
#   "details": [
#     { "field": "amount", "message": "El importe debe ser mayor a 0" },
#     { "field": "category", "message": "La categoría debe tener al menos 2 caracteres" }
#   ]
# }
```

### Checklist Backend Zod
- [ ] Archivo `/src/validators/movements.ts` creado
- [ ] Archivo `/src/middleware/validateRequest.ts` creado
- [ ] Rutas `/movements` usan middleware validateRequest
- [ ] POST con datos inválidos retorna 400 con errores por campo
- [ ] POST con datos válidos retorna 201
- [ ] Tipos TypeScript disponibles (CreateMovement, UpdateMovement)

---

## ISSUE 1.1: ZOD VALIDATION (FRONTEND)

### Paso 1: Instalar Zod

```bash
cd /path/to/frontend-contable
npm install zod
```

### Paso 2: Crear schemas para formularios

**Archivo:** `types/schemas.ts`

```typescript
import { z } from 'zod';

// Reutilizar los mismos schemas que backend (o crear nuevos aquí)
export const createMovementFormSchema = z.object({
  type: z.enum(['income', 'expense'], {
    errorMap: () => ({ message: 'Selecciona ingreso o gasto' }),
  }),
  amount: z.coerce
    .number()
    .positive('El importe debe ser mayor a 0'),
  category: z.string()
    .min(2, 'Mínimo 2 caracteres')
    .max(50, 'Máximo 50 caracteres'),
  description: z.string()
    .min(5, 'Mínimo 5 caracteres')
    .max(500, 'Máximo 500 caracteres'),
  date: z.string()
    .refine((d) => new Date(d) <= new Date(), 'No puede ser fecha futura'),
  referenceDocument: z.string().optional(),
});

export type CreateMovementForm = z.infer<typeof createMovementFormSchema>;
```

### Paso 3: Hook para validación de formulario

**Archivo:** `hooks/useMovementForm.ts`

```typescript
'use client';

import { useState, useCallback } from 'react';
import { z } from 'zod';
import { createMovementFormSchema, CreateMovementForm } from '@/types/schemas';
import { movementsService } from '@/services/movements.service';

interface FieldErrors {
  [key: string]: string;
}

export function useMovementForm(onSuccess?: () => void) {
  const [form, setForm] = useState<CreateMovementForm>({
    type: 'expense',
    amount: 0,
    category: '',
    description: '',
    date: new Date().toISOString().split('T')[0],
  });

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [isLoading, setIsLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const handleChange = useCallback(
    (field: keyof CreateMovementForm, value: any) => {
      setForm((prev) => ({ ...prev, [field]: value }));
      // Limpiar error de ese campo al editar
      setFieldErrors((prev) => ({ ...prev, [field]: '' }));
    },
    []
  );

  const handleSubmit = useCallback(async () => {
    setGlobalError(null);
    setFieldErrors({});
    setIsLoading(true);

    try {
      // Validar con Zod
      const validated = createMovementFormSchema.parse(form);
      
      // Enviar al backend
      await movementsService.create(validated);
      
      // Reset formulario
      setForm({
        type: 'expense',
        amount: 0,
        category: '',
        description: '',
        date: new Date().toISOString().split('T')[0],
      });
      
      setGlobalError(null);
      onSuccess?.();
      return true;
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Mapear errores por campo
        const errors: FieldErrors = {};
        error.errors.forEach((err) => {
          const field = err.path[0];
          if (field) {
            errors[field] = err.message;
          }
        });
        setFieldErrors(errors);
      } else if (error instanceof Error) {
        setGlobalError(error.message);
      } else {
        setGlobalError('Error al guardar. Intenta de nuevo.');
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [form, onSuccess]);

  return {
    form,
    fieldErrors,
    globalError,
    isLoading,
    handleChange,
    handleSubmit,
  };
}
```

### Paso 4: Actualizar componente MovementForm

**Archivo:** `components/movements/MovementForm.tsx` (REFACTOR)

```typescript
'use client';

import { useMovementForm } from '@/hooks/useMovementForm';

interface MovementFormProps {
  onSuccess?: () => void;
}

export function MovementForm({ onSuccess }: MovementFormProps) {
  const { form, fieldErrors, globalError, isLoading, handleChange, handleSubmit } =
    useMovementForm(onSuccess);

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleSubmit();
  };

  return (
    <form onSubmit={handleFormSubmit} className="bg-white p-8 rounded-lg shadow-sm">
      {globalError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {globalError}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Tipo */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Tipo *
          </label>
          <select
            value={form.type}
            onChange={(e) => handleChange('type', e.target.value)}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              fieldErrors.type ? 'border-red-500' : 'border-gray-300'
            }`}
          >
            <option value="income">Ingreso</option>
            <option value="expense">Gasto</option>
          </select>
          {fieldErrors.type && (
            <p className="text-red-600 text-xs mt-1">{fieldErrors.type}</p>
          )}
        </div>

        {/* Importe */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Importe (€) *
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.amount}
            onChange={(e) => handleChange('amount', e.target.value)}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              fieldErrors.amount ? 'border-red-500' : 'border-gray-300'
            }`}
          />
          {fieldErrors.amount && (
            <p className="text-red-600 text-xs mt-1">{fieldErrors.amount}</p>
          )}
        </div>

        {/* Categoría */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Categoría *
          </label>
          <select
            value={form.category}
            onChange={(e) => handleChange('category', e.target.value)}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              fieldErrors.category ? 'border-red-500' : 'border-gray-300'
            }`}
          >
            <option value="">Selecciona categoría</option>
            <option value="Ventas">Ventas</option>
            <option value="Servicios">Servicios</option>
            <option value="Asesoramiento">Asesoramiento</option>
            <option value="Suministros">Suministros</option>
            <option value="Alquiler">Alquiler</option>
            <option value="Electricidad">Electricidad</option>
            <option value="Teléfono">Teléfono</option>
            <option value="Salarios">Salarios</option>
            <option value="Otros">Otros</option>
          </select>
          {fieldErrors.category && (
            <p className="text-red-600 text-xs mt-1">{fieldErrors.category}</p>
          )}
        </div>

        {/* Fecha */}
        <div>
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Fecha *
          </label>
          <input
            type="date"
            value={form.date}
            onChange={(e) => handleChange('date', e.target.value)}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              fieldErrors.date ? 'border-red-500' : 'border-gray-300'
            }`}
          />
          {fieldErrors.date && (
            <p className="text-red-600 text-xs mt-1">{fieldErrors.date}</p>
          )}
        </div>

        {/* Descripción */}
        <div className="md:col-span-2">
          <label className="block text-sm font-medium text-gray-900 mb-2">
            Descripción *
          </label>
          <textarea
            value={form.description}
            onChange={(e) => handleChange('description', e.target.value)}
            className={`w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              fieldErrors.description ? 'border-red-500' : 'border-gray-300'
            }`}
            rows={4}
            placeholder="Describe el movimiento"
          />
          {fieldErrors.description && (
            <p className="text-red-600 text-xs mt-1">{fieldErrors.description}</p>
          )}
        </div>
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        {isLoading ? 'Guardando...' : 'Guardar Movimiento'}
      </button>
    </form>
  );
}
```

### Checklist Frontend Zod
- [ ] `npm install zod`
- [ ] Archivo `types/schemas.ts` creado con schemas Zod
- [ ] Hook `hooks/useMovementForm.ts` creado
- [ ] Componente `MovementForm.tsx` refactorizado para usar hook
- [ ] Errores se muestran por campo en rojo
- [ ] Validación antes de enviar al backend
- [ ] Mensaje global de error si falla

---

## ISSUE 1.5: CUSTOM ERRORS (BACKEND)

### Paso 1: Crear clases de error

**Archivo:** `src/errors/AppError.ts`

```typescript
/**
 * Error base de la aplicación
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Error de validación (400)
 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
  }
}

/**
 * Recurso no encontrado (404)
 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const msg = id ? `${resource} "${id}" not found` : `${resource} not found`;
    super(404, msg, 'NOT_FOUND');
  }
}

/**
 * No autorizado (401)
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

/**
 * Prohibido (403)
 */
export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

/**
 * Conflicto (409)
 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

/**
 * Error interno (500)
 */
export class InternalServerError extends AppError {
  constructor(message: string = 'Internal server error') {
    super(500, message, 'INTERNAL_SERVER_ERROR');
  }
}
```

### Paso 2: Middleware de error global

**Archivo:** `src/middleware/errorHandler.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import { AppError, InternalServerError } from '../errors/AppError';
import { logger } from '../logger'; // Ver ISSUE 1.6

/**
 * Middleware de manejo de errores global
 * IMPORTANTE: Debe ser el ÚLTIMO middleware
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Si es AppError, responder con statusCode especificado
  if (error instanceof AppError) {
    logger.warn(`${error.code}: ${error.message}`, {
      method: req.method,
      path: req.path,
      userId: (req as any).user?.id,
      code: error.code,
    });

    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
    });
  }

  // Si es ZodError, ya está manejado en validateRequest middleware
  // Si llegamos aquí, es error inesperado
  logger.error('Unexpected error', {
    method: req.method,
    path: req.path,
    userId: (req as any).user?.id,
    error: error.message,
    stack: error.stack,
  });

  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
  });
}
```

### Paso 3: Aplicar errores en servicio de movimientos

**Archivo:** `src/services/movements.service.ts` (MODIFICAR EXISTENTE)

```typescript
import { prisma } from '../lib/prisma'; // Ajusta import según tu proyecto
import { CreateMovement, UpdateMovement } from '../validators/movements';
import { NotFoundError } from '../errors/AppError';
import { logger } from '../logger';

export async function createMovement(
  companyId: string,
  data: CreateMovement
) {
  // Verificar que la empresa existe
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company) {
    throw new NotFoundError('Company', companyId);
  }

  // Crear movimiento
  const movement = await prisma.movement.create({
    data: {
      companyId,
      type: data.type,
      amount: data.amount,
      category: data.category,
      description: data.description,
      date: new Date(data.date),
      referenceDocument: data.referenceDocument,
      fiscalYear: new Date(data.date).getFullYear(),
      status: 'draft',
    },
  });

  logger.info('Movement created', {
    movementId: movement.id,
    companyId,
    amount: movement.amount,
    type: movement.type,
  });

  return movement;
}

export async function getMovement(
  companyId: string,
  id: string
) {
  const movement = await prisma.movement.findFirst({
    where: {
      id,
      companyId,
    },
  });

  if (!movement) {
    throw new NotFoundError('Movement', id);
  }

  return movement;
}

export async function updateMovement(
  companyId: string,
  id: string,
  data: UpdateMovement
) {
  // Verificar que existe el movimiento
  await getMovement(companyId, id);

  const movement = await prisma.movement.update({
    where: { id },
    data: {
      type: data.type,
      amount: data.amount,
      category: data.category,
      description: data.description,
      date: data.date ? new Date(data.date) : undefined,
      referenceDocument: data.referenceDocument,
    },
  });

  logger.info('Movement updated', {
    movementId: id,
    companyId,
  });

  return movement;
}

export async function deleteMovement(
  companyId: string,
  id: string
) {
  // Verificar que existe
  await getMovement(companyId, id);

  await prisma.movement.delete({
    where: { id },
  });

  logger.info('Movement deleted', {
    movementId: id,
    companyId,
  });
}
```

### Paso 4: Registrar middleware en app.ts

**Archivo:** `src/app.ts` (MODIFICAR EXISTENTE)

```typescript
import express from 'express';
import { errorHandler } from './middleware/errorHandler';
import movementsRouter from './routes/movements.routes';

const app = express();

// Middlewares
app.use(express.json());
// ... otros middlewares

// Rutas
app.use('/api/companies/:companyId/movements', movementsRouter);
// ... otras rutas

// ERROR HANDLER DEBE SER ÚLTIMO
app.use(errorHandler);

export default app;
```

### Checklist Backend Errors
- [ ] Archivo `src/errors/AppError.ts` creado
- [ ] Archivo `src/middleware/errorHandler.ts` creado
- [ ] ErrorHandler registrado en `app.ts` (ÚLTIMO)
- [ ] Service lanza `NotFoundError` cuando no encuentra recursos
- [ ] GET /movements/:invalid → 404 con mensaje claro
- [ ] POST inválido → 400 (validación) ó 404 (recurso)
- [ ] Logs estructurados en cada error

---

## ISSUE 1.2: COMPANYCONTEXT (FRONTEND)

### Paso 1: Crear contexto

**Archivo:** `context/CompanyContext.tsx`

```typescript
'use client';

import { createContext, useContext, useState, ReactNode, useEffect } from 'react';

interface CompanyContextType {
  companyId: string | null;
  setCompanyId: (id: string) => void;
  loading: boolean;
}

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [companyId, setCompanyIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Recuperar companyId de localStorage en mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('selectedCompanyId');
      setCompanyIdState(saved);
    }
    setLoading(false);
  }, []);

  const setCompanyId = (id: string) => {
    setCompanyIdState(id);
    if (typeof window !== 'undefined') {
      localStorage.setItem('selectedCompanyId', id);
    }
  };

  return (
    <CompanyContext.Provider value={{ companyId, setCompanyId, loading }}>
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (!context) {
    throw new Error('useCompany debe estar dentro de CompanyProvider');
  }
  return context;
}
```

### Paso 2: Envolver app en provider

**Archivo:** `app/layout.tsx` (MODIFICAR EXISTENTE)

```typescript
import { CompanyProvider } from '@/context/CompanyContext';
import { Header } from '@/components/common/Header';
import './styles.css';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className="bg-gray-50 font-sans">
        <CompanyProvider>
          <Header />
          <main className="max-w-7xl mx-auto px-4 py-8">
            {children}
          </main>
        </CompanyProvider>
      </body>
    </html>
  );
}
```

### Paso 3: Agregar selector en Header

**Archivo:** `components/common/Header.tsx` (MODIFICAR EXISTENTE)

```typescript
'use client';

import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { useCompany } from '@/context/CompanyContext';
import { useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';

interface Company {
  id: string;
  name: string;
}

export function Header() {
  const { user, logout } = useAuth();
  const { companyId, setCompanyId } = useCompany();
  const router = useRouter();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);

  // Cargar empresas (mock por ahora, después será un endpoint)
  useEffect(() => {
    if (user) {
      setLoading(true);
      // TODO: fetch /api/user/companies
      const mockCompanies: Company[] = [
        { id: 'company-1', name: 'Mi Empresa SL' },
        { id: 'company-2', name: 'Empresa 2 SA' },
      ];
      setCompanies(mockCompanies);
      
      // Si no hay empresa seleccionada, seleccionar la primera
      if (!companyId && mockCompanies.length > 0) {
        setCompanyId(mockCompanies[0].id);
      }
      setLoading(false);
    }
  }, [user, companyId, setCompanyId]);

  const handleLogout = async () => {
    logout();
    router.push('/login');
  };

  const handleCompanyChange = (id: string) => {
    setCompanyId(id);
    // Refrescar página para que todo se actualice
    router.refresh();
  };

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <Link href="/dashboard" className="text-2xl font-bold text-blue-600 flex items-center gap-2">
          💰 Contabilidad
        </Link>

        <nav className="flex gap-6 flex-1 justify-center">
          <Link href="/dashboard" className="text-gray-700 hover:text-blue-600 font-medium">
            Dashboard
          </Link>
          <Link href="/movements" className="text-gray-700 hover:text-blue-600 font-medium">
            Movimientos
          </Link>
          <Link href="/documents" className="text-gray-700 hover:text-blue-600 font-medium">
            Documentos
          </Link>
        </nav>

        <div className="flex items-center gap-4">
          {/* Selector de empresa */}
          {!loading && companies.length > 0 && (
            <select
              value={companyId || ''}
              onChange={(e) => handleCompanyChange(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded text-sm font-medium"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          )}

          {user && (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm font-medium text-gray-900">{user.name}</p>
                <p className="text-xs text-gray-500">{user.email}</p>
              </div>
              <button
                onClick={handleLogout}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 font-medium"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
```

### Paso 4: Refactorizar hooks para usar contexto

**Archivo:** `hooks/useMovements.ts` (REFACTOR)

```typescript
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Movement, MovementSummary, MovementFilter } from '@/types';
import { movementsService } from '@/services/movements.service';
import { useCompany } from '@/context/CompanyContext';

export function useMovements(filters?: MovementFilter, options: { autoLoad?: boolean } = {}) {
  const { autoLoad = true } = options;
  const { companyId } = useCompany(); // Obtener del contexto
  
  const [movements, setMovements] = useState<Movement[]>([]);
  const [summary, setSummary] = useState<MovementSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!companyId) return; // Sin empresa, no cargar

    try {
      setLoading(true);
      const [movs, summ] = await Promise.all([
        movementsService.list(companyId, filters),
        movementsService.getSummary(companyId),
      ]);
      setMovements(movs);
      setSummary(summ);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading');
    } finally {
      setLoading(false);
    }
  }, [companyId, filters]);

  useEffect(() => {
    if (autoLoad) {
      load();
    }
  }, [load, autoLoad]);

  // ... resto del hook igual
  
  return { movements, summary, loading, error, load };
}
```

### Checklist Frontend CompanyContext
- [ ] Archivo `context/CompanyContext.tsx` creado
- [ ] Provider envuelve app en `layout.tsx`
- [ ] Selector de empresa en Header
- [ ] Hooks usan `useCompany()` en lugar de recibir companyId por props
- [ ] Al cambiar empresa, dashboard se actualiza
- [ ] Empresa persiste en localStorage

---

## ISSUE 1.3: ERROR BOUNDARY (FRONTEND)

### Paso 1: Crear Error Boundary

**Archivo:** `app/error.tsx`

```typescript
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
    // Log error a servicio externo si existe (Sentry, etc.)
    console.error('[Frontend Error]', {
      message: error.message,
      stack: error.stack,
      digest: error.digest,
      timestamp: new Date().toISOString(),
    });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-red-50 px-4">
      <div className="max-w-md w-full text-center">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-3xl font-bold text-red-600 mb-4">
          Oops! Algo salió mal
        </h1>
        <p className="text-gray-600 mb-2">
          Ha ocurrido un error inesperado.
        </p>
        <p className="text-sm text-gray-500 mb-6">
          {error.message || 'Intenta de nuevo más tarde o contacta soporte.'}
        </p>

        <div className="flex gap-4 justify-center">
          <button
            onClick={reset}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
          >
            Intentar de Nuevo
          </button>
          <a
            href="/dashboard"
            className="px-6 py-3 bg-gray-200 text-gray-900 rounded-lg hover:bg-gray-300 font-medium"
          >
            Ir a Dashboard
          </a>
        </div>

        {process.env.NODE_ENV === 'development' && (
          <div className="mt-8 p-4 bg-gray-100 rounded text-left text-xs font-mono text-gray-700 overflow-auto max-h-48">
            <p className="font-bold mb-2">Detalles (desarrollo):</p>
            <pre>{error.stack}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
```

### Paso 2: Crear componente para loading

**Archivo:** `app/loading.tsx`

```typescript
export default function Loading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-gray-600 font-medium">Cargando...</p>
      </div>
    </div>
  );
}
```

### Paso 3: Envolver componentes con Suspense (donde sea necesario)

**Archivo:** `app/dashboard/page.tsx` (EJEMPLO)

```typescript
'use client';

import { Suspense } from 'react';
import { DashboardContent } from '@/components/dashboard/DashboardContent';
import Loading from '../loading';

export default function DashboardPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DashboardContent />
    </Suspense>
  );
}
```

### Paso 4: Mejorar manejo de errores en servicios

**Archivo:** `services/api.ts` (ACTUALIZAR)

```typescript
class ApiClient {
  private token: string | null = null;

  async get<T>(path: string): Promise<T> {
    try {
      const response = await fetch(`${API_URL}${path}`, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        
        // Manejo específico de errores HTTP
        if (response.status === 401) {
          throw new Error('No autorizado. Inicia sesión nuevamente.');
        }
        if (response.status === 403) {
          throw new Error('No tienes permiso para esta acción.');
        }
        if (response.status === 404) {
          throw new Error('Recurso no encontrado.');
        }
        if (response.status >= 500) {
          throw new Error('Error del servidor. Intenta más tarde.');
        }
        
        throw new Error(error.error || `API Error ${response.status}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Request failed: ${error.message}`);
      }
      throw new Error('Unknown error');
    }
  }

  // get, post, etc. similar...
}
```

### Checklist Frontend Error Boundary
- [ ] Archivo `app/error.tsx` creado
- [ ] Archivo `app/loading.tsx` creado
- [ ] Error Boundary captura crashes de componentes
- [ ] Loading state muestra esqueleto
- [ ] Errores HTTP muestran mensajes claros
- [ ] Botón "Intentar de nuevo" funciona
- [ ] Development: mostrar stack trace
- [ ] Production: no mostrar detalles técnicos

---

## ISSUE 1.4: PAGINACIÓN (BACKEND)

### Paso 1: Actualizar service

**Archivo:** `src/services/movements.service.ts` (AGREGAR)

```typescript
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export async function getMovements(
  companyId: string,
  filters?: MovementFilter & { page?: number; pageSize?: number }
) {
  const page = Math.max(filters?.page || 1, 1);
  const pageSize = Math.min(filters?.pageSize || 50, 500); // Max 500
  const skip = (page - 1) * pageSize;

  // Construir filtro
  const where: any = { companyId };
  if (filters?.type) where.type = filters.type;
  if (filters?.category) where.category = filters.category;
  if (filters?.dateFrom || filters?.dateTo) {
    where.date = {};
    if (filters?.dateFrom) where.date.gte = new Date(filters.dateFrom);
    if (filters?.dateTo) where.date.lte = new Date(filters.dateTo);
  }

  // Ejecutar ambas queries en paralelo
  const [movements, total] = await Promise.all([
    prisma.movement.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      skip,
      take: pageSize,
    }),
    prisma.movement.count({ where }),
  ]);

  return {
    data: movements,
    total,
    page,
    pageSize,
    hasMore: skip + movements.length < total,
  };
}
```

### Paso 2: Actualizar controller

**Archivo:** `src/controllers/movements.controller.ts` (AGREGAR)

```typescript
export async function getMovements(
  req: Request<{ companyId: string }, {}, {}, any>,
  res: Response,
  next: NextFunction
) {
  try {
    const { companyId } = req.params;
    const { type, category, dateFrom, dateTo, page, pageSize } = req.query;

    const result = await movementsService.getMovements(companyId, {
      type: type as 'income' | 'expense' | undefined,
      category: category as string | undefined,
      dateFrom: dateFrom as string | undefined,
      dateTo: dateTo as string | undefined,
      page: page ? parseInt(page as string) : 1,
      pageSize: pageSize ? parseInt(pageSize as string) : 50,
    });

    return res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}
```

### Test

```bash
# Test paginación
curl "http://localhost:3000/api/companies/company-1/movements?page=1&pageSize=10" \
  -H "Authorization: Bearer JWT"

# Esperado:
# {
#   "data": [...10 items],
#   "total": 47,
#   "page": 1,
#   "pageSize": 10,
#   "hasMore": true
# }
```

### Checklist Backend Paginación
- [ ] Service retorna `PaginatedResponse<Movement>`
- [ ] Parámetros `page` y `pageSize` soportados
- [ ] `pageSize` limitado a max 500
- [ ] Response incluye `hasMore` para UI
- [ ] Orden: date DESC
- [ ] Tests: page=2, pageSize=25 retorna 25 items

---

## ISSUE 1.6: WINSTON LOGGER (BACKEND)

### Paso 1: Instalar Winston

```bash
npm install winston
```

### Paso 2: Crear logger

**Archivo:** `src/logger.ts`

```typescript
import winston from 'winston';
import path from 'path';

// Definir niveles personalizados (opcional)
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Crear logger
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'conta-api' },
  transports: [
    // Errores a archivo separado
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Todos los logs a archivo combined
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 5242880,
      maxFiles: 5,
    }),
    // Console en desarrollo
    ...(process.env.NODE_ENV !== 'production'
      ? [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize(),
              winston.format.simple()
            ),
          }),
        ]
      : []),
  ],
});

// Helper para logging con contexto
export function logWithContext(
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: any
) {
  logger.log(level, message, { ...context });
}
```

### Paso 3: Usar logger en servicios

**Archivo:** `src/services/movements.service.ts` (ACTUALIZAR)

```typescript
import { logger } from '../logger';

export async function createMovement(companyId: string, data: CreateMovement) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
  });

  if (!company) {
    logger.warn('Company not found', { companyId });
    throw new NotFoundError('Company', companyId);
  }

  const movement = await prisma.movement.create({
    data: {
      companyId,
      type: data.type,
      amount: data.amount,
      category: data.category,
      description: data.description,
      date: new Date(data.date),
      referenceDocument: data.referenceDocument,
      fiscalYear: new Date(data.date).getFullYear(),
      status: 'draft',
    },
  });

  logger.info('Movement created', {
    movementId: movement.id,
    companyId,
    type: movement.type,
    amount: movement.amount,
    userId: context.userId, // Si tienes contexto de usuario
  });

  return movement;
}

export async function deleteMovement(companyId: string, id: string) {
  await getMovement(companyId, id);

  await prisma.movement.delete({
    where: { id },
  });

  logger.info('Movement deleted', {
    movementId: id,
    companyId,
  });
}
```

### Paso 4: Registrar logger en error middleware

**Archivo:** `src/middleware/errorHandler.ts` (YA HECHO ARRIBA)

```typescript
// Ya usa logger.warn y logger.error
```

### Checklist Backend Logger
- [ ] `npm install winston`
- [ ] Archivo `src/logger.ts` creado
- [ ] Logs se escriben a `logs/combined.log` y `logs/error.log`
- [ ] Console en desarrollo, archivo en producción
- [ ] Cada acción importante loguea: usuario, método, resultado
- [ ] Stack traces para errores

---

## ISSUE 2.1.4: SWR / REACT QUERY (FRONTEND)

### Decisión: Usar SWR (más simple para MVP)

### Paso 1: Instalar SWR

```bash
npm install swr
```

### Paso 2: Refactorizar hooks con SWR

**Archivo:** `hooks/useMovements.ts` (REFACTOR)

```typescript
'use client';

import useSWR from 'swr';
import { useCompany } from '@/context/CompanyContext';
import { Movement, MovementSummary, MovementFilter } from '@/types';
import { movementsService } from '@/services/movements.service';

export function useMovements(filters?: MovementFilter) {
  const { companyId } = useCompany();

  // Key incluye filtros para que SWR cache por separado
  const filterKey = filters
    ? `${JSON.stringify(filters)}`
    : '';
  const key = companyId ? `/api/movements/${companyId}${filterKey}` : null;

  const fetcher = async (url: string) => {
    const filterParams = new URLSearchParams();
    if (filters?.type) filterParams.append('type', filters.type);
    if (filters?.category) filterParams.append('category', filters.category);
    if (filters?.dateFrom) filterParams.append('dateFrom', filters.dateFrom);
    if (filters?.dateTo) filterParams.append('dateTo', filters.dateTo);
    if (filters?.page) filterParams.append('page', filters.page.toString());
    if (filters?.limit) filterParams.append('limit', filters.limit.toString());

    const query = filterParams.toString() ? `?${filterParams.toString()}` : '';
    return movementsService.list(companyId!, filters);
  };

  const { data: movements = [], error, isLoading, mutate } = useSWR(
    key,
    fetcher,
    {
      revalidateOnFocus: false, // No refetch al volver a la ventana
      revalidateOnReconnect: true, // Refetch si se reconecta a internet
      dedupingInterval: 60000, // 1 min: deduplicar requests idénticas
      focusThrottleInterval: 5 * 60 * 1000, // 5 min: refetch cada 5min si focus
    }
  );

  // Cargar stats en paralelo (mismo cache, pero otra key)
  const { data: summary } = useSWR(
    companyId ? `/api/stats/${companyId}` : null,
    () => movementsService.getSummary(companyId!),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );

  // Optimistic update: create
  const create = async (data: any) => {
    if (!companyId) throw new Error('No company selected');

    // Actualizar UI al instante
    const newMovement = {
      id: `temp-${Date.now()}`,
      companyId,
      ...data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const prevMovements = movements;
    mutate([newMovement, ...prevMovements], false); // false = no refetch

    try {
      const created = await movementsService.create(data);
      mutate(); // Refetch para sincronizar
      return created;
    } catch (error) {
      // Rollback en error
      mutate(prevMovements, false);
      throw error;
    }
  };

  // Optimistic update: delete
  const remove = async (id: string) => {
    if (!companyId) throw new Error('No company selected');

    const prevMovements = movements;
    mutate(movements.filter((m: any) => m.id !== id), false);

    try {
      await movementsService.delete(companyId, id);
      mutate(); // Refetch
    } catch (error) {
      // Rollback
      mutate(prevMovements, false);
      throw error;
    }
  };

  return {
    movements,
    summary,
    loading: isLoading,
    error,
    create,
    remove,
    mutate, // Exponer para refetch manual si es necesario
  };
}
```

### Paso 3: Refactorizar useStatistics

**Archivo:** `hooks/useStatistics.ts` (REFACTOR)

```typescript
'use client';

import useSWR from 'swr';
import { useCompany } from '@/context/CompanyContext';
import { DashboardStats } from '@/types';
import { movementsService } from '@/services/movements.service';

export function useStatistics() {
  const { companyId } = useCompany();

  const fetcher = async () => {
    const [summary, byCategory, byMonth] = await Promise.all([
      movementsService.getSummary(companyId!),
      movementsService.getByCategory(companyId!),
      movementsService.getByMonth(companyId!),
    ]);
    return { summary, byCategory, byMonth };
  };

  const { data: stats, error, isLoading } = useSWR(
    companyId ? `/api/stats/${companyId}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 5 * 60 * 1000, // 5 min cache
    }
  );

  return {
    stats: stats as DashboardStats | undefined,
    loading: isLoading,
    error,
  };
}
```

### Paso 4: Usar en componentes

**Archivo:** `app/dashboard/page.tsx` (EJEMPLO)

```typescript
'use client';

import { useStatistics } from '@/hooks/useStatistics';
import { useCompany } from '@/context/CompanyContext';

export default function DashboardPage() {
  const { companyId } = useCompany();
  const { stats, loading } = useStatistics();

  if (loading) return <div>Cargando...</div>;
  if (!stats) return <div>Sin datos</div>;

  return (
    <div>
      <h1>Dashboard {companyId}</h1>
      <div className="grid grid-cols-4 gap-4">
        <StatsCard title="Ingresos" value={stats.summary.totalIncome} />
        <StatsCard title="Gastos" value={stats.summary.totalExpense} />
        {/* ... */}
      </div>
    </div>
  );
}
```

### Checklist Frontend SWR
- [ ] `npm install swr`
- [ ] Hooks refactorizados con useSWR
- [ ] Deduplicación: 2 requests simultáneos = 1 HTTP call
- [ ] Cache: 5 min para stats, 1 min para movimientos
- [ ] Cambiar tab y volver = no refetch (si está en cache)
- [ ] Crear/eliminar actualiza UI al instante
- [ ] Error al guardar = rollback a estado anterior

---

## ISSUE 2.1.5: OPTIMISTIC UPDATES (FRONTEND)

### Ya implementado en useMovements hook (Paso 2 de SWR)

Pero vamos a mejorarlo con mejor manejo de errores:

**Archivo:** `hooks/useMovements.ts` (MEJORAR)

```typescript
const create = async (data: any) => {
  if (!companyId) throw new Error('No company selected');

  // Generar ID temporal para UI
  const tempId = `temp-${Date.now()}`;
  const newMovement = {
    id: tempId,
    companyId,
    ...data,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
  };

  const prevMovements = [...movements];
  
  // 1. Actualizar UI inmediatamente
  mutate([newMovement, ...movements], false);

  try {
    // 2. Enviar al backend
    const created = await movementsService.create(data);
    
    // 3. Refetch para sincronizar (reemplaza temp por real)
    mutate();
    
    return created;
  } catch (error) {
    // 4. Error: revertir
    mutate(prevMovements, false);
    
    const errorMessage = error instanceof Error 
      ? error.message 
      : 'Error al guardar movimiento';
    throw new Error(errorMessage);
  }
};

const update = async (id: string, data: Partial<any>) => {
  if (!companyId) throw new Error('No company selected');

  const prevMovements = [...movements];
  const index = movements.findIndex((m: any) => m.id === id);
  
  if (index < 0) throw new Error('Movimiento no encontrado');

  // 1. Actualizar en UI
  const updated = { ...movements[index], ...data };
  const newMovements = [...movements];
  newMovements[index] = updated;
  mutate(newMovements, false);

  try {
    // 2. Enviar al backend
    await movementsService.update(companyId, id, data);
    mutate(); // Refetch
    return updated;
  } catch (error) {
    // 3. Rollback
    mutate(prevMovements, false);
    throw error;
  }
};

const remove = async (id: string) => {
  if (!companyId) throw new Error('No company selected');

  const prevMovements = [...movements];
  
  // 1. Remover de UI
  mutate(movements.filter((m: any) => m.id !== id), false);

  try {
    // 2. Enviar DELETE al backend
    await movementsService.delete(companyId, id);
    mutate(); // Refetch (probablemente sin cambios)
  } catch (error) {
    // 3. Rollback: restaurar en UI
    mutate(prevMovements, false);
    throw error;
  }
};
```

### Uso en componentes

**Archivo:** `components/movements/MovementsTable.tsx`

```typescript
'use client';

import { Movement } from '@/types';
import { useMovements } from '@/hooks/useMovements';
import { useState } from 'react';

export function MovementsTable() {
  const { movements, remove, loading } = useMovements();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm('¿Eliminar este movimiento?')) return;

    setDeleting(id);
    setDeleteError(null);

    try {
      await remove(id);
      // Movimiento ya desapareció (optimistic)
    } catch (error) {
      // UI hizo rollback automáticamente
      const msg = error instanceof Error ? error.message : 'Error al eliminar';
      setDeleteError(msg);
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <div>Cargando...</div>;

  return (
    <div>
      {deleteError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700">
          {deleteError}
        </div>
      )}

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left p-3">Fecha</th>
            <th className="text-left p-3">Tipo</th>
            <th className="text-left p-3">Descripción</th>
            <th className="text-right p-3">Importe</th>
            <th className="p-3">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {movements.map((m) => (
            <tr
              key={m.id}
              className={`border-b transition ${
                deleting === m.id ? 'opacity-50' : ''
              }`}
            >
              <td className="p-3">{m.date}</td>
              <td className="p-3">
                <span className={m.type === 'income' ? 'text-green-600' : 'text-red-600'}>
                  {m.type === 'income' ? 'Ingreso' : 'Gasto'}
                </span>
              </td>
              <td className="p-3">{m.description}</td>
              <td className="p-3 text-right">{m.amount}</td>
              <td className="p-3 text-center">
                <button
                  onClick={() => handleDelete(m.id)}
                  disabled={deleting === m.id}
                  className="text-red-600 hover:text-red-800 disabled:opacity-50"
                >
                  {deleting === m.id ? 'Eliminando...' : 'Eliminar'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### Checklist Frontend Optimistic Updates
- [ ] Crear movimiento: aparece al instante en tabla
- [ ] Eliminar movimiento: desaparece al instante
- [ ] Editar movimiento: cambios visibles al instante
- [ ] Error: UI revierte automáticamente
- [ ] Mensaje de error mostrado al usuario
- [ ] Button deshabilitado mientras se procesa
- [ ] Sin flickering o cambios raros

---

## RESUMEN: SEMANAS 1-2 COMPLETADAS

### Código generado:
```
Backend (5-6 nuevos archivos):
  ✅ src/validators/movements.ts (Zod schemas)
  ✅ src/middleware/validateRequest.ts (Middleware)
  ✅ src/errors/AppError.ts (Error classes)
  ✅ src/middleware/errorHandler.ts (Error handler)
  ✅ src/logger.ts (Winston logger)

Frontend (3-4 nuevos archivos):
  ✅ types/schemas.ts (Zod schemas)
  ✅ hooks/useMovementForm.ts (Form hook)
  ✅ context/CompanyContext.tsx (Contexto)
  ✅ app/error.tsx (Error boundary)
```

### Cambios en archivos existentes:
```
Backend:
  ✅ src/routes/movements.routes.ts (Agregar validateRequest)
  ✅ src/controllers/movements.controller.ts (Actualizar tipos)
  ✅ src/services/movements.service.ts (Custom errors + paginación + logs)
  ✅ src/app.ts (Registrar errorHandler)

Frontend:
  ✅ app/layout.tsx (Envolver en CompanyProvider)
  ✅ components/common/Header.tsx (Selector empresa)
  ✅ hooks/useMovements.ts (SWR + optimistic)
  ✅ hooks/useStatistics.ts (SWR)
  ✅ components/movements/MovementForm.tsx (Zod validation)
```

### Instalaciones NPM:
```bash
# Backend
npm install zod winston

# Frontend
npm install zod swr
```

### Tests principales:
```bash
# Backend
POST /movements con datos inválidos → 400 con errores por campo
GET /movements?page=1&pageSize=50 → paginación funciona
DELETE /movements/:id → error boundary + rollback

# Frontend
Crear movimiento → aparece inmediatamente
Eliminar movimiento → desaparece inmediatamente
Cambiar empresa → todo se actualiza
Error → UI revierte
```

---

## DEPLOYMENT

### Backend:
```bash
git add .
git commit -m "feat: Add Zod validation, custom errors, logging, pagination

- Zod schemas for Movement validation
- Custom error classes (ValidationError, NotFoundError, etc.)
- Winston logger for structured logging
- Pagination (page + pageSize)
- ErrorHandler middleware
- Detailed error responses"

git push origin main
# Vercel auto-deploys
```

### Frontend:
```bash
git add .
git commit -m "feat: Add CompanyContext, SWR caching, Error Boundary

- CompanyContext for company selection
- Zod form validation
- SWR for data fetching + caching
- Optimistic updates (create/delete)
- Error Boundary + Error.tsx
- Improved error handling"

git push origin main
# Vercel auto-deploys
```

---

## PRÓXIMO PASO

Una vez completado esto, puedes pasar a **Fase 2.1 (UX + Gráficos)** con confianza:
- Dashboard está listo
- Contexto está listo
- Validación está lista
- Errores están listos
- Caché está listo

Ya no necesitas preocuparte por estos detalles técnicos.

