# IMPLEMENTACIÓN REAL — Backend: Endpoints de Movimientos

**Código completo listo para agregar a conta-api**

---

## PASO 1: Agregar tabla Movement a Prisma

### 1.1 Actualizar `prisma/schema.prisma`

Agrega este modelo después del modelo `Company`:

```prisma
model Movement {
  id              String    @id @default(cuid())
  companyId       String
  company         Company   @relation("movements", fields: [companyId], references: [id], onDelete: Cascade)
  
  type            String    // "income" | "expense"
  amount          Decimal   @db.Decimal(14, 2)
  category        String
  description     String
  date            DateTime
  referenceDocument String?
  
  fiscalYear      Int
  status          String    // "draft" | "approved" | "reconciled"
  
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  
  @@index([companyId])
  @@index([date])
  @@index([type])
}
```

Actualiza también la relación en `Company`:

```prisma
model Company {
  // ... campos existentes
  movements       Movement[]  @relation("movements")
}
```

### 1.2 Crear y ejecutar migration

```bash
npx prisma migrate dev --name add_movements

# Verás confirmación:
# ✓ Created migration: add_movements
# ✓ Generated Prisma Client
```

---

## PASO 2: Crear tipos TypeScript

### 2.1 Nuevo archivo: `src/types/movements.ts`

```typescript
export interface Movement {
  id: string;
  companyId: string;
  type: 'income' | 'expense';
  amount: number | string; // Decimal en BD, string en JSON
  category: string;
  description: string;
  date: string; // ISO 8601
  referenceDocument?: string;
  fiscalYear: number;
  status: 'draft' | 'approved' | 'reconciled';
  createdAt: string;
  updatedAt: string;
}

export interface CreateMovementDTO {
  type: 'income' | 'expense';
  amount: number | string;
  category: string;
  description: string;
  date: string; // YYYY-MM-DD
  referenceDocument?: string;
}

export interface UpdateMovementDTO extends Partial<CreateMovementDTO> {}

export interface MovementFilter {
  type?: 'income' | 'expense';
  category?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface MovementSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
  movementCount: number;
  period: string;
}

export interface CategoryStat {
  category: string;
  income: number;
  expense: number;
  percentage: number;
}

export interface MonthlyStat {
  month: string; // "2026-01"
  income: number;
  expense: number;
  balance: number;
}
```

---

## PASO 3: Crear servicio de movimientos

### 3.1 Nuevo archivo: `src/services/movements.service.ts`

