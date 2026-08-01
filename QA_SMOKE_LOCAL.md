# QA Local Smoke Test — Pausa 1️⃣

**Prerequisitos:**
- [x] .env.local configurado (`VITE_API_BASE_URL=http://localhost:3000`)
- [x] BFF corriendo en terminal 1: `npm run dev` (puerto 3000)
- [x] Chakra corriendo en terminal 2: `npm run dev:chakra` (puerto 5174)

---

## Test 1: ¿Carga Chakra sin errores?

**Qué hacer:**
1. Abre navegador → `http://localhost:5174`
2. Espera a que cargue (5-10s)

**Esperado:**
- ✅ Página carga sin 404
- ✅ Logo/navbar visible
- ✅ Button "Login" visible

**Si error (⚠️):**
- Network error → BFF no está corriendo
- 404 → revisar puertos (¿5174 está en uso?)
- CORS error → revisar VITE_API_BASE_URL en .env.local

---

## Test 2: ¿Login funciona?

**Qué hacer:**
1. Click button "Login"
2. Enter: `demo@empresa.com`
3. Password: `demo1234`
4. Click "Ingresar"

**Esperado:**
- ✅ Redirige a dashboard (Home)
- ✅ Navbar muestra empresa/usuario
- ✅ Menú lateral visible (Sales, Accounting, etc.)

**Si error (⚠️):**
- Error 401 → credenciales inválidas (¿BD MySQL corriendo?)
- Error 503 (Backend unavailable) → BFF no está o BD no está
- CORS error → revisar BFF headers

---

## Test 3: ¿Cargan páginas clave?

**Click cada enlace, espera 2-3s, verifica que carga sin error:**

| Página | URL | Esperado |
|---|---|---|
| Clientes | /sales/clientes | Tabla de clientes (demo@empresa.com) |
| Facturas | /sales/facturas | Lista facturas (vacía o con demos) |
| Cuentas bancarias | /tesoreria/cuentas | Tabla de cuentas (vacía) |
| Contabilidad | /accounting/cierres | Rejilla meses 2026 |
| Carmen | Chat icon esquina | Drawer con input de preguntas |

**Si alguno falla (⚠️):**
- 404 → ruta no existe (revisar AppRoutes)
- Spinner infinito → API lenta o timeout
- Error en console → revisar DevTools Network tab

---

## Test 4: ¿Carmen funciona?

**Qué hacer:**
1. Click chat icon (esquina inferior derecha)
2. Drawer abre
3. Type: "¿Cuándo vence el IVA?"
4. Click send

**Esperado:**
- ✅ Respuesta en 3-5s
- ✅ Sources listadas (iva.md, etc.)
- ✅ Suggestions generadas

**Si error (⚠️):**
- No responde → ANTHROPIC_API_KEY falta o sin créditos
- Error 500 → KB no cargó
- Degraded mode (naranja) → OK pero sin LLM real

---

## Test 5: ¿API responde bien?

**En DevTools Network tab:**
- POST /auth/login → 200 (JWT en response)
- GET /companies/1/clientes → 200 (lista vacía o con datos)
- GET /companies/1/facturas → 200

**Esperado:**
- ✅ Status 200 para GET/POST
- ✅ Response JSON válido
- ✅ Sin errores 5xx

**Si error (⚠️):**
- 503 → BD unavailable (MySQL XAMPP down)
- 401 → JWT inválido
- 400 → request malformado

---

## Resumen post-tests

| Test | Status | Blocker? |
|---|---|---|
| Chakra load | ✅/⚠️ | Si 404 |
| Login | ✅/⚠️ | Si 401/503 |
| Sales pages | ✅/⚠️ | Si timeouts |
| Accounting | ✅/⚠️ | Si 404 |
| Carmen | ✅/⚠️ | Si 500 |
| API calls | ✅/⚠️ | Si 5xx |

---

## Next step

✅ Si todos pasan → **Pausa 2️⃣ completada**, puedes proceder a **Pausa 3️⃣ (deploy)**

⚠️ Si algunos fallan → Debug using:
- DevTools Network tab (API errors)
- DevTools Console (JS errors)
- Terminal logs (BFF errors, MySQL connection)

Reporta qué falló y continuamos.
