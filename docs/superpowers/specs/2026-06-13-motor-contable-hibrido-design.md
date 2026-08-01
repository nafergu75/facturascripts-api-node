# Motor Contable Automático con Revisión Híbrida — Design Doc

**Fecha:** 13 de junio de 2026  
**Status:** 🎯 **ESPECIFICACIÓN COMPLETA - LISTO PARA IMPLEMENTAR**  
**Autor:** Ignacio (Backend Architect + Accountant Perspective)

---

## 📋 Resumen Ejecutivo

Se diseña una **capa de control e integración** alrededor del motor contable existente para que:

- **Usuarios sin conocimientos contables** trabajen solo con facturas (ingresos/gastos)
- **El sistema genere automáticamente** asientos contables correctos (PGC español)
- **Existe revisión/aprobación híbrida**: asientos en PENDING_REVIEW que el usuario o asesor puede revisar, ajustar y aprobar
- **Todos los informes, libros IVA y documentos de Hacienda** se alimentan automáticamente

**Enfoque:** Automatización inteligente + control profesional = Contabilidad correcta sin que el usuario entienda PGC.

---

## 🏗️ Arquitectura General

### Flujo de Alto Nivel

```
Invoice Created/Confirmed
         ↓
    [Hook Service]
         ↓
  Generate Journal Entry (DRAFT/PENDING_REVIEW)
  + VATBook + RetentionBook
         ↓
  [User/Accountant Reviews]
         ↓
  Approve (PENDING_REVIEW → POSTED)
         ↓
  Feeds Reports, Tax Docs, Analytics
```

### Componentes Principales

| Componente | Responsabilidad | Ubicación |
|---|---|---|
| **AccountingEngineController** | Fachada: orquesta motor, transacciones, validaciones | `src/controllers/accounting-engine.controller.ts` |
| **AccountingHooksService** | Enganches post-evento de facturas | `src/services/accounting-hooks.service.ts` |
| **ReportsService** | Agregaciones para informes (Balance, PyG, Analytics) | `src/services/reports.service.ts` |
| **TaxDocumentsService** | Libros IVA y exportaciones para Hacienda | `src/services/tax-documents.service.ts` |
| **Routes** | Endpoints REST (contabilización, aprobación, informes, tax) | `src/routes/accounting-engine.routes.ts`, `reports.routes.ts`, `tax.routes.ts` |

### Dependencias Existentes

✅ **Ya existen y se reutilizan:**
- `AccountingEngineService` (motor contable con lógica completa)
- `ChartOfAccountsService` (Plan Contable PGC)
- Modelos Prisma: JournalEntry, JournalEntryLine, VATBook, RetentionBook
- `AuditLog` para trazabilidad

---

## 🎛️ Detalle de Componentes

### 1. AccountingEngineController

**Responsabilidad:** Orquestar el motor contable, gestionar transacciones, validar, exponer endpoints.

**Métodos públicos:**

#### `contabilizarFacturaIngreso(companyId, invoiceId, mode = 'AUTO')`
- **Qué hace:** Llama `AccountingEngineService.contabilizarFacturaIngreso()`
- **Transacción:** Crea JournalEntry + JournalEntryLine + VATBook en una tx
- **Estado inicial:** DRAFT (si mode=AUTO) o PENDING_REVIEW (si mode=MANUAL)
- **Retorna:** `{ journalEntryId, estado, advertencias?: [] }`
- **Errores claros:**
  - "No hay cuenta PGC configurada para IVA del 21%"
  - "Empresa sin plan contable inicializado"
  - "Regla contable no encontrada para tipo de operación NACIONAL"

#### `contabilizarFacturaGasto(companyId, invoiceId, mode = 'AUTO')`
- **Idem a ingreso pero:** Crea asiento de gasto (grupos 6, 472, 400, etc.)

#### `aprobarAsiento(companyId, journalEntryId, userId)`
- **Qué hace:** Cambia JournalEntry de PENDING_REVIEW → POSTED
- **Validación final:** debe = haber
- **Auditoría:** Registra quién, cuándo, observaciones (si las hay)
- **Retorna:** `{ journalEntryId, estado: 'POSTED', contabilizadoEn: Date }`

