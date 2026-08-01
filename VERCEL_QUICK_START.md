# VERCEL QUICK START — conta-api

**Para desplegar y acceder a tu API profesional en Vercel en 5 minutos.**

---

## TL;DR

Tu API conta-api está lista en:  
**https://conta-api-alpha.vercel.app/**

Accede a:
- `https://conta-api-alpha.vercel.app/` — Página principal
- `https://conta-api-alpha.vercel.app/swagger` — Swagger UI interactivo
- `https://conta-api-alpha.vercel.app/api/docs` — Spec OpenAPI JSON

---

## 1️⃣ DESPLEGAR CAMBIOS NUEVOS

### Opción A: Desde GitHub (Automático)

```bash
# En tu máquina local:
cd /c/Users/NACHO PC/Desktop/documntos prueba/facturascripts-api-node

git add .
git commit -m "feat: Add Vercel professional integration (docs, Swagger, dashboard)"
git push origin main

# Vercel despliega automáticamente ✅
# Espera 1-2 minutos, luego abre:
# https://conta-api-alpha.vercel.app/
```

### Opción B: Con Vercel CLI (Manual)

```bash
# Instalas CLI (si no lo tienes)
npm install -g vercel

# Despliegas
vercel deploy --prod

# Vercel te pide confirmación y despliega ✅
```

---

## 2️⃣ VERIFICAR DESPLIEGUE LOCAL ANTES

```bash
# Compilar
npm run build
# Esperado: Sin errores

# Ejecutar localmente
npm run dev
# Esperado: "Listening on port 3000"

# Abrir en navegador
# http://localhost:3000/                (página principal ✅)
# http://localhost:3000/swagger         (Swagger ✅)
# http://localhost:3000/api/docs        (spec ✅)
# http://localhost:3000/api/health      (salud ✅)

# Ctrl+C para detener
```

---

## 3️⃣ URLS DESPUÉS DEL DESPLIEGUE

| URL | Contenido |
|-----|-----------|
| `https://conta-api-alpha.vercel.app/` | Página principal profesional |
| `https://conta-api-alpha.vercel.app/swagger` | Swagger UI (explorador interactivo) |
| `https://conta-api-alpha.vercel.app/api/docs` | Spec OpenAPI JSON |
| `https://conta-api-alpha.vercel.app/api/docs/modules` | Info de módulos |
| `https://conta-api-alpha.vercel.app/api/docs/states` | Máquinas de estado |
| `https://conta-api-alpha.vercel.app/api/docs/validation` | Reglas de validación |
| `https://conta-api-alpha.vercel.app/api/health` | Estado del sistema |
| `https://conta-api-alpha.vercel.app/auth/login` | Login (API) |
| `https://conta-api-alpha.vercel.app/companies/:id/...` | Rutas existentes |

---

## 4️⃣ COMPARTIR CON EQUIPO

Comparte estos links:

```
🌍 PÁGINA PRINCIPAL:
https://conta-api-alpha.vercel.app/

📚 SWAGGER UI (Explorador):
https://conta-api-alpha.vercel.app/swagger

📋 SPEC JSON (Para herramientas):
https://conta-api-alpha.vercel.app/api/docs

✨ TODO A LA VISTA - No necesitas documentación externa.
```

---

## 5️⃣ RESOLVER PROBLEMAS COMUNES

### Problema: Página muestra error 404

**Solución:**
```bash
# Verificar que public/index.html existe
ls -la public/index.html

# Verificar que vercel.json está bien
cat vercel.json | grep outputDirectory
# Debe mostrar: "outputDirectory": "public"

# Redesplegar
vercel deploy --prod
```

### Problema: Swagger UI no carga

**Solución:**
```bash
# Verificar que public/swagger.html existe
ls -la public/swagger.html

# Verificar que CDN de Swagger accesible
curl https://cdn.jsdelivr.net/npm/swagger-ui-dist@3/swagger-ui-bundle.js | head
# Debe retornar JavaScript

# Si falla, verificar CORS
curl -H "Origin: https://conta-api-alpha.vercel.app" \
  https://conta-api-alpha.vercel.app/api/docs | jq .
# Debe retornar JSON válido
```

