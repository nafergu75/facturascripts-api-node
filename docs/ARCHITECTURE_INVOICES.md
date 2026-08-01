# Arquitectura de la API de Facturas de Ingreso y Lector OCR

## Descripción general

La API de facturas de ingreso y lector automático forma una capa independiente de la integración con FacturaScripts, permitiendo:

1. **Gestión de facturas de ingreso** en BD propia (Prisma)
2. **Procesamiento OCR** de documentos con pipeline de estados
3. **Conversión automática** de documentos digitalizados a facturas de ingreso

---

## Arquitectura en capas

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend (React)                        │
│  VistaGeneralPage, Panel de Ingresos, Lector Automático    │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   Express API Routes                         │
│  /api/invoices/income                                       │
│  /api/income-reader                                         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Controllers                               │
│  - incomeInvoicesController                                 │
│  - incomeReaderController                                   │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    Services                                  │
│  - incomeInvoicesService (crear, listar, cambiar estado)   │
│  - incomeReaderService (subir, procesar, verificar)        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   Prisma ORM                                 │
│  BD propia: Customer, IncomeInvoice, IncomeInvoiceLine,   │
│             IncomeReaderDocument, ReaderEmailConfig        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   MySQL Database                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Flujo de datos: Crear factura de ingreso

```
┌────────────────────────────────────────────────────────────┐
│ POST /api/invoices/income                                  │
│ {customer, serie, numero, fechas, lineas, totales}        │
└────────────────────────┬─────────────────────────────────┘
                         │
                    Controller
                         │
┌────────────────────────▼─────────────────────────────────┐
│ incomeInvoicesController.crearIngreso()                  │
│  - Valida input                                           │
│  - Registra auditoría                                     │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│ incomeInvoicesService.crearIngreso(dto)                  │
│  ├─ resolverCliente(id o nuevo)                          │
│  ├─ resolverNumeroFactura(serie, numero)                 │
│  ├─ calcularTotales(lineas)                              │
│  │   ├─ Itera cada línea                                 │
│  │   ├─ baseLine = cantidad×precio - descuento           │
│  │   ├─ ivaImporte = baseLine × tipoIva / 100            │
│  │   ├─ retencionImporte = baseLine × tipoRetencion /100 │
│  │   └─ Suma totales                                      │
│  ├─ determinarEstado(fechaVencimiento)                   │
│  │   └─ PENDING si vence ≥ hoy, OVERDUE si < hoy         │
│  └─ prisma.incomeInvoice.create(cabecera + lineas)       │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│ Prisma: INSERT IncomeInvoice, IncomeInvoiceLine         │
└────────────────────────┬─────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────┐
│ Response 201: {invoice con id, lineas, totales, estado}  │
└────────────────────────────────────────────────────────────┘
```

---

## Flujo de datos: Procesar documento OCR

```
┌──────────────────────────────────────────────────────────────┐
│ POST /api/income-reader/{mobile-upload|web-upload}          │
│ File: {buffer, originalname, mimetype}                      │
└────────────────────┬───────────────────────────────────────┘
                     │
                Controller
                     │
┌────────────────────▼───────────────────────────────────────┐
│ incomeReaderController.subir[Movil|Web]()                 │
│  - Extrae archivo (multipart/binario/JSON base64)         │
│  - Registra auditoría                                      │
└────────────────────┬───────────────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────────────┐
│ incomeReaderService.subir[DesdeMovil|DesdeWeb]()          │
│  ├─ guardarArchivo(buffer, nombre)                        │
│  │   └─ fs.writeFile(/storage/income-documents/{uuid})    │
│  ├─ prisma.incomeReaderDocument.create({                  │
│  │     status: 'UPLOADED'                                 │
│  │   })                                                    │
│  └─ procesarDocumentoEnBackground(async)                  │
│      (no bloquea el request)                              │
└────────────────────┬───────────────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────────────┐
│ Response 201: {document: {id, status: UPLOADED, ...}}      │
└────────────────────────────────────────────────────────────┘
                     │
      ┌──────────────▼──────────────┐
      │  BACKGROUND PROCESSING      │
      └──────────────┬──────────────┘
                     │
         ┌───────────▼───────────┐
         │ await OCR(buffer)     │
         │ (Tesseract.js mock)   │
         └───────────┬───────────┘
                     │
      ┌──────────────▼──────────────┐
      │ Extraer datos (parsedData)  │
      │  - NIF emisor/receptor      │
      │  - Fecha, número            │
      │  - Líneas, totales          │
      └──────────────┬──────────────┘
                     │
      ┌──────────────▼──────────────┐
      │ Actualizar documento:       │
      │  status: READY_FOR_VERIFICATION
      │  parsedData: {...}          │
      └──────────────────────────────┘
                     │
      Luego: Usuario ve en GET /pending
              y puede corregir (PUT /:id)
              o verificar (POST /:id/verify)
```