#### `recalcularAsiento(companyId, journalEntryId, userId)`
- **Cuándo:** Factura fue modificada y su asiento anterior está POSTED
- **Qué hace:**
  1. Busca JournalEntry anterior
  2. Crea reversión (líneas opuestas, marca original como REVERSED)
  3. Genera nuevo asiento con datos corregidos (PENDING_REVIEW)
- **Transacción:** TODO atómico
- **Retorna:** `{ asientoReversado, asientoNuevo, estado: 'PENDING_REVIEW' }`

#### `ajustarLineaAsiento(companyId, journalEntryId, lineId, cambios, userId)`
- **Cuándo:** Usuario quiere cambiar cuenta o importes antes de aprobar
- **Restricción:** Solo si asiento en DRAFT o PENDING_REVIEW
- **Cambios permitidos:** accountCode, debe, haber
- **Validación post-ajuste:** debe = haber (error si no)
- **Auditoría:** Registra cambio anterior → nuevo
- **Retorna:** `{ lineaActualizada, asientoValidado: true }`

#### `obtenerAsientoDetallado(companyId, journalEntryId)`
- **Retorna:** Objeto con:
  ```typescript
  {
    asiento: JournalEntry,
    lineas: JournalEntryLine[],
    factura: IncomeInvoice | ExpenseInvoice,
    validaciones: {
      cuadrado: boolean,        // debe = haber?
      errores: string[],
      advertencias: string[]
    },
    permitidoAprobar: boolean,  // estado PENDING_REVIEW?
    permitidoAjustar: boolean,  // estado DRAFT/PENDING_REVIEW?
  }
  ```

#### `listarAsientos(companyId, filtros)`
- **Filtros:** estado, desde, hasta, origen (INCOME_INVOICE | EXPENSE_INVOICE)
- **Retorna:** Array de asientos con resumen de líneas

**Características transversales:**

- ✅ Todas las operaciones dentro de transacción Prisma
- ✅ Validación: empresa existe, factura existe, plan contable inicializado, reglas configuradas
- ✅ Error handling: mensajes amigables para no-contables
- ✅ Auditoría: cada acción registrada

---

### 2. AccountingHooksService

**Responsabilidad:** Enganches post-evento de facturas. Dispara contabilización automática sin intervención del usuario.

**Métodos públicos:**

#### `onIncomeInvoiceConfirmed(companyId, invoiceId)`
- **Cuándo:** Usuario confirma factura de ingreso (PATCH /income-invoices/:id)
- **Qué hace:**
  1. Llama `AccountingEngineController.contabilizarFacturaIngreso(mode='AUTO')`
  2. Registra auditoría de la contabilización
  3. Si hay advertencias, loguea para que contable las revise
- **Fail-safe:** NO falla confirmación si hay error en contabilización
  - Error se loguea y contable ve alerta
  - Usuario ve factura confirmada (estado PENDING)
- **Auditoría:** Acción = CONTABILIZAR_FACTURA_INGRESO_AUTO

#### `onExpenseInvoiceConfirmed(companyId, invoiceId)`
- **Idem a ingreso pero para gastos**

#### `onInvoiceModified(companyId, invoiceId, invoiceType: 'INCOME' | 'EXPENSE')`
- **Cuándo:** Usuario modifica factura ya contabilizada (PATCH /invoices/:id)
- **Qué hace:**
  1. Busca JournalEntry anterior (estado POSTED, PENDING_REVIEW)
  2. Si existe:
     - Llama `AccountingEngineController.recalcularAsiento()`
     - Crea reversión automática
     - Genera nuevo asiento (PENDING_REVIEW)
  3. Registra auditoría
- **Fail-safe:** Similar a onIncomeInvoiceConfirmed

#### `reversarAsiento(journalEntryId)` [Private]
- **Qué hace:**
  1. Obtiene JournalEntry + líneas
  2. Crea nuevo JournalEntry (numeroAsiento = original + "-REV")
  3. Líneas opuestas (debe ↔ haber)
  4. Estado: POSTED (reversión es inmediata)
  5. Marca original como REVERSED
- **Transacción:** Atómica

