# Checklist de Integración: Facturas de Ingreso + Lector OCR

**Objetivo:** Integrar los servicios, controladores y rutas en la app Express existente.

---

## ✅ Fase 1: Verificación de código

### 1.1 Verificar servicios

```bash
# Asegurar que existen y son importables
ls -la src/services/income-invoices.service.ts
ls -la src/services/income-reader.service.ts

# Verificar imports (sin errores de tipo)
npm run typecheck
```

**Checklist:**
- [ ] `income-invoices.service.ts` existe
- [ ] `income-reader.service.ts` existe
- [ ] Ambos se importan sin errores
- [ ] Tipos TypeScript son correctos

### 1.2 Verificar controladores

```bash
ls -la src/controllers/income-invoices.controller.ts
ls -la src/controllers/income-reader.controller.ts
```

**Checklist:**
- [ ] `income-invoices.controller.ts` existe
- [ ] `income-reader.controller.ts` existe
- [ ] Importan servicios correctamente

### 1.3 Verificar rutas

```bash
ls -la src/routes/income-invoices.routes.ts
ls -la src/routes/income-reader.routes.ts
```

**Checklist:**
- [ ] `income-invoices.routes.ts` existe
- [ ] `income-reader.routes.ts` existe
- [ ] Importan controladores correctamente

---

## ✅ Fase 2: Actualización del Schema Prisma

### 2.1 Verificar modelos

```bash
# Verificar que el schema tiene los nuevos modelos
grep -n "^model Customer" prisma/schema.prisma
grep -n "^model IncomeInvoice" prisma/schema.prisma
grep -n "^model IncomeInvoiceLine" prisma/schema.prisma
grep -n "^model IncomeReaderDocument" prisma/schema.prisma
grep -n "^model ReaderEmailConfig" prisma/schema.prisma
```

**Checklist:**
- [ ] `Customer` model existe
- [ ] `IncomeInvoice` model existe
- [ ] `IncomeInvoiceLine` model existe
- [ ] `IncomeReaderDocument` model existe
- [ ] `ReaderEmailConfig` model existe

### 2.2 Generar cliente Prisma

```bash
npm run prisma:generate
```

**Checklist:**
- [ ] No hay errores de schema
- [ ] Tipos Prisma se actualizan en `node_modules/.prisma/client`

### 2.3 Crear/ejecutar migración

```bash
# Ver cambios pendientes
npx prisma migrate dev --name add-income-invoices

# O push directo (solo desarrollo)
npm run db:push
```

**Checklist:**
- [ ] Migración creada sin errores
- [ ] BD actualizada con nuevas tablas
- [ ] Sin conflictos de schema

---

## ✅ Fase 3: Integración en Express

### 3.1 Actualizar `src/app.ts` o `src/index.ts`

Buscar donde se registran las rutas:

```typescript
// Antes (existente):
import facturaRoutes from './routes/facturas.routes';
app.use('/api/facturas', facturaRoutes);

// Después (agregar):
import incomeInvoicesRoutes from './routes/income-invoices.routes';
import incomeReaderRoutes from './routes/income-reader.routes';

app.use('/api/invoices', incomeInvoicesRoutes);
app.use('/api/income-reader', incomeReaderRoutes);
```

**Checklist:**
- [ ] Imports agregados
- [ ] `app.use()` para ambas rutas agregado
- [ ] No hay duplicadas (income-invoices + invoice/facturas)

### 3.2 Verificar middleware

Las rutas ya incluyen:
- ✅ `authorize()` — para validar permisos
- ✅ `asyncHandler()` — para manejo de errores

**Checklist:**
- [ ] Middleware `authorize` existe en `src/middleware/authorize.middleware`
- [ ] Middleware `asyncHandler` existe en `src/utils/async-handler`
- [ ] Usuario tiene permisos `ventas:write` y `admin`

### 3.3 Compilar TypeScript

```bash
npm run build
```

**Checklist:**
- [ ] Sin errores de compilación
- [ ] `dist/` contiene código compilado

---

## ✅ Fase 4: Testing básico

### 4.1 Iniciar servidor

```bash
npm run dev
```

**Expected output:**
```
API escuchando en http://localhost:3000 (development)
Swagger UI en http://localhost:3000/docs
```

**Checklist:**
- [ ] Servidor inicia sin crashes
- [ ] Puerto 3000 disponible
- [ ] Swagger doc cargable

### 4.2 Health check

```bash
curl http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" | jq .
```

**Expected:**
```json
{
  "items": [],
  "total": 0,
  "skip": 0,
  "take": 20
}
```

**Checklist:**
- [ ] Endpoint responde (200 OK)
- [ ] Estructura correcta
- [ ] Vacío inicial (sin datos)

### 4.3 Crear cliente test