---

## Flujo de datos: Verificar documento y crear factura

```
┌──────────────────────────────────────────────────────────┐
│ POST /api/income-reader/{docId}/verify                   │
└────────────────────┬──────────────────────────────────────┘
                     │
                Controller
                     │
┌────────────────────▼──────────────────────────────────────┐
│ incomeReaderController.verificar()                        │
│  - Registra auditoría                                      │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│ incomeReaderService.verificarYCrearFactura(docId)        │
│  ├─ Cargar documento (debe estar READY_FOR_VERIFICATION) │
│  ├─ Resolver/crear cliente (NIF del emisor)             │
│  │   ├─ Si existe: reutilizar                            │
│  │   └─ Si no: crear automático                          │
│  ├─ Mapear líneas extraídas                              │
│  └─ Llamar incomeInvoicesService.crearIngreso({...})    │
│      (reutiliza lógica de cálculo de totales)           │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│ incomeInvoicesService.crearIngreso()                     │
│  (procesa como una factura normal)                       │
│  Retorna: {invoice: {...}}                               │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│ incomeReaderService.verificarYCrearFactura() continúa:  │
│  ├─ prisma.incomeReaderDocument.update({                │
│  │     status: 'VERIFIED',                              │
│  │     linkedInvoiceId: invoice.id                      │
│  │   })                                                  │
│  └─ Retorna: {documentoId, status, linkedInvoiceId}    │
└────────────────────┬──────────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────────┐
│ Response 201: Documento VERIFIED + Factura creada        │
│                                                           │
│ La factura ahora aparece en:                             │
│  - GET /api/invoices/income                             │
│  - Reportes y análisis                                   │
│  - Panel de ingresos (estados, totales, vencimientos)   │
└──────────────────────────────────────────────────────────┘
```

---

## Modelo de datos (Prisma)

### IncomeInvoice

```prisma
model IncomeInvoice {
  id                  String    @id @default(cuid())
  companyId           String
  customerId          String    // FK a Customer
  
  // Numeración
  serie               String    // "2024"
  numero              Int       // 25
  numeroCompleto      String    @unique // "2024-25"
  
  // Fechas
  fechaEmision        String    // YYYY-MM-DD
  fechaVencimiento    String    // YYYY-MM-DD
  
  // Estado y totales
  estado              String    @default("PENDING") // DRAFT, PENDING, PAID, OVERDUE
  baseTotal           Float     @default(0)
  ivaTotal            Float     @default(0)
  retencionTotal      Float     @default(0)
  totalFactura        Float     @default(0)
  
  // Metadatos
  plantillaId         String    @default("default")
  observaciones       String?
  esRectificativa     Boolean   @default(false)
  facturaOriginalId   String?   // Si es abono
  esRecurrente        Boolean   @default(false)
  recurrenciaConfig   String?   // JSON patrón
  
  // Auditoría
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  
  // Relaciones
  lineas              IncomeInvoiceLine[]
  customer            Customer
  readerDocument      IncomeReaderDocument?

  @@unique([companyId, serie, numero])
  @@index([companyId, estado])
}
```

### IncomeInvoiceLine

```prisma
model IncomeInvoiceLine {
  id                  String
  invoiceId           String    // FK
  
  // Descripción del concepto
  descripcion         String
  cantidad            Float
  precioUnitario      Float
  
  // Cálculos
  baseLine            Float     // cantidad × precio - descuento
  descuentoPorcentaje Float     @default(0)
  descuentoImporte    Float     @default(0)
  
  // Impuestos
  tipoIva             Int       @default(21)     // 0, 4, 10, 21
  ivaImporte          Float     @default(0)      // baseLine × tipoIva / 100
  tipoRetencion       Int       @default(0)      // 0, 7, 15, 19
  retencionImporte    Float     @default(0)      // baseLine × tipoRetencion / 100
  
  productoServicioId  String?
  invoice             IncomeInvoice @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  
  @@index([invoiceId])
}
```

### IncomeReaderDocument

```prisma
model IncomeReaderDocument {
  id                    String
  companyId             String
  userId                String?
  
  // Origen
  sourceType            String  // MOBILE_CAMERA, WEB_UPLOAD, EMAIL_FORWARD
  originalFileName      String
  mimeType              String
  fileSize              Int
  storagePath           String  // /storage/income-documents/{uuid}
  
  // Pipeline
  status                String  @default("UPLOADED")
                                // UPLOADED → IN_REVIEW → READY_FOR_VERIFICATION → VERIFIED / REJECTED
  uploadedAt            DateTime  @default(now())
  processingStartedAt   DateTime?
  processingCompletedAt DateTime?
  verifiedAt            DateTime?
  
  // Datos extraídos
  parsedData            Json?   // ParsedInvoiceData
  
  // Vinculación con factura
  linkedInvoiceId       String?   @unique
  rejectionReason       String?
  
  invoice               IncomeInvoice? @relation(fields: [linkedInvoiceId], references: [id])
  
  @@index([companyId, status])
}
```