```typescript
import { prisma } from '../config/prisma';
import { Movement, CreateMovementDTO, UpdateMovementDTO, MovementFilter, MovementSummary, CategoryStat, MonthlyStat } from '../types/movements';
import { Decimal } from '@prisma/client/runtime/library';

export const movementsService = {
  /**
   * Crear un movimiento
   */
  async createMovement(companyId: string, data: CreateMovementDTO): Promise<Movement> {
    // Validar que la empresa existe
    const company = await prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      throw new Error(`Company ${companyId} not found`);
    }

    // Parsear fecha
    const movementDate = new Date(data.date + 'T00:00:00Z');
    const fiscalYear = movementDate.getUTCFullYear();

    // Crear movimiento
    const movement = await prisma.movement.create({
      data: {
        companyId,
        type: data.type,
        amount: new Decimal(data.amount.toString()),
        category: data.category,
        description: data.description,
        date: movementDate,
        referenceDocument: data.referenceDocument || null,
        fiscalYear,
        status: 'approved',
      },
    });

    return this.formatMovement(movement);
  },

  /**
   * Obtener movimientos con filtros
   */
  async getMovements(companyId: string, filters?: MovementFilter): Promise<Movement[]> {
    const where: any = {
      companyId,
    };

    if (filters?.type) {
      where.type = filters.type;
    }

    if (filters?.category) {
      where.category = filters.category;
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.date = {};
      if (filters.dateFrom) {
        where.date.gte = new Date(filters.dateFrom + 'T00:00:00Z');
      }
      if (filters.dateTo) {
        where.date.lte = new Date(filters.dateTo + 'T23:59:59Z');
      }
    }

    const movements = await prisma.movement.findMany({
      where,
      orderBy: [
        { date: 'desc' },
        { createdAt: 'desc' },
      ],
      skip: filters?.page ? (filters.page - 1) * (filters.limit || 50) : 0,
      take: filters?.limit || 50,
    });

    return movements.map((m) => this.formatMovement(m));
  },

  /**
   * Obtener un movimiento por ID
   */
  async getMovement(companyId: string, id: string): Promise<Movement> {
    const movement = await prisma.movement.findUnique({
      where: {
        id,
      },
    });

    if (!movement || movement.companyId !== companyId) {
      throw new Error('Movement not found');
    }

    return this.formatMovement(movement);
  },

  /**
   * Actualizar un movimiento
   */
  async updateMovement(companyId: string, id: string, data: UpdateMovementDTO): Promise<Movement> {
    const movement = await prisma.movement.findUnique({
      where: { id },
    });

    if (!movement || movement.companyId !== companyId) {
      throw new Error('Movement not found');
    }

    const updateData: any = {};

    if (data.type !== undefined) updateData.type = data.type;
    if (data.amount !== undefined) updateData.amount = new Decimal(data.amount.toString());
    if (data.category !== undefined) updateData.category = data.category;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.referenceDocument !== undefined) updateData.referenceDocument = data.referenceDocument;

    if (data.date) {
      const newDate = new Date(data.date + 'T00:00:00Z');
      updateData.date = newDate;
      updateData.fiscalYear = newDate.getUTCFullYear();
    }

    const updated = await prisma.movement.update({
      where: { id },
      data: updateData,
    });

    return this.formatMovement(updated);
  },

  /**
   * Eliminar un movimiento (soft delete: cambiar status)
   */
  async deleteMovement(companyId: string, id: string): Promise<void> {
    const movement = await prisma.movement.findUnique({
      where: { id },
    });

    if (!movement || movement.companyId !== companyId) {
      throw new Error('Movement not found');
    }

    // Soft delete: marcar como deletado (opcional, o hacer hard delete)
    // await prisma.movement.update({
    //   where: { id },
    //   data: { status: 'deleted' },
    // });

    // Hard delete (más simple):
    await prisma.movement.delete({
      where: { id },
    });
  },

  /**
   * Obtener resumen de movimientos (ingresos, gastos, balance)
   */
  async getSummary(companyId: string, filters?: { dateFrom?: string; dateTo?: string }): Promise<MovementSummary> {
    const where: any = { companyId };

    if (filters?.dateFrom || filters?.dateTo) {
      where.date = {};
      if (filters.dateFrom) {
        where.date.gte = new Date(filters.dateFrom + 'T00:00:00Z');
      }
      if (filters.dateTo) {
        where.date.lte = new Date(filters.dateTo + 'T23:59:59Z');
      }
    }

    const movements = await prisma.movement.findMany({
      where,
    });

    const totalIncome = movements
      .filter((m) => m.type === 'income')
      .reduce((sum, m) => sum + parseFloat(m.amount.toString()), 0);

    const totalExpense = movements
      .filter((m) => m.type === 'expense')
      .reduce((sum, m) => sum + parseFloat(m.amount.toString()), 0);

    return {
      totalIncome: Number(totalIncome.toFixed(2)),
      totalExpense: Number(totalExpense.toFixed(2)),
      balance: Number((totalIncome - totalExpense).toFixed(2)),
      movementCount: movements.length,
      period: filters?.dateFrom && filters?.dateTo ? `${filters.dateFrom} to ${filters.dateTo}` : 'all',
    };
  },

  /**
   * Obtener estadísticas por categoría
   */
  async getByCategory(companyId: string, filters?: { dateFrom?: string; dateTo?: string }): Promise<CategoryStat[]> {
    const where: any = { companyId };

    if (filters?.dateFrom || filters?.dateTo) {
      where.date = {};
      if (filters.dateFrom) {
        where.date.gte = new Date(filters.dateFrom + 'T00:00:00Z');
      }
      if (filters.dateTo) {
        where.date.lte = new Date(filters.dateTo + 'T23:59:59Z');
      }
    }

    const movements = await prisma.movement.findMany({
      where,
    });

    // Agrupar por categoría
    const byCategory: Record<string, { income: number; expense: number }> = {};

    movements.forEach((m) => {
      const category = m.category || 'Uncategorized';
      if (!byCategory[category]) {
        byCategory[category] = { income: 0, expense: 0 };
      }

      const amount = parseFloat(m.amount.toString());
      if (m.type === 'income') {
        byCategory[category].income += amount;
      } else {
        byCategory[category].expense += amount;
      }
    });

    // Calcular totales para porcentajes
    const totalIncome = Object.values(byCategory).reduce((sum, c) => sum + c.income, 0);
    const totalExpense = Object.values(byCategory).reduce((sum, c) => sum + c.expense, 0);
    const totalMovement = totalIncome + totalExpense;

    // Convertir a array y calcular porcentajes
    const result: CategoryStat[] = Object.entries(byCategory).map(([category, { income, expense }]) => {
      const categoryTotal = income + expense;
      return {
        category,
        income: Number(income.toFixed(2)),
        expense: Number(expense.toFixed(2)),
        percentage: totalMovement > 0 ? Number(((categoryTotal / totalMovement) * 100).toFixed(2)) : 0,
      };
    });

    return result.sort((a, b) => b.percentage - a.percentage);
  },

  /**
   * Obtener estadísticas por mes
   */
  async getByMonth(companyId: string, filters?: { dateFrom?: string; dateTo?: string }): Promise<MonthlyStat[]> {
    const where: any = { companyId };

    if (filters?.dateFrom || filters?.dateTo) {
      where.date = {};
      if (filters.dateFrom) {
        where.date.gte = new Date(filters.dateFrom + 'T00:00:00Z');
      }
      if (filters.dateTo) {
        where.date.lte = new Date(filters.dateTo + 'T23:59:59Z');
      }
    }

    const movements = await prisma.movement.findMany({
      where,
      orderBy: { date: 'asc' },
    });

    // Agrupar por mes
    const byMonth: Record<string, { income: number; expense: number }> = {};

    movements.forEach((m) => {
      const monthKey = m.date.toISOString().substring(0, 7); // "2026-01"
      if (!byMonth[monthKey]) {
        byMonth[monthKey] = { income: 0, expense: 0 };
      }

      const amount = parseFloat(m.amount.toString());
      if (m.type === 'income') {
        byMonth[monthKey].income += amount;
      } else {
        byMonth[monthKey].expense += amount;
      }
    });

    // Convertir a array
    const result: MonthlyStat[] = Object.entries(byMonth).map(([month, { income, expense }]) => ({
      month,
      income: Number(income.toFixed(2)),
      expense: Number(expense.toFixed(2)),
      balance: Number((income - expense).toFixed(2)),
    }));

    return result;
  },

  /**
   * Helper: Formatear movimiento para respuesta
   */
  private formatMovement(movement: any): Movement {
    return {
      id: movement.id,
      companyId: movement.companyId,
      type: movement.type,
      amount: parseFloat(movement.amount.toString()),
      category: movement.category,
      description: movement.description,
      date: movement.date.toISOString().substring(0, 10), // "2026-06-30"
      referenceDocument: movement.referenceDocument || undefined,
      fiscalYear: movement.fiscalYear,
      status: movement.status,
      createdAt: movement.createdAt.toISOString(),
      updatedAt: movement.updatedAt.toISOString(),
    };
  },
};
```

