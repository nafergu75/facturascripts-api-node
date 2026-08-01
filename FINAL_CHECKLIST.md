# Pre-UAT: Checklist para pruebas

## ✅ Backend (completo)

- [x] Typecheck limpio (233/233 tests, 30 suites)
- [x] npm run build funciona
- [x] Vercel prod: https://conta-api-nafergu75s-projects.vercel.app (/health 200)
- [x] Variables env en Vercel: ANTHROPIC_API_KEY (con créditos), DATABASE_URL
- [x] Carmen RAG: en prod con KB 5 fuentes, Opus 4.8

## ⚠️ Frontend Chakra (ready for staging)

- [x] Vite build: `npm run build:chakra`
- [ ] Deploy a Vercel (staging o prod)
- [ ] URL staging: ? (no mencionado)
- [ ] Verificar VITE_API_BASE_URL apunta a `/api` (Vercel) o BFF local

## ⚠️ Data (pre-migración requerida)

- [x] Scripts migration listos: `npm run migrate:fs:dry`
- [ ] Ejecutar migración en FS_DATA TEST: clientes/proveedores/productos FS → Prisma
- [ ] Ejecutar reconciliación: `npm run reconcile:clientes:dry`
- [ ] Resolver NIFs duplicados: `npm run check:fs-duplicates`

## ⚠️ Local infra (para QA manual)

- [ ] MySQL XAMPP arrancado
- [ ] FS levantado: `cd facturascripts && php -S localhost:8000 index.php`
- [ ] BFF dev: `npm run dev` (puerto 3000)
- [ ] Chakra dev: `npm run dev:chakra` (puerto 5174)
- [ ] Login demo@empresa.com/demo1234 funciona

## ⚠️ E2E smoke test (post-deploy)

- [ ] Health check: GET /health 200
- [ ] Auth: POST /auth/login (demo@empresa.com) → JWT
- [ ] API sample: GET /companies/1/facturas (auth required)
- [ ] Chakra: /sales/clientes lista y crea clientes
- [ ] Carmen: pregunta IVA → respuesta con sources

## 📋 Next steps (orden de prioridad)

1. **Deploy Chakra a Vercel** (staging o prod aparte del BFF)
   ```bash
   cd frontend-chakra
   npm run build:chakra
   vercel --prod  # o vercel (draft deploy)
   ```

2. **Migración de datos REAL** (en test/staging primero)
   ```bash
   # Dry-run
   npm run migrate:fs:dry
   # Revisar output
   # Resolver NIFs duplicados si hay
   npm run check:fs-duplicates
   # Ejecutar migración
   npm run migrate:fs
   # Reconciliar
   npm run reconcile:clientes:dry
   npm run reconcile:clientes
   ```

3. **Test suite E2E** (post-deploy)
   - Usuarios reales (no demo) en staging
   - Crear facturas reales (Chakra)
   - Consultar asientos en /accounting
   - Descargar Modelo 200
   - Prueba Carmen con preguntas reales

4. **Documentación runbook** (para el equipo)
   - Cómo levantar local
   - Cómo desplegar cambios
   - Cómo hacer data migration
   - Troubleshooting común

## 🚨 Riesgos conocidos

- FS legacy inerte (pedidos/albaranes/presupuestos/inventario archivados) → no tocar
- Clientes FS vs Prisma: 2 tiendas separadas → reconciliar antes de prod
- CSV decimal: fix aplicado, pero probar con CSV real español (`;` separator)
- Vercel: env vars case-sensitive en prod, cambios requieren redeploy

## 📊 Métricas ready-for-QA

- Typecheck: ✅ 0 errors
- Tests: ✅ 233/233 passed
- Build: ✅ npm run build ok
- Chakra E2E: ⚠️ dev preview ok, prod deploy pending
- Data: ⚠️ migration scripts ready, execution pending
- Carmen: ✅ prod with real LLM (Opus 4.8)
