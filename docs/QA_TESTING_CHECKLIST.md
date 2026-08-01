# Checklist de Pruebas Manuales - Motor Contable Automático

**Fecha:** 13 de junio de 2026  
**Objetivo:** Validar flujos completos del motor contable desde factura → asiento → informes

---

## 🔧 Prerequisitos

- **Postman/Insomnia** instalado
- **JWT Token válido** con acceso a empresa de prueba
- **URL base:** `http://localhost:3000/api/companies/:companyId`
- **Headers comunes:**
  ```
  Authorization: Bearer <JWT_TOKEN>
  Content-Type: application/json
  ```

---

## 📋 ESCENARIO 1: Venta Simple (IVA 21%, sin retención)

### Paso 1: Crear cliente

**Endpoint:** `POST /invoices/income`  
**Body:**
```json
{
  "customerId": "crear-nuevo-cliente-o-usar-existente",
  "serie": "FAC",
  "numero": 001,
  "fechaEmision": "2026-06-13",
  "fechaVencimiento": "2026-07-13",
  "lineas": [
    {
      "descripcion": "Venta Producto A",
      "cantidad": 5,
      "precioUnitario": 200.00,
      "tipoIva": 21,
      "tipoRetencion": 0
    }
  ]
}
```

**Verificación:**
- ✅ Status 201 (Created)
- ✅ Response incluye `id` de factura
- ✅ Estado: `DRAFT`

---

### Paso 2: Confirmar factura

**Endpoint:** `PATCH /invoices/income/:invoiceId/status`  
**Body:**
```json
{
  "estado": "PENDING"
}
```

**Verificación:**
- ✅ Status 200
- ✅ Estado: `PENDING`
- ✅ **Enganche automático**: Se genera asiento contable

---

### Paso 3: Obtener ID del asiento

**Endpoint:** `GET /accounting/journal-entries?origen=INCOME_INVOICE&invoiceId=<ID>`  
**Verificación:**
- ✅ Status 200
- ✅ Array con al menos 1 asiento
- ✅ `journalEntryId` para pasos siguientes

---

### Paso 4: Ver detalle del asiento (DRAFT)

**Endpoint:** `GET /accounting/journal-entries/:journalEntryId`  
**Verificación:**
- ✅ Status 200
- ✅ `estado: "DRAFT"` o `"PENDING_REVIEW"`
- ✅ `lineas`: Array con líneas (Cliente, Ventas, IVA)
- ✅ `validaciones.cuadrado: true` (debe = haber)
- ✅ `permitidoAprobar: true`

**Ejemplo de respuesta esperada:**
```json
{
  "asiento": {
    "id": "...",
    "numeroAsiento": "FAC-ING-FAC-001",
    "estado": "PENDING_REVIEW",
    "lineas": [
      { "accountCode": "430", "debe": 1210, "haber": 0 },      // Cliente
      { "accountCode": "700", "debe": 0, "haber": 1000 },      // Ventas
      { "accountCode": "477", "debe": 0, "haber": 210 }        // IVA
    ]
  },
  "validaciones": { "cuadrado": true, "errores": [] },
  "permitidoAprobar": true
}
```

---

### Paso 5: Verificar en Libro IVA (emitidas)

**Endpoint:** `GET /tax/vat/books/issued?period=Q2-2026`  
**Verificación:**
- ✅ Status 200
- ✅ Array `facturas` contiene la factura con:
  - `numero: "FAC-001"`
  - `base: 1000`
  - `tipoIva: 21`
  - `cuota: 210`
- ✅ `totalBases ≥ 1000`
- ✅ `totalCuotas ≥ 210`

---

### Paso 6: Aprobar asiento

**Endpoint:** `POST /accounting/journal-entries/:journalEntryId/approve`  
**Body:**
```json
{
  "observaciones": "Verificado por QA"
}
```

**Verificación:**
- ✅ Status 200
- ✅ `estado: "POSTED"`

---

### Paso 7: Verificar Balance