**Características:**

- ✅ Enganches llamados DESPUÉS de guardar factura
- ✅ Fail-safe: errores no rompen confirmación
- ✅ Auditoría completa
- ✅ Historial de reversiones

---

### 3. ReportsService

**Responsabilidad:** Generar informes financieros desde JournalEntry (filtrados por POSTED).

**Métodos:**

#### `obtenerBalance(companyId, from, to)`
- **Qué retorna:** Saldo por grupos de balance (1–5)
  ```json
  {
    "fecha": "2026-06-13",
    "activo": {
      "noCirculante": 50000,
      "circulante": 30000,
      "detalles": [
        { "grupo": "2", "nombre": "Inmovilizado", "saldo": 50000 },
        { "grupo": "3", "nombre": "Existencias", "saldo": 10000 },
        ...
      ]
    },
    "pasivo": {
      "noCirculante": 20000,
      "circulante": 15000,
      "detalles": [...]
    },
    "patrimonioNeto": 45000
  }
  ```

#### `obtenerPyG(companyId, from, to)`
- **Qué retorna:** P&L (ingresos - gastos)
  ```json
  {
    "desde": "2026-01-01",
    "hasta": "2026-06-13",
    "ingresos": {
      "grupo7": 100000,
      "detalles": [
        { "codigo": "700", "nombre": "Ventas", "cantidad": 80000 },
        { "codigo": "701", "nombre": "Intracomunitarias", "cantidad": 20000 }
      ]
    },
    "gastos": {
      "grupo6": 60000,
      "detalles": [...]
    },
    "resultadoExplotacion": 40000
  }
  ```

#### `obtenerMayor(companyId, accountCode, from, to)`
- **Qué retorna:** Listado de movimientos de una cuenta
  ```json
  {
    "cuenta": "700",
    "nombre": "Ventas de mercaderías",
    "movimientos": [
      { "fecha": "2026-02-01", "referencia": "FAC-001", "debe": 0, "haber": 1000 },
      { "fecha": "2026-03-15", "referencia": "FAC-002", "debe": 0, "haber": 1500 }
    ],
    "saldoInicial": 0,
    "saldoFinal": 2500
  }
  ```

#### `obtenerEvolucionMensual(companyId, year)`
- **Qué retorna:** Ingresos vs gastos por mes
  ```json
  {
    "ano": 2026,
    "meses": {
      "01": { "ingresos": 5000, "gastos": 2000, "beneficio": 3000 },
      "02": { "ingresos": 7000, "gastos": 2500, "beneficio": 4500 },
      ...
    }
  }
  ```

#### `obtenerAnalisisPorCliente(companyId, from, to)`
- **Qué retorna:** Desglose de ventas/saldo por cliente
  ```json
  {
    "clientes": [
      { "id": "cli-001", "nombre": "Acme Inc", "totalFacturado": 10000, "saldoPendiente": 2000 },
      ...
    ]
  }
  ```

**Características:**

- ✅ Filtran por estado = POSTED (excluyen DRAFT, PENDING_REVIEW)
- ✅ Incluyen REVERSED en cálculos (reversión + nuevo = saldo correcto)
- ✅ Datos agregados listos para gráficos

---

### 4. TaxDocumentsService

**Responsabilidad:** Libros de IVA y documentos para Hacienda.

**Métodos:**

#### `obtenerLibroIVAEmitidas(companyId, period)`
- **Qué retorna:** Libro de facturas emitidas (VATBook con tipoLibro=EMITIDAS)
  ```json
  {
    "periodo": "Q1-2026",
    "facturas": [
      {
        "fecha": "2026-01-15",
        "numero": "FAC-001",
        "nifCliente": "12345678A",
        "nombreCliente": "Cliente XYZ",
        "baseImponible": 1000,
        "tipoIva": 21,
        "cuotaIva": 210
      },
      ...
    ],
    "totalBases": 5000,
    "totalCuotas": 1050
  }
  ```

#### `obtenerLibroIVARecibidas(companyId, period)`
- **Idem a emitidas pero tipoLibro=RECIBIDAS**

