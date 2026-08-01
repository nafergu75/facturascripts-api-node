# APLICACIÓN CONTABLE — GUÍA DE DESPLIEGUE Y USO

**Pasos completos para crear, desplegar y usar la app contable**

---

## PASO 1: CREAR PROYECTO NEXT.JS LOCALMENTE

### 1.1 Crear proyecto

```bash
# Crear proyecto Next.js
npx create-next-app@latest frontend-contable --typescript --tailwind --app

# Entrar al proyecto
cd frontend-contable
```

### 1.2 Instalar dependencias

```bash
npm install chart.js react-chartjs-2 date-fns
```

### 1.3 Crear estructura de carpetas

```bash
# Carpetas principales
mkdir -p app/{auth,dashboard,movements,documents}
mkdir -p components/{common,dashboard,movements,documents}
mkdir -p hooks services types utils context

# Crear archivos base
touch .env.local
touch public/.gitkeep
```

---

## PASO 2: COPIAR CÓDIGO BASE

### 2.1 Copiar tipos y modelos

**Archivo:** `src/types/accounting.ts`

Copia el contenido de la sección "1️⃣ TIPOS Y MODELOS" del documento `APP_CONTABLE_CODIGO_BASE.md`

Repite este proceso para todos los archivos de código base.

### 2.2 Estructura final

```
frontend-contable/
├── app/
│   ├── layout.tsx                    ← Copiar de CODIGO_BASE
│   ├── page.tsx                      ← Copiar
│   ├── dashboard/
│   │   └── page.tsx                  ← Copiar
│   ├── movements/
│   │   ├── page.tsx                  ← Copiar
│   │   └── new/
│   │       └── page.tsx              ← Copiar
│   └── documents/
│       └── page.tsx
├── components/
│   ├── common/
│   │   └── Header.tsx                ← Copiar
│   ├── dashboard/
│   │   └── StatsCard.tsx             ← Copiar
│   └── movements/
│       ├── MovementsTable.tsx        ← Copiar
│       └── MovementForm.tsx          ← Copiar
├── hooks/
│   ├── useAuth.ts                    ← Copiar
│   ├── useMovements.ts               ← Copiar
│   └── useDocuments.ts               ← Copiar
├── services/
│   ├── api.ts                        ← Copiar
│   ├── movements.service.ts          ← Copiar
│   ├── documents.service.ts          ← Copiar
│   └── auth.service.ts               ← Copiar
├── types/
│   └── accounting.ts                 ← Copiar
├── utils/
│   └── formatters.ts                 ← Copiar
├── styles/
│   └── globals.css                   (TailwindCSS generado)
├── .env.local                        ← Crear
├── tailwind.config.ts                ← Copiar
├── tsconfig.json                     (Generado automáticamente)
├── next.config.ts                    ← Crear
├── package.json                      ← Ya existe
└── README.md
```

---

## PASO 3: CONFIGURAR VARIABLES DE ENTORNO

### 3.1 Crear `.env.local`

```bash
# En la raíz del proyecto
cat > .env.local << 'EOF'
# API Backend
NEXT_PUBLIC_API_URL=https://conta-api-alpha.vercel.app
NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000

# Auth
NEXT_PUBLIC_JWT_STORAGE_KEY=conta_app_token
EOF
```

### 3.2 Verificar variables

```bash
cat .env.local
```

---

## PASO 4: PROBAR LOCALMENTE

### 4.1 Compilar

```bash
npm run build
# Esperado: "✓ Compiled successfully"
```

### 4.2 Ejecutar en desarrollo

```bash
npm run dev
```

### 4.3 Abrir en navegador

```
http://localhost:3000
```

Deberías ver:
- ✅ Header con navegación
- ✅ Redirección a `/dashboard`
- ✅ Dashboard con stats
- ✅ Enlace a Movimientos y Documentos

---

## PASO 5: DESPLEGAR EN VERCEL

### 5.1 Opción A: Desplegar con Git (Recomendado)

```bash
# Inicializar git (si no existe)
git init
git add .
git commit -m "feat: Add professional accounting frontend

- Next.js 14 with TypeScript
- Dashboard, movements, documents views
- Integration with conta-api backend
- TailwindCSS styling"

# Conectar a GitHub (crear repo en https://github.com/new)
git remote add origin https://github.com/TU_USUARIO/frontend-contable.git
git branch -M main
git push -u origin main

# Vercel auto-detecta y despliega automáticamente
# (Si tienes Vercel integrado en GitHub)
```

### 5.2 Opción B: Desplegar con Vercel CLI

```bash
# Instalar CLI
npm install -g vercel

# Desplegar a producción
vercel deploy --prod

# Vercel te pide:
# ✓ Link to existing project? → No
# ✓ Project name → frontend-contable
# ✓ Folder → ./
# ✓ Deploy to production? → Yes
```

### 5.3 Vercel creará una URL