```bash
curl -X POST http://localhost:3000/api/customers \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "nombreFiscal": "Test Client",
    "nifCif": "B99999999",
    "email": "test@example.com"
  }' | jq .
```

**Expected:**
```json
{
  "customer": {
    "id": "cust-uuid-...",
    "nombreFiscal": "Test Client",
    "nifCif": "B99999999",
    ...
  }
}
```

**Checklist:**
- [ ] Cliente creado (201)
- [ ] ID retornado
- [ ] BD actualizada

### 4.4 Crear factura test

Ver `docs/CURL_EXAMPLES.md` → Sección "2. Crear factura de ingreso"

```bash
curl -X POST http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "{CUSTOMER_ID}"},
    "serie": "2024",
    "numero": 1,
    "lineas": [
      {
        "descripcion": "Test",
        "cantidad": 1,
        "precioUnitario": 100,
        "tipoIva": 21
      }
    ]
  }' | jq .
```

**Expected:**
```json
{
  "invoice": {
    "id": "inv-uuid-...",
    "numeroCompleto": "2024-1",
    "estado": "PENDING",
    "baseTotal": 100,
    "ivaTotal": 21,
    "totalFactura": 121,
    "lineas": [...]
  }
}
```

**Checklist:**
- [ ] Factura creada (201)
- [ ] ID retornado
- [ ] Totales calculados correctamente
- [ ] Estado = PENDING

### 4.5 Listar facturas

```bash
curl http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" | jq .
```

**Expected:**
```json
{
  "items": [{...factura...}],
  "total": 1,
  "skip": 0,
  "take": 20
}
```

**Checklist:**
- [ ] Lista contiene la factura creada
- [ ] Total = 1
- [ ] Campos correctos

### 4.6 Cambiar estado

```bash
curl -X PATCH http://localhost:3000/api/invoices/income/{INVOICE_ID}/status \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"estado": "PAID"}' | jq .
```

**Expected:**
```json
{
  "invoice": {
    "id": "inv-uuid-...",
    "estado": "PAID",
    ...
  }
}
```

**Checklist:**
- [ ] Estado actualizado (200)
- [ ] estado = PAID

### 4.7 Subir documento OCR

```bash
curl -X POST http://localhost:3000/api/income-reader/mobile-upload \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: image/jpeg" \
  --data-binary @/ruta/a/imagen.jpg | jq .
```

**Expected:**
```json
{
  "document": {
    "id": "doc-uuid-...",
    "sourceType": "MOBILE_CAMERA",
    "status": "UPLOADED",
    "uploadedAt": "2024-06-13T..."
  }
}
```

**Checklist:**
- [ ] Documento creado (201)
- [ ] status = UPLOADED
- [ ] ID retornado

### 4.8 Listar pendientes

```bash
curl http://localhost:3000/api/income-reader/pending \
  -H "Authorization: Bearer {TOKEN}" | jq .
```

**Expected (después de ~2 segundos de OCR):**
```json
{
  "documents": [{
    "id": "doc-uuid-...",
    "status": "READY_FOR_VERIFICATION",
    "parsedData": {...}
  }],
  "cantidad": 1
}
```

**Checklist:**
- [ ] Documento aparece en pendientes
- [ ] status = READY_FOR_VERIFICATION (después del delay OCR)
- [ ] parsedData presente

---

## ✅ Fase 5: Validaciones avanzadas

### 5.1 Numeración única

Intenta crear dos facturas con misma serie+numero:

```bash
curl -X POST http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "{CUSTOMER_ID}"},
    "serie": "2024",
    "numero": 1,  # Duplicado
    "lineas": [...]
  }'
```

**Expected:**
```json
{
  "status": "error",
  "message": "Factura 2024-1 ya existe."
}
```

**Checklist:**
- [ ] Rechaza duplicado (400)
- [ ] Mensaje claro

### 5.2 Cálculos complejos

Crear con descuentos, IVA, retenciones:

```bash
curl -X POST http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "{CUSTOMER_ID}"},
    "serie": "2024",
    "numero": 2,
    "lineas": [
      {
        "descripcion": "Línea 1",
        "cantidad": 10,
        "precioUnitario": 100,
        "descuentoPorcentaje": 10,
        "tipoIva": 21,
        "tipoRetencion": 15
      }
    ]
  }' | jq '.invoice | {baseTotal, ivaTotal, retencionTotal, totalFactura}'
```

**Expected calculations:**
```
pvpSinDescuento = 10 × 100 = 1000
descuentoImporte = 1000 × 10% = 100
baseLine = 1000 - 100 = 900
ivaImporte = 900 × 21% = 189
retencionImporte = 900 × 15% = 135
totalFactura = 900 + 189 - 135 = 954

Output:
{
  "baseTotal": 900,
  "ivaTotal": 189,
  "retencionTotal": 135,
  "totalFactura": 954
}
```

