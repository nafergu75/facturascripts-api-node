# QA Phase 1 — Status & Next Steps

## 📊 Checklist estado

| Componente | Status | Blocker? |
|---|---|---|
| **Backend (BFF)** | ✅ Prod en Vercel | No |
| **Database** | ✅ Railway MySQL | No |
| **Carmen RAG** | ✅ Prod con Opus 4.8 | No |
| **Chakra build** | ✅ Local ok | No |
| **Chakra deploy** | ⏳ Ready (no exec) | **Next** |
| **Data migration** | ✅ Scripts ready | Next+1 |
| **E2E tests** | ⏳ Manual solo | Next+2 |

---

## 🎯 Tu misión: QA Fase 1 (Deploy Chakra)

**Duración esperada:** 30-45 min (1-2 pauses)

**Orden de pasos (pausa entre cada uno):**

### Pausa 1️⃣ : Configurar env Chakra

```bash
cd frontend-chakra
cp .env.example .env.local
# Editar .env.local si quieres cambiar API_BASE_URL
# (por ahora: localhost:3000, ok para dev)
```

**Punto de decisión:** ¿Usamos API_BASE_URL local o creamos staging BFF?
- **Si local:** Chakra apunta a localhost:3000 (BFF dev), rápido pero no aislado
- **Si staging:** Chakra apunta a `conta-api-staging.vercel.app` (BFF staging), más limpio pero requiere 2da BD en Railway

**Recomendación:** empezar con LOCAL (localhost:3000), luego migrar a staging si QA lo pide.

---

### Pausa 2️⃣ : Validar build

```bash
npm run build:chakra
# Verificar: ✓ built in ~1s, sin errores
ls frontend-chakra/dist/index.html  # debe existir
```

---

### Pausa 3️⃣ : Deploy a Vercel

```bash
cd frontend-chakra
# Opción A: CLI (rápido)
vercel --prod --name conta-api-chakra-staging

# Opción B: GitHub Actions (automático en cada push)
# (requiere estar en GitHub, rama feature/chakra-staging)
```

**Output esperado:** URL tipo `https://conta-api-chakra-staging-xxxxx.vercel.app`

---

### Pausa 4️⃣ : Test smoke (navegador)

1. Abre https://conta-api-chakra-staging.vercel.app
2. ¿Carga sin error?
   - Sí → siguiente paso
   - No (404) → revisar URL
   - No (error API) → revisar VITE_API_BASE_URL
3. Click "Login"
4. Enter `demo@empresa.com` / `demo1234`
5. ¿Entra a dashboard?
   - Sí → ✅ **Chakra deploy exitoso**
   - No → revisar console.log en DevTools

---

## 📋 Documentación lista

| File | Propósito |
|---|---|
| `DEPLOY_CHAKRA.md` | Step-by-step deployment (leelo antes de cada paso) |
| `frontend-chakra/.env.example` | Variables de env |
| `FINAL_CHECKLIST.md` | Checklist completo para toda QA |
| `QA_STATUS.md` | Este archivo |

---

## ⏸️ Pausa actual: **PAUSA 1️⃣ **

**Acción esperada:** 
1. Revisar `DEPLOY_CHAKRA.md` Paso 1
2. Decidir: ¿env local (localhost) o staging (Vercel)?
3. Reportar decisión → continue con Pausa 2️⃣

**No continuar hasta que digas:**
- [ ] Configuré .env.local
- [ ] Decidí: local 📍 o staging ☁️
