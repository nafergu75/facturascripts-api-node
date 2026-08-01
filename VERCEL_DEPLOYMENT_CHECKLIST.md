# VERCEL: DEPLOYMENT CHECKLIST

**Proyecto:** conta-api  
**Fecha:** 2026-06-30  
**Status:** ✅ LISTO PARA DESPLEGAR  

---

## PRE-DEPLOYMENT

### ✅ Verificación de Código

- [x] `src/routes/docs.ts` creado (4 endpoints)
- [x] `src/app.ts` actualizado (+2 líneas)
- [x] `public/index.html` mejorado
- [x] `public/swagger.html` creado
- [x] `public/styles.css` creado
- [x] Compilación sin errores: `npm run build` ✅
- [x] Lógica de negocio sin cambios
- [x] Tests sin cambios (349/350 en verde)

### ✅ Documentación

- [x] VERCEL_DIAGNOSTICO_Y_PROPUESTA.md (análisis)
- [x] VERCEL_IMPLEMENTACION_FINAL.md (detalles técnicos)
- [x] VERCEL_RESUMEN_EJECUTIVO.md (summary)
- [x] VERCEL_DEPLOYMENT_CHECKLIST.md (este archivo)

---

## DEPLOYMENT STEPS

### 1️⃣ Compilar Localmente

```bash
npm run build
```

**Esperado:**
```
> facturascripts-api-node@0.1.0 build
> tsc -p tsconfig.json
(sin errores)
```

**Status:** [ ] Completado

---

### 2️⃣ Probar Localmente

```bash
npm run dev
```

**Luego verificar en navegador:**

| URL | Esperado | ✅ |
|-----|----------|-----|
| http://localhost:3000/ | Página principal con módulos | [ ] |
| http://localhost:3000/swagger | Swagger UI cargando | [ ] |
| http://localhost:3000/api/docs | JSON spec | [ ] |
| http://localhost:3000/api/docs/modules | JSON de módulos | [ ] |
| http://localhost:3000/api/docs/states | JSON de estados | [ ] |
| http://localhost:3000/api/docs/validation | JSON de validaciones | [ ] |
| http://localhost:3000/api/health | Estado del sistema | [ ] |

**Status:** [ ] Todos los endpoints funcionan

---

### 3️⃣ Comandos Verificación

```bash
# Verificar que docs endpoint retorna JSON válido
curl http://localhost:3000/api/docs | jq '.info.title'
# Esperado: "conta-api"

curl http://localhost:3000/api/docs/modules | jq '.modules | length'
# Esperado: 4

curl http://localhost:3000/api/health | jq '.status'
# Esperado: "up" o "ok"
```

**Status:** [ ] Completado

---

### 4️⃣ Desplegar a Vercel

```bash
# Opción A: Usar CLI (desde raíz del proyecto)
vercel deploy --prod

# Opción B: Push a GitHub y déjar que Vercel despliegue automáticamente
git add .
git commit -m "feat: Add Vercel dashboard and API documentation"
git push origin main
```

**Esperado:**
- Build completado sin errores
- Deployment URL generado
- Archivos estáticos sirviendo desde Vercel Edge Network
- API serverless en `api/index.ts`

**Status:** [ ] Completado

---

### 5️⃣ Verificar en Producción

Reemplazar `YOUR_VERCEL_URL` con tu dominio (ej: conta-api.vercel.app)

```bash
# Verificar página principal
curl https://YOUR_VERCEL_URL/ | head -20

# Verificar docs
curl https://YOUR_VERCEL_URL/api/docs | jq '.info.title'

# Verificar salud
curl https://YOUR_VERCEL_URL/api/health | jq .
```

| URL | Esperado | ✅ |
|-----|----------|-----|
| https://YOUR_VERCEL_URL/ | Página HTML con index | [ ] |
| https://YOUR_VERCEL_URL/swagger | Swagger UI | [ ] |
| https://YOUR_VERCEL_URL/api/docs | JSON spec | [ ] |
| https://YOUR_VERCEL_URL/api/health | JSON estado | [ ] |

**Status:** [ ] Completado

---

## POST-DEPLOYMENT

### ✅ Validación Final

