# Deploy Chakra a Vercel — Paso a paso (QA Fase 1)

## Estado actual

- ✅ Build local ok (`npm run build:chakra`)
- ✅ TypeScript limpio
- ⚠️ Falta deploy a Vercel
- ⚠️ Falta env var API_BASE_URL para staging

## Pasos para deploy

### Paso 1: Configurar staging env (AQUÍ, sin deploy)

**Objetivo:** preparar variable de entorno para staging.

```bash
# 1a. Verificar que existe .env.example
cat frontend-chakra/.env.example

# 1b. Crear .env.local para staging (NO commitear)
cd frontend-chakra
cp .env.example .env.local
# Editar .env.local:
# VITE_API_BASE_URL=https://conta-api-staging-[TU-PROYECTO].vercel.app/api
# (todavía no sabemos la URL de staging del BFF)
```

**Estado:** env preparado, build no tiene cambios (sigue usando localhost)

---

### Paso 2: Build production de Chakra (AQUÍ, sin Vercel)

**Objetivo:** verificar que el build de prod no tiene errores.

```bash
cd frontend-chakra
npm run build:chakra
# Output esperado:
# ✓ built in 1.06s
# (ignorar warnings de size, es normal para Chakra+React)

# Verificar artefacto
ls -lh dist/
# dist/ existe con index.html + assets/
```

**Estado:** build production listo en `frontend-chakra/dist/`

---

### Paso 3: Setup Vercel (AQUÍ, no deploying)

**Objetivo:** preparar Vercel para staging, SIN cambiar prod BFF.

**Opción A: Vercel CI/CD desde GitHub** (recomendado si ya está pushado)

```bash
# Ya existe nafergu75 en Vercel con conta-api (BFF)
# Agregar NUEVO proyecto para frontend-chakra:
# 1. GitHub: forwardear o crear rama feature/chakra-staging
# 2. Vercel: importar repo -> select "frontend-chakra" como root dir
# 3. Result: https://conta-api-front-[slug].vercel.app (staging)
```

**Opción B: Vercel CLI local** (más control inmediato)

```bash
cd frontend-chakra
npm install -g vercel
vercel login  # (ya deberías estar logueado)
vercel --prod --name conta-api-chakra-staging
# Output: URL staging
# Copiar URL a .env.local -> VITE_API_BASE_URL=https://conta-api-chakra-staging.vercel.app/api
```

**Estado:** staging project creado en Vercel, con URL conocida

---

### Paso 4: Deploy Chakra a Vercel (EL DEPLOY)

**Cuándo:** después que hayas hecho Pasos 1-3 y tengas URL staging.

```bash
cd frontend-chakra

# 4a. Actualizar .env.local con URL BFF staging (si existe)
# VITE_API_BASE_URL=https://conta-api-staging.vercel.app/api

# 4b. Build local final
npm run build:chakra

# 4c. Desplegar
vercel --prod --name conta-api-chakra-staging

# Output:
# ✅ Production: https://conta-api-chakra-staging.vercel.app
```

**Estado:** Chakra en Vercel staging, accesible desde navegador

---

### Paso 5: Test smoke (POST-DEPLOY)

**Cuándo:** después del deploy, antes de QA.

```bash
# 5a. Navegar a https://conta-api-chakra-staging.vercel.app
# 5b. Verificar que carga (no 404 ni error)
# 5c. Click "Login" → intenta POST /auth/login
#     (fallará si API_BASE_URL es incorrecta o BFF staging no existe)
# 5d. Si error: revisar console.log(error) en dev tools
# 5e. Si login ok: navegador a /sales/clientes (debe cargar tabla)
```

---

## Decisiones pre-deploy

**Q: ¿Cuál es la URL del BFF staging?**
- Hoy: solo existe BFF prod (`conta-api-nafergu75s-projects.vercel.app`)
- Opción 1: usar directamente prod (riesgo: contamina prod con datos QA)
- Opción 2: crear staging BFF (`conta-api-staging.vercel.app` con OTRA instancia DB)
- **Recomendado:** Opción 2, pero requiere:
  - Segunda Railway BD (DATABASE_URL_STAGING)
  - Segundo proyecto Vercel para BFF (si quieres separar)

**Q: ¿Con qué datos testo?**
- Demo BD actual: `demo@empresa.com/demo1234`, empresa '1'
- Test data: mantener o crear fresh?
- **Recomendado:** usar demo actual hasta pasar QA, luego reset con datos reales

---

## Resumen: Qué hacer AHORA

1. ✅ Build local: HECHO (`frontend-chakra/dist/`)
2. ⏳ **Paso 1 (Pausa 1):** Configurar .env.local staging
3. ⏳ **Paso 2 (Pausa 2):** Validar build production
4. ⏳ **Paso 3 (Pausa 3):** Crear staging project en Vercel
5. ⏳ **Paso 4 (Pausa 4):** Deploy (`vercel --prod`)
6. ⏳ **Paso 5 (Pausa 5):** Test smoke

---

## Comandos cheat-sheet

```bash
# DEV local (localhost:5174 + localhost:3000 BFF)
npm run dev:chakra

# Build prod (sin deploy)
npm run build:chakra

# Deploy a Vercel (requiere Paso 1-3)
vercel --prod

# Ver logs Vercel
vercel logs https://conta-api-chakra-staging.vercel.app
```