### Customer

```prisma
model Customer {
  id            String
  companyId     String
  nombreFiscal  String
  nifCif        String
  
  // Datos fiscales
  direccion     String?
  pais          String      @default("ES")
  provincia     String?
  municipio     String?
  cp            String?
  email         String?
  
  activo        Boolean     @default(true)
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
  
  invoices      IncomeInvoice[]
  
  @@unique([companyId, nifCif])
  @@index([companyId])
}
```

---

## Flujo de cálculos

### Cálculo de totales en una factura

```
Para cada línea:
  1. baseLine = (cantidad × precioUnitario) - descuentoImporte
     descuentoImporte = (cantidad × precioUnitario) × descuentoPorcentaje / 100
  
  2. ivaImporte = baseLine × tipoIva / 100
  
  3. retencionImporte = baseLine × tipoRetencion / 100

Totales de factura:
  baseTotal = Σ baseLine
  ivaTotal = Σ ivaImporte
  retencionTotal = Σ retencionImporte
  totalFactura = baseTotal + ivaTotal - retencionTotal
```

### Determinación de estado

```
if (fechaVencimiento < hoy) AND (estado != PAID):
  estado = OVERDUE
else if (estado != PAID):
  estado = PENDING
else:
  estado = PAID
```

---

## Flujos de integración

### Con el panel de ingresos (Vista General)

```
Panel solicita: GET /api/invoices/income/resumen/periodo
  ├─ totalFacturas: count(*)
  ├─ baseCobrada: sum(baseTotal WHERE estado=PAID)
  ├─ basePendiente: sum(baseTotal WHERE estado=PENDING)
  ├─ baseVencida: sum(baseTotal WHERE estado=OVERDUE)
  ├─ ivaTotal: sum(ivaTotal)
  ├─ ivaAIngresar: sum(ivaTotal WHERE estado=PAID)
  ├─ ivaADevolver: sum(ivaTotal WHERE estado=PAID AND ivaTotal<0)
  └─ irpfTotal: sum(retencionTotal)

Luego panel pinta:
  - Tarjetas KPI
  - Gráficos de evolución
  - Análisis por cliente
  - Detalles de gastos (si integrado)
```

### Con lector OCR integrado

```
Usuario en panel:
  1. Arrastra un PDF/imagen
  2. POST /income-reader/web-upload
  3. Documento se procesa en background
  4. Usuario ve "Pendientes de verificar"
  5. Revisa datos (PUT /:id para corregir)
  6. Hace clic "Verificar" (POST /:id/verify)
  7. Factura aparece automáticamente en listado

No hay duplicación: misma BD, mismas reglas de cálculo.
```

---

## Consideraciones de seguridad

- **Autorización:** Endpoints requieren `ventas:write` (create/update) o `admin` (config)
- **Auditoría:** Todos los cambios registrados en AuditLog
- **Validación:** BD con constraints UNIQUE y NOT NULL
- **Almacenamiento:** Archivos guardados en `/storage` con uuid, no nombres originales
- **Confidencialidad:** parsedData puede contener NIFs/datos fiscales, mantener acceso restringido

---

## Notas de implementación futura

### TODO: Email

```
POST /api/invoices/income/{id}/send-email
  - Cargar plantilla (plantillaId)
  - Renderizar datos en PDF
  - Enviar por SMTP con configuración de empresa
  - Registrar log de envío
```

### TODO: Facturas recurrentes

```
POST /api/invoices/income/{id}/make-recurring
  - Guardar config: {frecuencia: 'mensual'|'trimestral', proximaFecha}
  - Job cronométrico que genera nuevas facturas
  - Misma serie, número autoincremental
```

### TODO: Integración OCR real

```
incomeReaderService.procesarOCR():
  - Tesseract.js para imágenes (JPG/PNG)
  - pdfjs para PDFs
  - O servicio en la nube: Azure Computer Vision, AWS Textract, Google Cloud Vision
  - Extraer fielmente: NIFs, fechas, líneas, totales
```

---

## Testing

### Unit tests

```
✓ calcularTotales() con descuentos, IVA, retenciones
✓ determinarEstado() por fechas
✓ resolverCliente() nuevo vs existente
✓ resolverNumeroFactura() autoincremento y evitar duplicados
✓ parseInvoiceData() desde JSON
```

### Integration tests

```
✓ POST /invoices/income: crear factura completa
✓ GET /invoices/income: listar con filtros
✓ PATCH /status: cambiar estado
✓ POST /credit-note: crear rectificativa
✓ POST /mobile-upload: subir doc
✓ PUT /:id: actualizar parsedData
✓ POST /:id/verify: crear factura desde doc
```