#### `obtenerResumen303(companyId, period)`
- **Qué retorna:** Resumen para modelo 303 (IVA trimestral)
  ```json
  {
    "periodo": "Q1-2026",
    "emitidasPor21": { "base": 10000, "cuota": 2100 },
    "emitidasPor10": { "base": 2000, "cuota": 200 },
    "recibidasPor21": { "base": 5000, "cuota": 1050 },
    "recibidasPor10": { "base": 1000, "cuota": 100 },
    "cuotaAIngresar": 1150,  // (2100+200) - (1050+100)
    "deuda": false
  }
  ```

#### `obtenerResumen190(companyId, year)`
- **Qué retorna:** Resumen para modelo 190 (retenciones)
  ```json
  {
    "ano": 2026,
    "retenciones": [
      {
        "nifTercero": "12345678A",
        "nombreTercero": "Asesor García",
        "tipoRetencion": "PROFESIONAL",
        "baseImponible": 5000,
        "porcentaje": 15,
        "cuotaRetencion": 750
      },
      ...
    ],
    "totalBases": 10000,
    "totalRetenciones": 1500
  }
  ```

#### `exportarModelo303(companyId, period, format: 'txt' | 'json')`
- **Qué retorna:** Borrador del modelo 303 en formato compatible AEAT
  - Si format=txt: String con estructura del fichero .txt
  - Si format=json: Objeto JSON serializable
- **Nota:** No implementa validación AEAT completa (solo estructura de datos)

**Características:**

- ✅ Agregan datos de VATBook + RetentionBook
- ✅ Cálculos automáticos (cuota a ingresar, deudas)
- ✅ Exportables en formatos estándar

---

## 🔗 Rutas y Endpoints

### Bloque 1: Contabilización Automática/Manual

```
POST /api/companies/:companyId/accounting/contabilizar/:invoiceId
  Params: tipo=INGRESO|GASTO, mode=AUTO|MANUAL
  Response: { journalEntryId, estado, advertencias? }
  Auth: authenticate, canWrite
```

### Bloque 2: Listado y Detalle de Asientos

```
GET /api/companies/:companyId/accounting/journal-entries
  Params: estado, desde, hasta, origen
  Response: JournalEntry[]
  Auth: authenticate, canRead

GET /api/companies/:companyId/accounting/journal-entries/:journalEntryId
  Response: { asiento, lineas, factura, validaciones, permitidoAprobar, permitidoAjustar }
  Auth: authenticate, canRead
```

### Bloque 3: Aprobación y Ajuste

```
POST /api/companies/:companyId/accounting/journal-entries/:journalEntryId/approve
  Body: { observaciones? }
  Response: { journalEntryId, estado: POSTED }
  Auth: authenticate, requireRole(contable, admin)

POST /api/companies/:companyId/accounting/journal-entries/:journalEntryId/recalculate
  Response: { asientoReversado, asientoNuevo }
  Auth: authenticate, requireRole(contable, admin)

PATCH /api/companies/:companyId/accounting/journal-entries/:journalEntryId/lines/:lineId
  Body: { accountCode?, debe?, haber? }
  Response: { lineaActualizada, asientoValidado }
  Auth: authenticate, requireRole(contable, admin)
```

### Bloque 4: Informes

```
GET /api/companies/:companyId/reports/balance?from=YYYY-MM-DD&to=...
  Response: { activo, pasivo, patrimonioNeto, detalles }

GET /api/companies/:companyId/reports/profit-and-loss?from=...&to=...
  Response: { ingresos, gastos, resultadoExplotacion, detalles }

GET /api/companies/:companyId/reports/ledger?accountCode=XXX&from=...&to=...
  Response: { cuenta, movimientos[], saldoFinal }

GET /api/companies/:companyId/reports/analytics/monthly?year=YYYY
  Response: { ano, meses: { MM: { ingresos, gastos, beneficio } } }

GET /api/companies/:companyId/reports/analytics/by-customer?from=...&to=...
  Response: { clientes: [ { id, nombre, totalFacturado, saldoPendiente } ] }
```

### Bloque 5: Documentos de Hacienda