---

## PASO 4: Crear controlador de movimientos

### 4.1 Nuevo archivo: `src/controllers/movements.controller.ts`

```typescript
import { Request, Response } from 'express';
import { movementsService } from '../services/movements.service';
import { CreateMovementDTO, UpdateMovementDTO, MovementFilter } from '../types/movements';

export const movementsController = {
  /**
   * POST /api/companies/:companyId/movements
   */
  async createMovement(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const data: CreateMovementDTO = req.body;

      // Validar campos requeridos
      if (!data.type || !data.amount || !data.category || !data.description || !data.date) {
        return res.status(400).json({
          error: 'Missing required fields: type, amount, category, description, date',
        });
      }

      // Validar tipo
      if (!['income', 'expense'].includes(data.type)) {
        return res.status(400).json({ error: 'Invalid type. Must be "income" or "expense"' });
      }

      const movement = await movementsService.createMovement(companyId, data);
      return res.status(201).json(movement);
    } catch (error) {
      console.error('Error creating movement:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },

  /**
   * GET /api/companies/:companyId/movements
   */
  async getMovements(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const filters: MovementFilter = {
        type: req.query.type as any,
        category: req.query.category as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
        status: req.query.status as string,
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
      };

      const movements = await movementsService.getMovements(companyId, filters);
      return res.json(movements);
    } catch (error) {
      console.error('Error fetching movements:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },

  /**
   * GET /api/companies/:companyId/movements/:id
   */
  async getMovement(req: Request, res: Response) {
    try {
      const { companyId, id } = req.params;
      const movement = await movementsService.getMovement(companyId, id);
      return res.json(movement);
    } catch (error) {
      console.error('Error fetching movement:', error);
      return res.status(404).json({
        error: error instanceof Error ? error.message : 'Movement not found',
      });
    }
  },

  /**
   * PATCH /api/companies/:companyId/movements/:id
   */
  async updateMovement(req: Request, res: Response) {
    try {
      const { companyId, id } = req.params;
      const data: UpdateMovementDTO = req.body;

      const movement = await movementsService.updateMovement(companyId, id, data);
      return res.json(movement);
    } catch (error) {
      console.error('Error updating movement:', error);
      return res.status(404).json({
        error: error instanceof Error ? error.message : 'Movement not found',
      });
    }
  },

  /**
   * DELETE /api/companies/:companyId/movements/:id
   */
  async deleteMovement(req: Request, res: Response) {
    try {
      const { companyId, id } = req.params;
      await movementsService.deleteMovement(companyId, id);
      return res.status(204).send();
    } catch (error) {
      console.error('Error deleting movement:', error);
      return res.status(404).json({
        error: error instanceof Error ? error.message : 'Movement not found',
      });
    }
  },

  /**
   * GET /api/companies/:companyId/stats/summary
   */
  async getSummary(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const summary = await movementsService.getSummary(companyId, {
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
      });
      return res.json(summary);
    } catch (error) {
      console.error('Error calculating summary:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },

  /**
   * GET /api/companies/:companyId/stats/by-category
   */
  async getByCategory(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const stats = await movementsService.getByCategory(companyId, {
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
      });
      return res.json(stats);
    } catch (error) {
      console.error('Error calculating by-category:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },

  /**
   * GET /api/companies/:companyId/stats/by-month
   */
  async getByMonth(req: Request, res: Response) {
    try {
      const { companyId } = req.params;
      const stats = await movementsService.getByMonth(companyId, {
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
      });
      return res.json(stats);
    } catch (error) {
      console.error('Error calculating by-month:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Internal server error',
      });
    }
  },
};
```