```
✓ Deployed to https://frontend-contable-xxx.vercel.app
```

---

## PASO 6: CONFIGURAR VERCEL DASHBOARD

### 6.1 Ir a Vercel Dashboard

```
https://vercel.com/nafergu75s-projects
```

### 6.2 Crear proyecto nuevo

Si no lo hizo automáticamente:
- Click "Add New" → "Project"
- Selecciona tu repo
- Click "Import"

### 6.3 Configurar Environment Variables

En `Settings` → `Environment Variables`:

```
NEXT_PUBLIC_API_URL = https://conta-api-alpha.vercel.app
NEXT_PUBLIC_FRONTEND_URL = https://frontend-contable-xxx.vercel.app
```

(Reemplaza `xxx` con tu dominio)

### 6.4 Desplegar

```bash
git push origin main
# Vercel auto-despliega
```

---

## PASO 7: IMPLEMENTAR ENDPOINTS EN BACKEND

Para que el frontend funcione completamente, necesitas agregar estos endpoints en conta-api.

### 7.1 Crear tabla `movements` (Prisma)

**Archivo:** `prisma/schema.prisma`

Agregar:

```prisma
model Movement {
  id            String    @id @default(cuid())
  companyId     String
  company       Company   @relation(fields: [companyId], references: [id])
  type          String    // "income" | "expense"
  amount        Decimal   @db.Decimal(12, 2)
  category      String
  description   String
  date          DateTime
  referenceDocument String?
  fiscalYear    Int
  status        String    // "draft" | "approved" | "reconciled"
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  @@index([companyId])
  @@index([date])
}
```

Luego:

```bash
# En la raíz del proyecto conta-api
npx prisma migrate dev --name add_movements
```

### 7.2 Crear rutas en backend

**Archivo:** `src/routes/movements.routes.ts` (NUEVO)

```typescript
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware';
import { prisma } from '../config/prisma';

const router = Router({ mergeParams: true });

// POST /api/companies/:companyId/movements
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { type, amount, category, description, date } = req.body;

    if (!type || !amount || !category || !date) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const movement = await prisma.movement.create({
      data: {
        companyId,
        type,
        amount: parseFloat(amount),
        category,
        description,
        date: new Date(date),
        fiscalYear: new Date(date).getFullYear(),
        status: 'approved',
      },
    });

    return res.status(201).json(movement);
  } catch (error) {
    console.error('Error creating movement:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/companies/:companyId/movements
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { type, category, dateFrom, dateTo } = req.query;

    const where: any = { companyId };
    if (type) where.type = type;
    if (category) where.category = category;
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
    console.error('Error fetching movements:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/companies/:companyId/stats/summary
router.get('/stats/summary', authMiddleware, async (req, res) => {
  try {
    const { companyId } = req.params;

    const movements = await prisma.movement.findMany({
      where: { companyId },
    });

    const totalIncome = movements
      .filter((m) => m.type === 'income')
      .reduce((sum, m) => sum + parseFloat(m.amount.toString()), 0);

    const totalExpense = movements
      .filter((m) => m.type === 'expense')
      .reduce((sum, m) => sum + parseFloat(m.amount.toString()), 0);

    return res.json({
      totalIncome,
      totalExpense,
      balance: totalIncome - totalExpense,
      movementCount: movements.length,
      period: 'month',
    });
  } catch (error) {
    console.error('Error calculating summary:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ... más endpoints (PATCH, DELETE, etc.)

export default router;
```

### 7.3 Registrar rutas en app.ts

**Archivo:** `src/app.ts`

Agregar (antes de errorMiddleware):

```typescript
import movementsRouter from './routes/movements.routes';

// ... existing routes

app.use('/api/companies/:companyId/movements', movementsRouter);
```

### 7.4 Desplegar backend

```bash
# En la raíz de conta-api
git add .
git commit -m "feat: Add movements endpoints for accounting app"
git push origin main
# o: vercel deploy --prod
```

---

## PASO 8: GUÍA DE USO PARA USUARIOS

### 8.1 Acceder a la aplicación

```
https://frontend-contable-xxx.vercel.app
```

### 8.2 Flujo básico

#### **1. Login (si está implementado)**
- Email y password
- Se guarda token automáticamente

#### **2. Ver Dashboard**
- Resumen de ingresos, gastos, balance
- Número de movimientos
- Estado de documentos

**Ejemplo de datos:**
- Ingresos: €15,250.00
- Gastos: €8,430.50
- Balance: €6,819.50
- Movimientos: 47

#### **3. Crear Movimiento de Ingreso**
- Ir a "Movimientos"
- Click "+ Nuevo Movimiento"
- Rellena:
  - **Tipo:** Ingreso
  - **Importe:** 2,500 €
  - **Categoría:** Ventas
  - **Descripción:** Venta a cliente Acme Corp
  - **Fecha:** 2026-06-28
- Click "Guardar"
- Aparece en la tabla inmediatamente