```
GET /api/companies/:companyId/tax/vat/books/issued?period=Q1-2026
  Response: { periodo, facturas[], totalBases, totalCuotas }

GET /api/companies/:companyId/tax/vat/books/received?period=Q1-2026
  Response: { periodo, facturas[], totalBases, totalCuotas }

GET /api/companies/:companyId/tax/vat/summary?period=Q1-2026
  Response: { emitidasPor21, recibidasPor21, ..., cuotaAIngresar, deuda }

GET /api/companies/:companyId/tax/retentions/summary?year=YYYY
  Response: { ano, retenciones[], totalRetenciones }

GET /api/companies/:companyId/tax/export/modelo-303?period=Q1-2026&format=txt|json
  Response: String (txt) | Object (json)
```

---

## 🔄 Flujos Completos

### Flujo A: Venta (Income Invoice)

```
1. Usuario crea factura de ingreso
   POST /api/income-invoices
   { clienteId, serie, numero, fechaEmision, lineas[], base, iva, retencion }
   → Estado: DRAFT

2. Usuario confirma factura
   PATCH /api/income-invoices/:id { estado: 'PENDING' }
   
   ↓ [HOOK] onIncomeInvoiceConfirmed()
   
3. Sistema auto-genera asiento
   AccountingEngineController.contabilizarFacturaIngreso(mode='AUTO')
   
   Crea JournalEntry (estado: PENDING_REVIEW)
   ├─ Línea debe: Cliente (430): totalFactura
   ├─ Línea haber: Ventas (700): baseTotal
   ├─ Línea haber: IVA repercutido (477): ivaTotal
   └─ Línea debe: IRPF asumido (4751): retencionTotal [si aplica]
   
   Crea VATBook (tipoLibro: EMITIDAS)
   Auditoría: CONTABILIZAR_FACTURA_INGRESO_AUTO

4. [Contable revisa en UI]
   GET /api/accounting/journal-entries?estado=PENDING_REVIEW
   → Ve asiento auto-generado
   
   GET /api/accounting/journal-entries/:id
   → Detalle: validaciones, factura, contexto

5. [Opcional] Contable ajusta subcuenta
   PATCH /api/accounting/journal-entries/:id/lines/:lineId
   { accountCode: '7001' }
   → Cambio registrado en auditoría

6. [Contable aprueba]
   POST /api/accounting/journal-entries/:id/approve
   { observaciones: "Revisado y OK" }
   → JournalEntry: PENDING_REVIEW → POSTED
   → Asiento es definitivo

7. [Informes actualizados automáticamente]
   GET /api/reports/balance → Muestra Cliente +430 = 121 €
   GET /api/reports/profit-and-loss → Muestra Venta +700 = 100 €, IVA = 21 €
   GET /api/tax/vat/books/issued → Venta aparece en libro
```

### Flujo B: Compra (Expense Invoice) — similar a Flujo A

```
1–2. Usuario crea y confirma factura de gasto
   → HOOK: onExpenseInvoiceConfirmed()

3. Sistema auto-genera asiento
   ├─ Línea debe: Gasto (600): baseTotal
   ├─ Línea debe: IVA soportado (472): ivaTotal
   ├─ Línea debe: IRPF asumido (4751): retencionTotal [si aplica]
   └─ Línea haber: Proveedor (400): totalFactura
   
   VATBook (tipoLibro: RECIBIDAS)

4–6. Contable revisa y aprueba → POSTED

7. Informes
   GET /api/reports/balance → Proveedor +400
   GET /api/reports/profit-and-loss → Gasto -600
   GET /api/tax/vat/books/received → En libro IVA recibidas
```

### Flujo C: Modificación de factura contabilizada