---

## PASO 5: Crear rutas

### 5.1 Nuevo archivo: `src/routes/movements.routes.ts`

```typescript
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { movementsController } from '../controllers/movements.controller';

const router = Router({ mergeParams: true });

// Proteger todas las rutas con autenticación
router.use(authMiddleware);

// POST /api/companies/:companyId/movements
router.post('/', movementsController.createMovement);

// GET /api/companies/:companyId/movements
router.get('/', movementsController.getMovements);

// GET /api/companies/:companyId/movements/:id
router.get('/:id', movementsController.getMovement);

// PATCH /api/companies/:companyId/movements/:id
router.patch('/:id', movementsController.updateMovement);

// DELETE /api/companies/:companyId/movements/:id
router.delete('/:id', movementsController.deleteMovement);

// GET /api/companies/:companyId/stats/summary
router.get('/stats/summary', movementsController.getSummary);

// GET /api/companies/:companyId/stats/by-category
router.get('/stats/by-category', movementsController.getByCategory);

// GET /api/companies/:companyId/stats/by-month
router.get('/stats/by-month', movementsController.getByMonth);

export default router;
```

---

## PASO 6: Registrar rutas en app.ts

### 6.1 Modificar `src/app.ts`

Agrega esto en la sección de routes (después de routes existentes):

