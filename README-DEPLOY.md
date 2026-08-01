# Despliegue en Vercel — checklist

API Express + Prisma (MySQL) como función serverless en Vercel. Todo lo del
**código** ya está preparado (entrypoint, `vercel.json`, almacenamiento en Blob,
build de producción verde). Lo que queda son pasos en **tu** cuenta de Vercel.

> El despliegue lo ejecutas tú: requiere iniciar sesión en tu cuenta de Vercel
> (`vercel login`, en tu navegador). Pega aquí el output o cualquier error y lo
> diagnosticamos.

---

## 0. Lo que ya está hecho en el repo (no tocar)

- `api/index.ts` — entrypoint serverless: reexporta la app Express (`export default app`), sin `listen`.
- `vercel.json` — `maxDuration: 60` + rewrite `/(.*)` → `/api`.
- `package.json` — `postinstall: prisma generate` y `vercel-build: prisma generate`.
- `src/utils/storage.ts` — almacenamiento con 2 backends: **Vercel Blob** si existe
  `BLOB_READ_WRITE_TOKEN`, **disco local** en dev. Lo usan lector (income-reader),
  Registro Mercantil y el lector legacy. **Ningún flujo escribe a disco directo.**
- `src/index.ts` — sigue valiendo para local (`npm run dev`).

---

## 1. Base de datos MySQL en la nube (antes de desplegar)

`localhost` NO vale en Vercel. Crea una MySQL gestionada y copia su URL:

- **Railway** (recomendado, simple, FKs estándar) · **Aiven** · **Clever Cloud**.
- PlanetScale solo si quieres su escalado: requiere `relationMode = "prisma"` en
  `schema.prisma` (no soporta FKs igual) → más fricción con el schema actual.

Formato de `DATABASE_URL` (añade `connection_limit=1` para serverless):

```
mysql://user:pass@host:3306/dbname?connection_limit=1&pool_timeout=20&sslaccept=strict
```

**Crear las tablas en la BD remota** (una vez, desde tu máquina; el proyecto usa
`db push`, no migraciones):

```powershell
# PowerShell
$env:DATABASE_URL="mysql://...prod..."; npx prisma db push
$env:DATABASE_URL="mysql://...prod..."; npm run db:seed   # opcional: empresa/usuario demo
```

Repite el `db push` cada vez que cambies `prisma/schema.prisma`.

---

## 2. Crear el proyecto en Vercel (Dashboard)

1. Sube el repo a GitHub/GitLab/Bitbucket y haz push.
2. vercel.com → **Add New… → Project → Import** tu repositorio.
3. **Framework Preset: Other** (NO Next.js).
4. **Root Directory: `facturascripts-api-node`** (Edit → selecciona la carpeta del backend).
5. **Build & Development Settings**:
   - Build Command: `prisma generate` (o deja el `vercel-build`).
   - Output Directory: **vacío**.
   - Install Command: `npm install` (dispara el `postinstall`).
6. **Deploy**.

---

## 3. Almacenamiento de ficheros (Vercel Blob)

1. Proyecto → **Storage → Create Database → Blob** → conéctalo al proyecto.
2. Eso inyecta `BLOB_READ_WRITE_TOKEN` automáticamente (no lo copies a mano).
3. Con el token presente, subidas del lector y PDFs/ZIP del Registro Mercantil se
   guardan en Blob y las descargas funcionan vía URL. Sin token, escribiría a
   disco (no persiste en serverless) — por eso este paso es necesario en Vercel.

---

## 4. Variables de entorno (Settings → Environment Variables)

Márcalas para Production/Preview. **No** pongas `PORT`.

| Variable | Valor |
|---|---|
| `DATABASE_URL` | la URL MySQL de la nube del paso 1 |
| `JWT_SECRET` | tu secreto fuerte |
| `ENCRYPTION_KEY` | tu clave AES 64-hex |
| `ANTHROPIC_API_KEY` | tu `sk-ant-...` real (para el OCR del lector) |
| `NODE_ENV` | `production` |
| `CORS_ORIGIN` | dominios reales del frontend (coma-separados) |
| `FS_API_URL` / `FS_API_KEY` | solo si usas el spine FacturaScripts (hoy opcional) |
| `BLOB_READ_WRITE_TOKEN` | lo añade solo el Blob store (paso 3) |

---

## 5. Prisma en producción

- `postinstall: prisma generate` ya evita el error "outdated Prisma Client" en builds cacheadas.
- Esquema: gestionado con `prisma db push` desde local (paso 1). NO lo pongas en
  `postinstall`. Si en el futuro adoptas migraciones versionadas:
  ```bash
  DATABASE_URL="<prod>" npx prisma migrate deploy
  ```

---

## 6. Deploy con Vercel CLI

```bash
cd facturascripts-api-node
git add . && git commit -m "feat: vercel-ready" && git push

npm i -g vercel
vercel login            # inicias sesión TÚ en tu navegador

vercel                  # preview
# prompts: Set up and deploy? Y · scope: tu cuenta · Link to existing? N (1ª vez)
#          project name: Enter · directory: ./ · no sobrescribir settings

vercel --prod           # producción (URL estable)
```

- URL **preview** = cada deploy (pruebas). URL **producción** = la de `--prod`.
- Logs: `vercel logs <url>` o Dashboard → Deployments → Functions.

---

## 7. Verificar tras desplegar

```bash
# 1) salud + que las env vars llegaron (deben salir en true)
curl https://<proyecto>.vercel.app/health

# 2) login (si corriste el seed: demo@empresa.com / demo1234)
curl -X POST https://<proyecto>.vercel.app/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@empresa.com","password":"demo1234"}'

# 3) una ruta autenticada
TOKEN=...   # del login
curl https://<proyecto>.vercel.app/companies/1/income-reader/pending \
  -H "Authorization: Bearer $TOKEN"
```

`/health` devuelve `env: { DATABASE_URL: true, JWT_SECRET: true, ANTHROPIC_API_KEY: true, ... }`.
Si algo sale `false`, falta esa variable en Vercel. (Nota: reporta si la variable
EXISTE, no si es válida — `ANTHROPIC_API_KEY` saldrá `true` aunque sea placeholder;
el OCR la trata como "sin clave" si no empieza por `sk-ant-` real.)

---

## Limitaciones de Vercel para esta API (tenlas presentes)

- **Estado en memoria** (series, subcuentas de plan contable, rate-limit, fallback
  de auditoría, Map del lector legacy) **no persiste** entre invocaciones serverless.
  Lo que va por Prisma/Blob sí.
- **Tiempos**: `maxDuration` 60 s (Hobby) / 300 s (Pro). El OCR con Claude y las
  llamadas a FacturaScripts pueden acercarse al límite. Hay **cold starts**.
- Si esos puntos te molestan, **Railway/Render** (proceso largo) encajan mejor con
  el mismo código y la misma BD; el almacenamiento en Blob también funciona allí.
```