```
1. Factura confirmada → Asiento A (POSTED)

2. Usuario modifica factura
   PATCH /api/income-invoices/:id { ivaTotal: 50 }
   
   ↓ [HOOK] onInvoiceModified()

3. Sistema detecta asiento anterior
   Busca JournalEntry (invoiceId, estado=POSTED)
   → Encontrado: Asiento A

4. [Auto] Reversión
   AccountingHooksService.reversarAsiento(A)
   ├─ Crea JournalEntry A-REV con líneas opuestas
   ├─ Estado: POSTED (reversión es inmediata)
   └─ Marca A como REVERSED

5. [Auto] Nuevo asiento
   contabilizarFacturaIngreso con valores corregidos
   ├─ Crea JournalEntry B (PENDING_REVIEW)
   ├─ Base 100, IVA 50 (nuevo)
   └─ Líneas correctas

6. [Contable revisa nuevo asiento]
   GET /api/accounting/journal-entries/B
   → Ve que es nuevo, linea IVA = 50

7. [Contable aprueba]
   POST /api/accounting/journal-entries/B/approve
   → POSTED

8. [Informes correctos]
   Balance y PyG reflejan A (reversado) + B (nuevo) = valores correctos
   Auditoría: completa trazabilidad
```

---

## ✅ Validaciones y Controles

### Nivel Controller

- ✓ Empresa existe
- ✓ Factura existe y estado permitido
- ✓ Plan contable inicializado
- ✓ Asiento existe y estado permitido
- ✓ Usuario tiene permisos (requiere role contable/admin para aprobación)

### Nivel Transacción

- ✓ Todas las operaciones en una sola transacción Prisma
- ✓ Si falla, rollback de TODO (ni factura ni asiento parciales)
- ✓ Duplicados: búsqueda previa antes de crear

### Nivel Contable

- ✓ Debe = Haber (tolerancia 0.01 €)
- ✓ Cuentas existen y activas
- ✓ Reglas configuradas para tipo de operación + IVA

### Auditoría

- ✓ Cada acción registrada en AuditLog
- ✓ userId, timestamp, cambios
- ✓ Historial de reversiones

---

## 🛡️ Manejo de Errores

**Para usuarios sin conocimientos contables, los errores deben ser:**

| Error Técnico | Mensaje Usuario |
|---|---|
| Account code not found | "No hay cuenta PGC configurada para este tipo de factura y IVA al 21%. Contacta a tu asesor." |
| Chart not initialized | "El plan contable no ha sido inicializado. Solicita a admin que lo haga." |
| debe ≠ haber | "Error interno: asiento desequilibrado. Contacta al equipo de soporte." |
| Invoice not found | "Factura no encontrada. Verifica el número." |
| JournalEntry already posted | "No se puede ajustar un asiento ya contabilizado. Solicita recalculación." |

---

## 🎯 Características de Calidad

### Atomic Transactions
Toda contabilización en UNA transacción:
- JournalEntry + JournalEntryLine
- VATBook + RetentionBook
- Cambios de estado de factura
- Si falla cualquiera, ROLLBACK completo

### Validación Fuerte
- Debe = Haber en CADA operación
- Cuentas activas y existentes
- Reglas completamente configuradas
- Error temprano, mensaje claro

### Fail-Safe Hooks
- Si hook falla, NO afecta confirmación de factura
- Error se loguea para contable
- Usuario ve factura confirmada, contable ve alerta

### Auditoría Completa
- Quién, cuándo, qué cambió
- Reversiones trackeadas
- Histórico de ajustes

---

## 📦 Entregables

| Componente | Archivo | LOC aprox |
|---|---|---|
| Controller | `src/controllers/accounting-engine.controller.ts` | 300–400 |
| Hooks Service | `src/services/accounting-hooks.service.ts` | 200–250 |
| Reports Service | `src/services/reports.service.ts` | 250–300 |
| Tax Service | `src/services/tax-documents.service.ts` | 200–250 |
| Rutas Contabilización | `src/routes/accounting-engine.routes.ts` | 150–180 |
| Rutas Informes | `src/routes/reports.routes.ts` | 100–120 |
| Rutas Tax | `src/routes/tax.routes.ts` | 80–100 |
| **TOTAL** | — | ~1,300–1,400 |

---

## 🚀 Próximos Pasos

1. ✅ **Aprobación de este Design Doc**
2. 📋 **Writing-Plans**: Plan de implementación detallado (orden de tareas, dependencias)
3. 🔨 **Implementación**: Desarrollar según el plan
4. 🧪 **Testing**: Suite de pruebas mínimas
5. 📖 **Documentación**: README y ejemplos de uso

---

**Design Doc completado y listo para implementación.**
