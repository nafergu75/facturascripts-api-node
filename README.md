# facturascripts-api-node

Capa intermedia (BFF / API Gateway) en **Node.js + Express + TypeScript** sobre la
API REST de **FacturaScripts**. Expone endpoints limpios y coherentes, autentica con
**JWT** y controla acceso **multiempresa**. Internamente llama a la API de
FacturaScripts vía HTTP (axios).

> Estado: **esqueleto**. La lógica de negocio y el mapeo de campos de FacturaScripts
> se implementan en iteraciones posteriores. Los services lanzan `Not implemented`.

## Requisitos

- Node.js >= 18
- (Opcional) Docker + Docker Compose
- Una instancia de FacturaScripts con la API activada y una API Key

## Puesta en marcha

```bash
npm install
cp .env.example .env   # en Windows PowerShell: Copy-Item .env.example .env
npm run dev
```

Comprobación rápida:

```bash
curl http://localhost:3000/health        # -> 200 { ok: true, ... }
curl http://localhost:3000/auth/health   # -> 200 { ok: true, ... }
```

Documentación interactiva (Swagger UI): http://localhost:3000/docs

## Scripts

| Script          | Acción                                   |
|-----------------|------------------------------------------|
| `npm run dev`   | Arranque en caliente con ts-node-dev     |
| `npm run build` | Compila TypeScript a `dist/`             |
| `npm start`     | Ejecuta `dist/index.js`                  |
| `npm test`      | Tests con Jest + Supertest               |
| `npm run typecheck` | Chequeo de tipos sin emitir          |

## Variables de entorno

Ver [`.env.example`](.env.example): `PORT`, `NODE_ENV`, `FS_API_URL`, `FS_API_KEY`,
`JWT_SECRET`, `DB_URL`.

## Docker

```bash
docker compose up --build
```

Levanta el servicio `api` y un PostgreSQL (`db`) para la BD propia.

## Estructura

```
src/
  config/      env, logger, database (placeholder)
  routes/      definición de rutas por recurso
  controllers/ orquestan la petición HTTP
  services/    lógica de dominio (+ facturascripts-client central)
  domain/      modelos y tipos
  middleware/  auth (JWT), companyScope, validación, errores
  utils/       http-errors, response, password, pagination
  docs/        Swagger UI
  tests/       Jest + Supertest
```