**Checklist:**
- [ ] Cálculos correctos (sin errores de redondeo)
- [ ] Todas las líneas sumadas correctamente

### 5.3 Estado automático

Crear con fechaVencimiento < hoy:

```bash
curl -X POST http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "{CUSTOMER_ID}"},
    "serie": "2024",
    "numero": 3,
    "fechaEmision": "2024-01-01",
    "fechaVencimiento": "2024-01-10",  # Pasada
    "lineas": [...]
  }' | jq '.invoice.estado'
```

**Expected:**
```
"OVERDUE"
```

**Checklist:**
- [ ] Estado = OVERDUE (automático)
- [ ] No requiere pasar estado en request

### 5.4 Auditoría

Buscar en BD:

```bash
# En MySQL
SELECT * FROM AuditLog WHERE action LIKE '%FACTURA%' ORDER BY timestamp DESC;
```

**Expected:**
```
| id | action | resourceId | meta |
| ... | CREAR_FACTURA_INGRESO | inv-uuid-... | {...} |
| ... | CAMBIAR_ESTADO_FACTURA_INGRESO | inv-uuid-... | {...} |
```

**Checklist:**
- [ ] AuditLog contiene acciones
- [ ] Meta fields con datos relevantes

---

## ✅ Fase 6: Documentación

### 6.1 Verificar archivos de doc

```bash
ls -la docs/INCOME_INVOICES_API.md
ls -la docs/ARCHITECTURE_INVOICES.md
ls -la docs/CURL_EXAMPLES.md
ls -la IMPLEMENTATION_SUMMARY.md
```

**Checklist:**
- [ ] Todos los documentos existen
- [ ] Contenido completo
- [ ] Ejemplos funcionan

### 6.2 Swagger/OpenAPI

Si tienes swagger-ui-express:

```bash
curl http://localhost:3000/docs
```

**Checklist:**
- [ ] Rutas nuevas aparecen en Swagger
- [ ] Esquemas definidos
- [ ] Métodos HTTP correctos

---

## ✅ Fase 7: Limpieza y optimización

### 7.1 Imports

```bash
# Buscar imports no usados
npm run typecheck
```

**Checklist:**
- [ ] Sin warnings
- [ ] Sin imports dangling

### 7.2 Tests

```bash
npm run test
```

**Checklist:**
- [ ] Tests existentes pasan
- [ ] Sin regressions

### 7.3 Build

```bash
npm run build
npm run start
```

**Checklist:**
- [ ] Build sin errores
- [ ] Server inicia en modo producción

---

## ✅ Fase 8: Verificación final

### Checklist resumen

- [ ] Código compilado sin errores
- [ ] BD migrada con nuevos modelos
- [ ] Rutas registradas en Express
- [ ] Server inicia sin crashes
- [ ] GET /invoices/income responde
- [ ] Crear factura funciona
- [ ] Cálculos correctos
- [ ] Estados auto-determinados
- [ ] Numeración validada
- [ ] OCR pipeline funciona
- [ ] Documentación completa
- [ ] Ejemplos testeados
- [ ] Auditoría registra cambios
- [ ] Sin regressions en existentes

---

## 🚀 Go-live

Una vez completado el checklist anterior:

```bash
# 1. Commit de cambios
git add .
git commit -m "feat: income invoices & OCR reader API"

# 2. Build final
npm run build

# 3. Deployar
# (Según tu pipeline CI/CD)

# 4. Smoke test en prod
curl https://api.tuapp.com/api/invoices/income \
  -H "Authorization: Bearer {TOKEN}"
```

**Checklist final:**
- [ ] Cambios commiteados
- [ ] Build compilado
- [ ] Deployed a producción
- [ ] Health check pasa

---

## 📞 Troubleshooting

| Problema | Solución |
|----------|----------|
| `Module not found: income-invoices.service` | Verificar ruta exacta: `src/services/income-invoices.service.ts` |
| `Prisma schema error` | Ejecutar `npm run prisma:generate` |
| `UNIQUE constraint failed` | Numeración duplicada o NIF cliente duplicado |
| `401 Unauthorized` | Verificar JWT token válido y permisos |
| `500 Internal Server Error` | Ver logs del servidor, debugger activo |
| `OCR nunca completa` | Delay de 2s en procesamiento, esperar o logs error |

---

## ✨ Próximos pasos post-integración

1. **Frontend:** Integrar componentes React para crear/listar/editar facturas
2. **Email:** Implementar send-email con SMTP + render PDF
3. **Recurrencia:** Implementar job para facturas periódicas
4. **OCR real:** Integrar Tesseract.js o servicio cloud
5. **FacturaScripts:** Sincronizar facturas para contabilidad
6. **Reportes:** Dashboard con KPIs y exportaciones

---

**Fecha completado:** 13 de junio de 2024  
**Status:** ✅ Listo para integración