### Problema: Estilos CSS no cargan

**Solución:**
```bash
# Verificar que public/styles.css existe
ls -la public/styles.css

# Verificar en navegador (F12 → Network)
# Debe haber 200 OK en styles.css

# Si falla, verificar en index.html que reference es:
# <link rel="stylesheet" href="/styles.css">
# NO: <link rel="stylesheet" href="./styles.css">
```

---

## 6️⃣ MANTENER Y ACTUALIZAR

### Si cambias un endpoint:

1. Edita el código en `src/routes/...`
2. Actualiza la documentación en `src/routes/docs.ts` (misma función)
3. Compila: `npm run build`
4. Despliega: `git push origin main` o `vercel deploy --prod`

### Si agregas un nuevo endpoint:

1. Crea ruta en `src/routes/...`
2. Documenta en `src/routes/docs.ts`
3. El endpoint `/api/docs` se actualiza automáticamente
4. Swagger UI lo refleja automáticamente

### Si cambias index.html o styles.css:

1. Edita en `public/`
2. Despliega: `git push origin main` o `vercel deploy --prod`
3. Los cambios aparecen en CDN ~1 segundo después

---

## 7️⃣ MONITOREO EN PRODUCCIÓN

### Ver logs de Vercel:

```bash
# Con CLI
vercel logs https://conta-api-alpha.vercel.app

# O en dashboard:
# https://vercel.com/...  (tu proyecto)
# → Deployments
# → Ver logs
```

### Verificar performance:

```bash
# Con curl
time curl https://conta-api-alpha.vercel.app/api/health

# Esperado:
# - Respuesta < 1s
# - Status 200
# - JSON válido
```

### Chequeo de salud manual:

```bash
curl https://conta-api-alpha.vercel.app/api/health | jq .

# Esperado:
# {
#   "ok": true,
#   "status": "up",
#   "uptime": 12345,
#   "env": { ... }
# }
```

---

## 8️⃣ DOCUMENTOS DE REFERENCIA

Si necesitas más detalles:

- **VERCEL_PROFESSIONAL_INTEGRATION.md** — Diagnóstico + arquitectura (ESTE ES EL PRINCIPAL)
- **VERCEL_IMPLEMENTATION_FINAL.md** — Detalles técnicos completos
- **VERCEL_DEPLOYMENT_CHECKLIST.md** — Checklist paso a paso
- **DOCUMENTACION_FINAL.md** — Documentación técnica completa (modules, tests, etc.)

---

## 9️⃣ CASOS DE USO CON IA

### Generar cliente TypeScript desde spec:

```bash
# Descargar spec
curl https://conta-api-alpha.vercel.app/api/docs -o spec.json

# En Claude:
# "Aquí está mi spec OpenAPI. 
#  Genera un cliente TypeScript que:
#  1. Autentique con /auth/login
#  2. Suba documentos a /companies/:id/income-reader
#  3. Consulte estado"
```

### Validar spec contra servidor:

```bash
# Con herramientas como Dredd
npm install --save-dev dredd

dredd https://conta-api-alpha.vercel.app/api/docs \
  https://conta-api-alpha.vercel.app
```

### Generar tests automáticamente:

```bash
# Con Schemathesis
pip install schemathesis

schemathesis run https://conta-api-alpha.vercel.app/api/docs \
  --base-url https://conta-api-alpha.vercel.app
```

---

## 🔟 RESUMEN

✅ Tu API está en producción con documentación profesional  
✅ Compartir links es lo único necesario  
✅ Actualizaciones se reflejan al redeployer  
✅ Monitoreo simple desde Vercel dashboard  
✅ Listo para ser consumida por clientes/herramientas  

**Siguiente paso:** Comparte los links con tu equipo y ¡disfruta! 🚀