**Endpoint:** `GET /reports/balance?from=2026-01-01&to=2026-12-31`  
**Verificación:**
- ✅ Status 200
- ✅ `activo.circulante` incluye cliente (430): +1210
- ✅ `patrimonioNeto` incluye resultado del período

---

### Paso 8: Verificar P&L (Pérdidas y Ganancias)

**Endpoint:** `GET /reports/profit-and-loss?from=2026-01-01&to=2026-12-31`  
**Verificación:**
- ✅ Status 200
- ✅ `ingresos ≥ 1000` (ventas)
- ✅ `gastos = 0` (no hay gastos)
- ✅ `resultadoExplotacion ≥ 1000`

---

## 📋 ESCENARIO 2: Compra con IVA Soportado + IRPF (Profesional)

### Pasos 1-2: Crear y confirmar factura de gasto

**Endpoint:** `POST /invoices/income` (usar como gasto de prueba)  
**Body:**
```json
{
  "customerId": "proveedor-test",
  "serie": "GASTO",
  "numero": 001,
  "fechaEmision": "2026-06-13",
  "lineas": [
    {
      "descripcion": "Servicio profesional",
      "cantidad": 1,
      "precioUnitario": 1000.00,
      "tipoIva": 21,
      "tipoRetencion": 15
    }
  ]
}
```

**Confirmación:**
```json
{ "estado": "PENDING" }
```

---

### Paso 3: Obtener asiento de gasto

**Endpoint:** `GET /accounting/journal-entries?origen=EXPENSE_INVOICE`  
**Verificación:**
- ✅ Estado: `PENDING_REVIEW`
- ✅ Líneas incluyen:
  - Gasto (debit)
  - IVA soportado (debit)
  - IRPF asumido (debit)
  - Proveedor (credit)
- ✅ Debe = Haber

---

### Paso 4: Verificar Libro IVA (recibidas)

**Endpoint:** `GET /tax/vat/books/received?period=Q2-2026`  
**Verificación:**
- ✅ Array `facturas` incluye entrada con:
  - `numero: "GASTO-001"`
  - `base: 1000`
  - `cuota: 210` (IVA soportado)

---

### Paso 5: Verificar Resumen Retenciones (Modelo 190)

**Endpoint:** `GET /tax/retentions/summary?year=2026`  
**Verificación:**
- ✅ Array `retenciones` incluye:
  - `tipo: "PROFESIONAL"` o similar
  - `base: 1000`
  - `cuota: 150` (15% retención)
- ✅ `totalRetenciones ≥ 150`

---

### Paso 6: Aprobar y verificar

Aprobar asiento: `POST /accounting/journal-entries/:journalEntryId/approve`  
Verificar Balance: `GET /reports/balance`  
- ✅ Proveedor (400) en pasivo: +1000

---

## 📋 ESCENARIO 3: Modificación de Factura Contabilizada

### Paso 1: Factura con asiento POSTED

Usar asiento del Escenario 1 que ya está POSTED.

---

### Paso 2: Modificar factura

**Endpoint:** `PATCH /invoices/income/:invoiceId`  
**Body:**
```json
{
  "baseTotal": 1500,
  "ivaTotal": 315,
  "totalFactura": 1815
}
```

**Verificación:**
- ✅ Status 200
- ✅ Factura actualizada

---

### Paso 3: Verificar reversión automática

**Endpoint:** `GET /accounting/journal-entries?estado=REVERSED`  
**Verificación:**
- ✅ Asiento original marcado como REVERSED
- ✅ Nuevo asiento en PENDING_REVIEW con datos actualizados
- ✅ Líneas de reversión cuadran (líneas opuestas al original)

**Estructura esperada:**
```json
{
  "id": "...-REV",
  "numeroAsiento": "FAC-ING-FAC-001-REV",
  "estado": "POSTED",
  "lineas": [
    // Líneas OPUESTAS al asiento original (debe↔haber invertidos)
  ]
}
```

---

### Paso 4: Aprobar nuevo asiento