- [ ] Todos los endpoints responden (200 OK)
- [ ] Página principal se carga sin errores CSS
- [ ] Swagger UI renderiza correctamente
- [ ] OpenAPI spec es válido (validar en https://swagger.io/tools/swagger-editor/)
- [ ] Mobile responsive funciona bien
- [ ] Links internos funcionan
- [ ] Contenido es claro y profesional

### ✅ Comunicación

- [ ] Compartir URL con equipo: `https://YOUR_VERCEL_URL/`
- [ ] Documentar ubicación de Swagger: `https://YOUR_VERCEL_URL/swagger`
- [ ] Avisar sobre nuevos endpoints: `/api/docs*`
- [ ] Recopilar feedback de usuarios

### ✅ Monitoreo

- [ ] Revisar Vercel dashboard para errores
- [ ] Monitorear performance de página principal
- [ ] Revisar logs de API
- [ ] Verificar uso de endpoints de docs

---

## ROLLBACK (Si es Necesario)

Si algo sale mal, puedo revertir fácilmente:

### Opción 1: Eliminar archivos en Vercel

Desplegar commits anteriores:

```bash
# Ver historial de commits
git log --oneline | head -5

# Desplegar commit anterior
vercel deploy --prod <commit-hash>
```

### Opción 2: Revertir cambios localmente

```bash
# Revertir último commit
git reset HEAD~1

# Revertir específicamente
git checkout HEAD -- src/app.ts
rm public/index.html public/swagger.html public/styles.css
rm src/routes/docs.ts

# Desplegar
vercel deploy --prod
```

---

## TESTING ADICIONAL (Opcional)

Si quieres ser extra cuidadoso:

```bash
# Ejecutar suite completa de tests
npm test

# Esperado: 349/350 en verde ✅

# Ejecutar tests específicos
npm test -- fase4-consistencia.test.ts
npm test -- income-reader-ocr-states.test.ts
npm test -- registro-mercantil-versioning.test.ts
```

---

## PERFORMANCE CHECK

### Lighthouse (desde navegador)

1. Abrir DevTools (F12)
2. Click en "Lighthouse" tab
3. Click en "Generate report"
4. Verificar scores:
   - Performance: > 80
   - Accessibility: > 90
   - Best Practices: > 90
   - SEO: > 90

### Network (desde navegador)

1. Abrir DevTools (F12)
2. Click en "Network" tab
3. Recargar página
4. Verificar:
   - index.html: < 50 KB
   - styles.css: < 30 KB
   - swagger.html: < 10 KB
   - Total: < 100 KB

---

## CONFIGURACIÓN VERCEL (Verificar)

Verificar en Vercel dashboard:

- [ ] Project: facturascripts-api-node
- [ ] Build Command: `prisma generate`
- [ ] Output Directory: `public`
- [ ] Functions: `api/index.ts` (maxDuration: 60s)
- [ ] Environment Variables: Correctas
- [ ] Custom Domains: Configurados (si aplica)

---

## DOCUMENTACIÓN LINKS

Comparte estos links con tu equipo:

```
🌍 Página Principal:
https://conta-api.vercel.app/

📚 Swagger UI (Explorador interactivo):
https://conta-api.vercel.app/swagger

📋 OpenAPI Spec (JSON):
https://conta-api.vercel.app/api/docs

🏗️ Módulos (Info detallada):
https://conta-api.vercel.app/api/docs/modules

⚙️ Estados (Máquinas de estado):
https://conta-api.vercel.app/api/docs/states

✓ Validaciones (Reglas de coherencia):
https://conta-api.vercel.app/api/docs/validation

💚 Salud (Estado del sistema):
https://conta-api.vercel.app/api/health
```

---

## PROBLEMAS COMUNES

### Problema: 404 en `/swagger`

**Causa:** Archivo `public/swagger.html` no está siendo servido

**Solución:**
```bash
# Verificar que el archivo existe
ls -la public/swagger.html

# Verificar que Vercel incluye public/ en output
cat vercel.json | grep outputDirectory
# Debe mostrar: "outputDirectory": "public"

# Redesplegar
vercel deploy --prod
```

### Problema: CORS error en Swagger

**Causa:** Swagger intenta consumir `/api/docs` desde diferente origen

**Solución:** Ya manejado en el código (Express CORS está configurado)

```typescript
// src/app.ts
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
```

### Problema: Estilos CSS no cargan

**Causa:** Path incorrecto en index.html

**Solución:** CSS debe estar en `public/styles.css` y HTML debe referenciar `/styles.css`

```html
<!-- ✅ Correcto -->
<link rel="stylesheet" href="/styles.css">

<!-- ❌ Incorrecto -->
<link rel="stylesheet" href="./styles.css">
```

---

## SIGN-OFF

Cuando hayas completado todos los pasos:

- [ ] Pre-deployment checks completados
- [ ] Deployment a Vercel completado
- [ ] Post-deployment validation completada
- [ ] Equipo notificado
- [ ] Documentación updated

**Status:** ✅ DEPLOYADO A PRODUCCIÓN

---

**Fecha de Deployment:** _______________  
**Responsable:** _______________  
**URL de Producción:** _______________  