```typescript
import movementsRouter from './routes/movements.routes';

// ... otros imports y configuración

// Routes
app.use('/api/companies/:companyId/movements', movementsRouter);

// ... errorMiddleware al final
```

---

## PASO 7: Compilar y desplegar

### 7.1 Compilar TypeScript

```bash
npm run build
# Esperado: sin errores
```

### 7.2 Probar localmente

```bash
npm run dev

# Luego probar endpoints con curl:
curl -X GET http://localhost:3000/api/companies/test-company/movements \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### 7.3 Desplegar en Vercel

```bash
git add .
git commit -m "feat: Add movements endpoints for accounting app

- Add Movement model to Prisma
- Implement CRUD endpoints for movements
- Add statistics endpoints (summary, by-category, by-month)
- Integrate with existing company/auth middleware"

git push origin main
# Vercel despliega automáticamente
```

---

## PASO 8: Documentar en OpenAPI/Swagger

Actualiza tu `src/routes/docs.ts` (que ya existe) para incluir estos nuevos endpoints:

```typescript
// En la sección "paths" del OpenAPI spec:

"/companies/{companyId}/movements": {
  "post": {
    "summary": "Create a movement (income or expense)",
    "tags": ["Movements"],
    "parameters": [
      {
        "name": "companyId",
        "in": "path",
        "required": true,
        "schema": { "type": "string" }
      }
    ],
    "requestBody": {
      "required": true,
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "type": { "type": "string", "enum": ["income", "expense"] },
              "amount": { "type": "number" },
              "category": { "type": "string" },
              "description": { "type": "string" },
              "date": { "type": "string", "format": "date" }
            },
            "required": ["type", "amount", "category", "description", "date"]
          }
        }
      }
    },
    "responses": {
      "201": { "description": "Movement created" },
      "400": { "description": "Bad request" }
    }
  },
  "get": {
    "summary": "List movements with filters",
    "tags": ["Movements"],
    "parameters": [
      { "name": "companyId", "in": "path", "required": true, "schema": { "type": "string" } },
      { "name": "type", "in": "query", "schema": { "type": "string", "enum": ["income", "expense"] } },
      { "name": "category", "in": "query", "schema": { "type": "string" } },
      { "name": "dateFrom", "in": "query", "schema": { "type": "string" } },
      { "name": "dateTo", "in": "query", "schema": { "type": "string" } }
    ],
    "responses": {
      "200": { "description": "List of movements" }
    }
  }
}

"/companies/{companyId}/stats/summary": {
  "get": {
    "summary": "Get financial summary (income, expense, balance)",
    "tags": ["Statistics"],
    "parameters": [
      { "name": "companyId", "in": "path", "required": true, "schema": { "type": "string" } }
    ],
    "responses": {
      "200": { "description": "Summary with totals" }
    }
  }
},

"/companies/{companyId}/stats/by-category": {
  "get": {
    "summary": "Get statistics broken down by category",
    "tags": ["Statistics"],
    "parameters": [
      { "name": "companyId", "in": "path", "required": true, "schema": { "type": "string" } }
    ],
    "responses": {
      "200": { "description": "Statistics by category" }
    }
  }
},

"/companies/{companyId}/stats/by-month": {
  "get": {
    "summary": "Get statistics broken down by month",
    "tags": ["Statistics"],
    "parameters": [
      { "name": "companyId", "in": "path", "required": true, "schema": { "type": "string" } }
    ],
    "responses": {
      "200": { "description": "Statistics by month" }
    }
  }
}
```

---

## ✅ VALIDACIÓN FINAL

Después de completar estos pasos, el backend estará listo. Comprueba con:

```bash
# Healthcheck
curl https://conta-api-alpha.vercel.app/api/health

# Obtener documentación Swagger
curl https://conta-api-alpha.vercel.app/swagger

# Los nuevos endpoints aparecerán en Swagger UI
```

El frontend (que viene a continuación) consumirá estos endpoints automáticamente.

