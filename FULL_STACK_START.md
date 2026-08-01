# 🚀 Arrancar el stack completo (backend + frontends + Carmen)

Guía rápida para levantar la app en local tras la auditoría.

## Requisitos

- Node.js ≥ 18
- MySQL en marcha (XAMPP) con la BD `fs_api_node`
- Un `.env` válido (cópialo de `.env.example` y rellena `ENCRYPTION_KEY` y `JWT_SECRET`)

## 1. Preparar (solo la primera vez)

```bash
# Dependencias
npm install
cd frontend && npm install && cd ..

# Cliente Prisma + crear/actualizar tablas en MySQL
npm run prisma:generate
npm run db:push

# Índice RAG del asistente Carmen (genera data/embeddings/index.json)
npm run carmen:index

# (Opcional) datos de demo: empresa "DEMO" + usuario demo@empresa.com / demo1234
npm run db:seed
```

## 2. Arrancar (tres terminales)

**Terminal 1 — Backend (API + Swagger) en http://localhost:3000**
```bash
npm run dev
```

**Terminal 2 — Frontend principal (Vite) en http://localhost:5173**
```bash
cd frontend
npx vite
```

**Terminal 3 — Frontend Chakra ("segunda piel") en http://localhost:5174**
```bash
npm run dev:chakra
```

## 3. URLs

| Qué | URL |
|---|---|
| **App web (frontend principal)** | http://localhost:5173/ |
| Login | usuario `demo@empresa.com` · contraseña `demo1234` |
| Dashboard / Vista general | http://localhost:5173/ (tras login) |
| Asientos · Libro diario | http://localhost:5173/contabilidad/asientos |
| Impuestos (IVA/303, IRPF/190) | http://localhost:5173/impuestos |
| **Carmen** (asistente) | botón 💬 flotante, abajo a la derecha, en cualquier página |
| **App web (segunda piel, Chakra)** | http://localhost:5174/ |
| Login (Chakra) | mismo usuario: `demo@empresa.com` · contraseña `demo1234` |
| Dashboard contable (Chakra) | http://localhost:5174/accounting/dashboard |
| Libro diario / asientos (Chakra) | http://localhost:5174/accounting/journal-entries |
| Balance (Chakra) | http://localhost:5174/reports/balance |
| Pérdidas y ganancias (Chakra) | http://localhost:5174/reports/profit-and-loss |
| Libros de IVA (Chakra) | http://localhost:5174/tax/vat-books |
| Resumen de impuestos (Chakra) | http://localhost:5174/tax/summary |
| **Swagger UI (API)** | http://localhost:3000/docs |
| Healthcheck | http://localhost:3000/health |

> El frontend principal guarda el JWT **en memoria** (no en localStorage) y
> todas las llamadas van a `http://localhost:3000`. El frontend Chakra guarda
> el JWT y la empresa activa en `localStorage` (`jwt_token`, `company_id`) y
> usa `VITE_API_BASE_URL` (por defecto `http://localhost:3000`) — configurable
> con un `.env` en `frontend-chakra/`. CORS está restringido a los orígenes de
> `CORS_ORIGIN` (por defecto incluye `localhost:5173` y `localhost:5174`).

## 3bis. Build de producción del frontend Chakra

```bash
npm run build:chakra    # genera frontend-chakra/dist
npm run preview:chakra  # sirve ese build en http://localhost:4174
```

## 4. Carmen sin clave de Claude

El chat funciona **sin** `ANTHROPIC_API_KEY`: responde en *modo degradado*
devolviendo la documentación recuperada por RAG. Para respuestas redactadas por
el LLM, pon una clave real en `.env` (`ANTHROPIC_API_KEY=sk-ant-...`) y reinicia
el backend. No hay que tocar código.

## 5. Nota sobre los dos frontends

- **`frontend/`** (Vite + React) → la app principal (puerto 5173, URLs de
  arriba). Incluye Carmen integrado y es la que se usa para el día a día.
- **`frontend-chakra/`** (Vite + React + Chakra UI, "segunda piel", puerto
  5174) → vistas avanzadas de contabilidad/informes/impuestos (Fases 1-4:
  libro diario, balance, P&G, mayor, análisis por cliente, libros de IVA,
  resumen de impuestos, dashboard contable). Tiene su propio login
  (`/login`) y guarda la sesión en `localStorage`. Usa los mismos endpoints
  de backend (`/companies/:companyId/accounting`, `/reports`, `/tax`).

### Pendientes conocidos del frontend Chakra

- Algunos tipos de `frontend-chakra/src/api/types.ts` (p. ej.
  `ProfitAndLossResponse` con secciones `ingresos`/`gastos` anidadas) son más
  ricos que la respuesta real de `/reports/profit-and-loss` (que devuelve
  `{ desde, hasta, ingresos, gastos, resultadoExplotacion }` como números). Las
  páginas compilan (los `httpGet<T>` son *type assertions*, no validación en
  runtime), pero algunas secciones de detalle pueden no renderizar datos hasta
  reconciliar esos tipos con la forma real del backend.