**Endpoint:** `POST /accounting/journal-entries/:journalEntryIdNew/approve`

---

### Paso 5: Verificar informes actualizados

**Balance:** `GET /reports/balance`
- ✅ Cliente (430): 1815 (valor nuevo)

**P&L:** `GET /reports/profit-and-loss`
- ✅ Ingresos: 1500 (base nueva)

**Libro IVA:** `GET /tax/vat/books/issued?period=Q2-2026`
- ✅ Entrada con base: 1500, cuota: 315

---

## 📋 ESCENARIO 4: Ajuste de Subcuenta en Asiento

### Paso 1: Asiento en PENDING_REVIEW

Usar cualquier asiento que no esté aún aprobado.

---

### Paso 2: Ajustar una línea (cambiar cuenta)

**Endpoint:** `PATCH /accounting/journal-entries/:journalEntryId/lines/:lineId`  
**Body:**
```json
{
  "accountCode": "7001"
}
```

**Verificación:**
- ✅ Status 200
- ✅ `lineaActualizada.accountCode: "7001"`
- ✅ `asientoValidado: true` (debe = haber se mantiene)

---

### Paso 3: Intentar ajuste que rompa cuadre

**Endpoint:** `PATCH /accounting/journal-entries/:journalEntryId/lines/:lineId`  
**Body:**
```json
{
  "debe": 9999.99
}
```

**Verificación:**
- ✅ Status 400
- ✅ Error message: "Ajuste desequilibra el asiento"

---

## 🔴 ESCENARIOS DE ERROR

### Error 1: Factura sin cliente

**Endpoint:** Crear factura sin `customerId`  
**Verificación:**
- ✅ Status 400
- ✅ Error message menciona cliente

---

### Error 2: Aprobar asiento POSTED

**Endpoint:** `POST /accounting/journal-entries/:journalEntryId/approve` (usar POSTED)  
**Verificación:**
- ✅ Status 400
- ✅ Error: "solo se pueden aprobar asientos en PENDING_REVIEW"

---

### Error 3: Ajustar línea en asiento POSTED

**Endpoint:** `PATCH .../lines/:lineId` (usar POSTED)  
**Verificación:**
- ✅ Status 400
- ✅ Error: "Solo se pueden ajustar asientos en DRAFT o PENDING_REVIEW"

---

## 📊 Datos Esperados en Reportes

### Balance General

```json
{
  "fecha": "2026-06-13",
  "activo": {
    "noCirculante": 0,
    "circulante": 3025  // Clientes - Proveedores
  },
  "pasivo": {
    "noCirculante": 0,
    "circulante": 0
  },
  "patrimonioNeto": 3025
}
```

### P&L

```json
{
  "desde": "2026-01-01",
  "hasta": "2026-12-31",
  "ingresos": 2500,       // 1000 + 1500
  "gastos": 1000,         // Servicio profesional
  "resultadoExplotacion": 1500
}
```

### Modelo 303 (TXT)

```
MODELO 303 - Q2-2026
================================================
IVA REPERCUTIDO (Facturas Emitidas):
  Base: 2500.00 €
  Cuota: 525.00 €

IVA SOPORTADO (Facturas Recibidas):
  Base: 1000.00 €
  Cuota: 210.00 €

RESULTADO:
  Cuota a INGRESAR: 315.00 €
```

---

## ✅ Checklist Final

- [ ] Escenario 1 (Venta) completo
- [ ] Escenario 2 (Compra + IRPF) completo
- [ ] Escenario 3 (Modificación) completo
- [ ] Escenario 4 (Ajuste de subcuenta) completo
- [ ] Todos los errores se manejan correctamente
- [ ] Informes muestran datos correctos
- [ ] Balance cuadra en todos los escenarios
- [ ] Libro IVA registra correctamente
- [ ] Modelo 303 exporta correctamente

---

**Notas:**
- Usar timestamps únicos en números de factura para evitar duplicados
- Guardar IDs de asiento para verificaciones posteriores
- En caso de error, verificar los logs del servidor