#### **4. Crear Movimiento de Gasto**
- Ir a "Movimientos"
- Click "+ Nuevo Movimiento"
- Rellena:
  - **Tipo:** Gasto
  - **Importe:** 450 €
  - **Categoría:** Suministros
  - **Descripción:** Compra de material de oficina
  - **Fecha:** 2026-06-29
- Click "Guardar"

#### **5. Ver Documentos**
- Ir a "Documentos"
- Ver lista de PDFs/fotos subidas
- Estado de procesamiento (OCR)
  - ✅ READY_FOR_VERIFICATION = Listo
  - ⏳ PROCESSING = En proceso
  - ❌ REJECTED = Rechazado
  - ⚠️ ERROR = Error

#### **6. Filtrar Movimientos**
- En "Movimientos"
- Usar botones:
  - "Todos" = Mostrar ingresos + gastos
  - "Ingresos" = Solo ingresos
  - "Gastos" = Solo gastos

#### **7. Ver Estadísticas**
- En "Dashboard"
- Stats cards muestran:
  - Total ingresos del período
  - Total gastos del período
  - Balance (ingresos - gastos)
  - Número de movimientos registrados

### 8.3 Ejemplos de categorías

**Ingresos:**
- Ventas
- Servicios
- Asesoramiento
- Intereses
- Otros ingresos

**Gastos:**
- Suministros
- Salarios
- Alquiler
- Electricidad
- Teléfono
- Mantenimiento
- Seguros
- Impuestos
- Otros gastos

---

## PASO 9: VERIFICAR INTEGRACIÓN

### 9.1 Comprobar que todo funciona

```bash
# 1. Frontend está en Vercel
curl https://frontend-contable-xxx.vercel.app
# → HTML de Next.js

# 2. API backend responde
curl https://conta-api-alpha.vercel.app/api/health
# → { "status": "ok", ... }

# 3. Crear movimiento desde frontend
# → Abre app, crea movimiento, aparece en tabla
```

### 9.2 Debugging si hay errores

**Error: "Failed to fetch from API"**
- Verificar que `NEXT_PUBLIC_API_URL` es correcto
- Verificar que backend está online
- Revisar Network tab en DevTools (F12)

**Error: "Token inválido"**
- Limpiar localStorage
- Hacer login de nuevo
- Verificar que backend devuelve token válido

**Error: "Movimiento no guarda"**
- Verificar en Network que POST llega al backend
- Verificar que backend devuelve 201 (created)
- Revisar console del navegador (F12)

---

## PASO 10: DESPLIEGUE EN PRODUCCIÓN

### 10.1 Dominio personalizado

En Vercel Dashboard → Settings → Domains:

```
frontend-contable.tudominio.com
```

(Requiere configurar DNS en tu registrador)

### 10.2 SSL automático

Vercel genera certificado SSL automáticamente.

### 10.3 Monitoreo

Vercel Dashboard muestra:
- ✅ Build status
- ✅ Deployment history
- ✅ Performance metrics
- ✅ Error logs

---

## CHECKLIST DE DESPLIEGUE

```
Frontend Next.js
[ ] ✅ Proyecto creado localmente
[ ] ✅ npm install completado
[ ] ✅ Código base copiado
[ ] ✅ Tipado TypeScript válido
[ ] ✅ npm run build sin errores
[ ] ✅ npm run dev funciona en localhost:3000
[ ] ✅ Desplegado en Vercel
[ ] ✅ Environment variables configuradas
[ ] ✅ URL de producción accesible

Backend conta-api
[ ] ✅ Tabla `movements` creada en Prisma
[ ] ✅ Rutas de movements creadas
[ ] ✅ Endpoints testados con curl/Postman
[ ] ✅ CORS configurado (si es necesario)
[ ] ✅ Backend desplegado en Vercel
[ ] ✅ API responde desde frontend

Integración
[ ] ✅ Frontend se conecta a backend
[ ] ✅ Login funciona (si está implementado)
[ ] ✅ Crear movimiento funciona
[ ] ✅ Listar movimientos funciona
[ ] ✅ Stats se calculan correctamente
[ ] ✅ Documentos se muestran
[ ] ✅ Sin errores CORS en console

Documentación
[ ] ✅ Usuarios saben cómo usar
[ ] ✅ Ejemplos de datos listos
[ ] ✅ Categorías definidas
```

---

## RESUMEN FINAL

✅ **Aplicación contable profesional** desplegada  
✅ **Frontend en Next.js** integrado con backend conta-api  
✅ **Dashboard, movimientos, documentos** funcionales  
✅ **Estadísticas y filtros** implementados  
✅ **Código limpio y extensible**  

**Tiempo total:** ~30 minutos setup + despliegue  
**Complejidad:** Media  
**Resultado:** App contable funcional lista para usar  

¡Ahora puedes usar tu API conta-api como un software contable profesional! 🚀

