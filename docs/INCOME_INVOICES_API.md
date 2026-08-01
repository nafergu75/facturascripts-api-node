# API de Facturas de Ingreso y Lector Automático

Documentación completa de la API para crear facturas de ingreso y procesar documentos OCR.

## Tabla de contenidos

1. [Flujo de Facturas de Ingreso](#flujo-de-facturas-de-ingreso)
2. [Endpoints de Facturas](#endpoints-de-facturas)
3. [Flujo del Lector Automático](#flujo-del-lector-automático)
4. [Endpoints del Lector](#endpoints-del-lector)
5. [Ejemplos de Integración](#ejemplos-de-integración)

---

## Flujo de Facturas de Ingreso

### Diagrama del flujo

```
Usuario → "Crear ingreso" → "Nuevo ingreso" → "Factura"
    ↓
Rellena: datos fiscales, cliente, serie, fechas, líneas, IVA, retenciones
    ↓
API POST /invoices/income
    ↓
Valida cliente (existente o nuevo), numeración, cálculo de totales
    ↓
Crea factura en BD con estado PENDING (o OVERDUE si está vencida)
    ↓
Aparece en panel de ingresos con: cliente, fechas, totales, estado
    ↓
Puede pasar a PAID, ser rectificativa, periódica, enviarse por email
```

---

## Endpoints de Facturas

### 1. Crear factura de ingreso

**Endpoint:**
```http
POST /api/invoices/income
```

**Headers:**
```
Authorization: Bearer {token}
Content-Type: application/json
```

**Request body:**
```json
{
  "customer": {
    "id": "cust-123"
  },
  "serie": "2024",
  "numero": 25,
  "fechaEmision": "2024-06-13",
  "fechaVencimiento": "2024-06-28",
  "lineas": [
    {
      "descripcion": "Servicio de consultoría",
      "cantidad": 1,
      "precioUnitario": 1000,
      "descuentoPorcentaje": 0,
      "tipoIva": 21,
      "tipoRetencion": 15
    },
    {
      "descripcion": "Desarrollo de software",
      "cantidad": 40,
      "precioUnitario": 50,
      "descuentoPorcentaje": 10,
      "tipoIva": 21,
      "tipoRetencion": 0
    }
  ],
  "plantillaId": "default",
  "observaciones": "Gracias por su confianza"
}
```

**Response (201):**
```json
{
  "invoice": {
    "id": "inv-uuid-1",
    "companyId": "comp-uuid",
    "customerId": "cust-123",
    "serie": "2024",
    "numero": 25,
    "numeroCompleto": "2024-25",
    "fechaEmision": "2024-06-13",
    "fechaVencimiento": "2024-06-28",
    "estado": "PENDING",
    "baseTotal": 2800,
    "ivaTotal": 588,
    "retencionTotal": 420,
    "totalFactura": 2968,
    "plantillaId": "default",
    "observaciones": "Gracias por su confianza",
    "esRectificativa": false,
    "esRecurrente": false,
    "createdAt": "2024-06-13T10:00:00Z",
    "updatedAt": "2024-06-13T10:00:00Z",
    "lineas": [
      {
        "id": "linea-uuid-1",
        "descripcion": "Servicio de consultoría",
        "cantidad": 1,
        "precioUnitario": 1000,
        "baseLine": 1000,
        "descuentoPorcentaje": 0,
        "descuentoImporte": 0,
        "tipoIva": 21,
        "ivaImporte": 210,
        "tipoRetencion": 15,
        "retencionImporte": 150
      },
      {
        "id": "linea-uuid-2",
        "descripcion": "Desarrollo de software",
        "cantidad": 40,
        "precioUnitario": 50,
        "baseLine": 1800,
        "descuentoPorcentaje": 10,
        "descuentoImporte": 200,
        "tipoIva": 21,
        "ivaImporte": 378,
        "tipoRetencion": 0,
        "retencionImporte": 0
      }
    ]
  }
}
```

**Crear con cliente nuevo:**
```json
{
  "customer": {
    "nuevo": {
      "nombreFiscal": "Acme Inc.",
      "nifCif": "B12345678",
      "direccion": "C/ Ejemplo 1",
      "pais": "ES",
      "provincia": "Barcelona",
      "municipio": "Barcelona",
      "cp": "08001",
      "email": "acme@example.com"
    }
  },
  "serie": "2024",
  "lineas": [
    {
      "descripcion": "Producto",
      "cantidad": 1,
      "precioUnitario": 100,
      "tipoIva": 21
    }
  ]
}
```

---

### 2. Listar facturas de ingreso

**Endpoint:**
```http
GET /api/invoices/income?estado=PENDING&desde=2024-01-01&hasta=2024-12-31&skip=0&take=20
```

**Response (200):**
```json
{
  "items": [
    {
      "id": "inv-uuid-1",
      "companyId": "comp-uuid",
      "customerId": "cust-123",
      "customerNombre": "Acme Inc.",
      "serie": "2024",
      "numero": 25,
      "numeroCompleto": "2024-25",
      "fechaEmision": "2024-06-13",
      "fechaVencimiento": "2024-06-28",
      "estado": "PENDING",
      "baseTotal": 2800,
      "ivaTotal": 588,
      "retencionTotal": 420,
      "totalFactura": 2968,
      "esRectificativa": false,
      "createdAt": "2024-06-13T10:00:00Z",
      "updatedAt": "2024-06-13T10:00:00Z"
    }
  ],
  "total": 1,
  "skip": 0,
  "take": 20
}
```

---

### 3. Obtener factura por ID

**Endpoint:**
```http
GET /api/invoices/income/inv-uuid-1
```

**Response (200):**
```json
{
  "invoice": {
    "id": "inv-uuid-1",
    "companyId": "comp-uuid",
    "customerId": "cust-123",
    "serie": "2024",
    "numero": 25,
    "numeroCompleto": "2024-25",
    "fechaEmision": "2024-06-13",
    "fechaVencimiento": "2024-06-28",
    "estado": "PENDING",
    "baseTotal": 2800,
    "ivaTotal": 588,
    "retencionTotal": 420,
    "totalFactura": 2968,
    "plantillaId": "default",
    "observaciones": "Gracias por su confianza",
    "esRectificativa": false,
    "facturaOriginalId": null,
    "esRecurrente": false,
    "createdAt": "2024-06-13T10:00:00Z",
    "updatedAt": "2024-06-13T10:00:00Z",
    "lineas": [
      {
        "id": "linea-uuid-1",
        "descripcion": "Servicio de consultoría",
        "cantidad": 1,
        "precioUnitario": 1000,
        "baseLine": 1000,
        "descuentoPorcentaje": 0,
        "descuentoImporte": 0,
        "tipoIva": 21,
        "ivaImporte": 210,
        "tipoRetencion": 15,
        "retencionImporte": 150
      }
    ]
  }
}
```

---

### 4. Cambiar estado de factura (cobro)

**Endpoint:**
```http
PATCH /api/invoices/income/inv-uuid-1/status
```

**Request body:**
```json
{
  "estado": "PAID"
}
```

**Response (200):**
```json
{
  "invoice": {
    "id": "inv-uuid-1",
    "estado": "PAID",
    "totalFactura": 2968,
    "lineas": [...]
  }
}
```

---

### 5. Crear factura rectificativa (abono)

**Endpoint:**
```http
POST /api/invoices/income/inv-uuid-1/credit-note
```

**Request body (opcional):**
```json
{
  "lineas": [
    {
      "descripcion": "Devolución - Consultoría",
      "cantidad": -1,
      "precioUnitario": 1000,
      "tipoIva": 21,
      "tipoRetencion": 15
    }
  ]
}
```

Si no se proporcionan líneas, automáticamente se niegan las de la factura original.

**Response (201):**
```json
{
  "invoice": {
    "id": "inv-uuid-2",
    "numero": 26,
    "numeroCompleto": "2024-26",
    "esRectificativa": true,
    "facturaOriginalId": "inv-uuid-1",
    "totalFactura": -2968,
    "observaciones": "Rectificativa de 2024-25",
    "lineas": [
      {
        "descripcion": "Devolución - Consultoría",
        "cantidad": -1,
        "precioUnitario": 1000,
        "baseLine": -1000,
        "tipoIva": 21,
        "ivaImporte": -210,
        "tipoRetencion": 15,
        "retencionImporte": -150
      }
    ]
  }
}
```

---

### 6. Resumen de ingresos por período (Dashboard)

**Endpoint:**
```http
GET /api/invoices/income/resumen/periodo?desde=2024-01-01&hasta=2024-12-31
```

**Response (200):**
```json
{
  "resumen": {
    "totalFacturas": 10,
    "baseCobrada": 8000,
    "basePendiente": 2000,
    "baseVencida": 500,
    "ivaTotal": 1890,
    "ivaAIngresar": 1890,
    "ivaADevolver": 0,
    "irpfTotal": 180
  }
}
```

---

## Flujo del Lector Automático

### Diagrama del flujo

```
Usuario quiere digitalizar facturas/tickets de ingreso
    ↓
3 formas de entrada:
  1. Foto desde app móvil → POST /mobile-upload
  2. Drag & drop desde web → POST /web-upload
  3. Reenviar por email → POST /email-hook
    ↓
Documento se guarda (UPLOADED) y se encola para OCR
    ↓
Equipo OCR procesa (IN_REVIEW → READY_FOR_VERIFICATION) en max 24h
    ↓
Usuario ve documento en "Pendientes de verificar"
    ↓
Revisa datos extraídos, puede corregir (PUT /:id)
    ↓
Hace clic en "Verificar" → POST /:id/verify
    ↓
Se crea la factura de ingreso automáticamente
    ↓
Aparece en panel de ingresos (igual que facturas manuales)
```

---

## Endpoints del Lector

### 1. Subir documento desde app móvil

**Endpoint:**
```http
POST /api/income-reader/mobile-upload
```

**Headers:**
```
Authorization: Bearer {token}
Content-Type: image/jpeg (o image/png, application/pdf, etc.)
```

**Body:** archivo binario (imagen/PDF)

**Query params (opcional):**
```
?nombre=factura.jpg
```

**Alternative: JSON con base64:**
```json
{
  "nombreArchivo": "factura.jpg",
  "mimeType": "image/jpeg",
  "contenidoBase64": "iVBORw0KGgoAAAANSUhEUgAAAAUA..."
}
```

**Response (201):**
```json
{
  "document": {
    "id": "doc-uuid-1",
    "companyId": "comp-uuid",
    "sourceType": "MOBILE_CAMERA",
    "originalFileName": "factura.jpg",
    "status": "UPLOADED",
    "uploadedAt": "2024-06-13T10:00:00Z"
  }
}
```

---

### 2. Subir documento desde web

**Endpoint:**
```http
POST /api/income-reader/web-upload
```

**Igual que mobile-upload, pero sourceType = WEB_UPLOAD**

---

### 3. Webhook para email

**Endpoint:**
```http
POST /api/income-reader/email-hook
```

**Headers:**
```
Content-Type: application/json
```

**Request body:**
```json
{
  "readerEmail": "empresa+lector@platform.com",
  "remitente": "proveedor@example.com",
  "adjuntos": [
    {
      "nombre": "factura.pdf",
      "mimetype": "application/pdf",
      "buffer": "JVBERi0xLjQKJeLj..." // base64
    }
  ]
}
```

**Response (201):**
```json
{
  "documents": [
    {
      "id": "doc-uuid-2",
      "companyId": "comp-uuid",
      "sourceType": "EMAIL_FORWARD",
      "originalFileName": "factura.pdf",
      "status": "UPLOADED",
      "uploadedAt": "2024-06-13T10:00:00Z"
    }
  ],
  "cantidad": 1
}
```

---

### 4. Listar documentos pendientes de verificar

**Endpoint:**
```http
GET /api/income-reader/pending
```

**Response (200):**
```json
{
  "documents": [
    {
      "id": "doc-uuid-1",
      "companyId": "comp-uuid",
      "sourceType": "MOBILE_CAMERA",
      "originalFileName": "factura.jpg",
      "status": "READY_FOR_VERIFICATION",
      "uploadedAt": "2024-06-13T10:00:00Z",
      "processingCompletedAt": "2024-06-13T10:02:00Z",
      "parsedData": {
        "nifEmisor": "B12345678",
        "nombreEmisor": "Proveedor S.A.",
        "numero": "2024-001",
        "fecha": "2024-06-10",
        "fechaVencimiento": "2024-06-25",
        "baseImponible": 1000,
        "totalIva": 210,
        "totalRetencion": 0,
        "total": 1210,
        "lineas": [
          {
            "descripcion": "Servicio profesional",
            "cantidad": 1,
            "precioUnitario": 1000,
            "baseImponible": 1000,
            "tipoIva": 21,
            "totalLinea": 1210
          }
        ],
        "confianza": 0,
        "tipoDetectado": "compra"
      }
    }
  ],
  "cantidad": 1
}
```

---

### 5. Obtener detalle de un documento

**Endpoint:**
```http
GET /api/income-reader/doc-uuid-1
```

**Response (200):**
```json
{
  "document": {
    "id": "doc-uuid-1",
    "companyId": "comp-uuid",
    "sourceType": "MOBILE_CAMERA",
    "originalFileName": "factura.jpg",
    "status": "READY_FOR_VERIFICATION",
    "uploadedAt": "2024-06-13T10:00:00Z",
    "processingStartedAt": "2024-06-13T10:00:30Z",
    "processingCompletedAt": "2024-06-13T10:02:00Z",
    "parsedData": { ... },
    "linkedInvoiceId": null,
    "rejectionReason": null
  }
}
```

---

### 6. Actualizar datos extraídos (correcciones manuales)

**Endpoint:**
```http
PUT /api/income-reader/doc-uuid-1
```

**Request body:** parcial, solo campos a modificar
```json
{
  "numero": "2024-001",
  "fecha": "2024-06-10",
  "nifEmisor": "B12345678",
  "nombreEmisor": "Proveedor S.A.",
  "baseImponible": 1000,
  "totalIva": 210,
  "lineas": [
    {
      "descripcion": "Servicio profesional",
      "cantidad": 1,
      "precioUnitario": 1000,
      "baseImponible": 1000,
      "tipoIva": 21
    }
  ]
}
```

**Response (200):**
```json
{
  "document": {
    "id": "doc-uuid-1",
    "parsedData": { ... actualizado ... }
  }
}
```

---

### 7. Verificar documento y crear factura

**Endpoint:**
```http
POST /api/income-reader/doc-uuid-1/verify
```

**Body:** (vacío)

**Response (201):**
```json
{
  "documentoId": "doc-uuid-1",
  "status": "VERIFIED",
  "linkedInvoiceId": "inv-uuid-3"
}
```

A partir de aquí, la factura `inv-uuid-3` aparece en:
- Panel de ingresos
- Listado de facturas
- Reportes de IVA y retenciones
- Estados: cobrada, pendiente, vencida

---

### 8. Rechazar documento

**Endpoint:**
```http
POST /api/income-reader/doc-uuid-1/reject
```

**Request body:**
```json
{
  "motivo": "Documento ilegible"
}
```

**Response (200):**
```json
{
  "document": {
    "id": "doc-uuid-1",
    "status": "REJECTED",
    "rejectionReason": "Documento ilegible"
  }
}
```

---

### 9. Obtener configuración de email del lector

**Endpoint:**
```http
GET /api/income-reader/config
```

**Response (200):**
```json
{
  "config": {
    "readerEmail": "empresa+lector@platform.com",
    "isActive": true
  }
}
```

---

### 10. Crear/actualizar configuración de email

**Endpoint:**
```http
POST /api/income-reader/config
```

**Request body:**
```json
{
  "readerEmail": "empresa+lector@platform.com",
  "isActive": true
}
```

**Response (201):**
```json
{
  "config": {
    "readerEmail": "empresa+lector@platform.com",
    "isActive": true
  }
}
```

---

## Ejemplos de Integración

### Flujo completo: Crear factura manual

```bash
# 1. Crear factura
curl -X POST http://localhost:3000/api/invoices/income \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "cust-123"},
    "serie": "2024",
    "numero": 25,
    "fechaEmision": "2024-06-13",
    "lineas": [
      {
        "descripcion": "Servicio",
        "cantidad": 1,
        "precioUnitario": 1000,
        "tipoIva": 21
      }
    ]
  }'

# Respuesta:
# {
#   "invoice": {
#     "id": "inv-uuid-1",
#     "numeroCompleto": "2024-25",
#     "estado": "PENDING",
#     "totalFactura": 1210,
#     ...
#   }
# }

# 2. Marcar como cobrada
curl -X PATCH http://localhost:3000/api/invoices/income/inv-uuid-1/status \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{"estado": "PAID"}'

# 3. Ver en listado
curl http://localhost:3000/api/invoices/income?estado=PAID \
  -H "Authorization: Bearer {token}"
```

### Flujo completo: Digitalizar factura por OCR

```bash
# 1. Subir documento desde móvil
curl -X POST http://localhost:3000/api/income-reader/mobile-upload \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: image/jpeg" \
  --data-binary @factura.jpg

# Respuesta:
# {
#   "document": {
#     "id": "doc-uuid-1",
#     "status": "UPLOADED"
#   }
# }

# 2. Esperar a que se procese (OCR tarda hasta 24h)
# Mientras tanto, el documento está en estado UPLOADED o IN_REVIEW

# 3. Ver documentos pendientes de verificar (cuando esté listo)
curl http://localhost:3000/api/income-reader/pending \
  -H "Authorization: Bearer {token}"

# Respuesta:
# {
#   "documents": [
#     {
#       "id": "doc-uuid-1",
#       "status": "READY_FOR_VERIFICATION",
#       "parsedData": { ... datos extraídos ... }
#     }
#   ]
# }

# 4. Corregir datos si es necesario
curl -X PUT http://localhost:3000/api/income-reader/doc-uuid-1 \
  -H "Authorization: Bearer {token}" \
  -H "Content-Type: application/json" \
  -d '{
    "nifEmisor": "B12345678",
    "nombreEmisor": "Proveedor Correcto",
    "baseImponible": 1000
  }'

# 5. Verificar y crear factura
curl -X POST http://localhost:3000/api/income-reader/doc-uuid-1/verify \
  -H "Authorization: Bearer {token}"

# Respuesta:
# {
#   "documentoId": "doc-uuid-1",
#   "status": "VERIFIED",
#   "linkedInvoiceId": "inv-uuid-2"
# }

# 6. La factura ahora aparece en el listado normal
curl http://localhost:3000/api/invoices/income/inv-uuid-2 \
  -H "Authorization: Bearer {token}"
```

---

## Validaciones y reglas de negocio

### Facturas de ingreso

- **Numeración:** Única por `companyId + serie + numero`
- **Fechas:** `fechaVencimiento` default = `fechaEmision + 15 días`
- **Estado:** Auto-calculado según fecha:
  - `PENDING`: vencimiento ≥ hoy
  - `OVERDUE`: vencimiento < hoy (sin cobrar)
  - `PAID`: marcado por el usuario
- **Totales:** Calculados automáticamente desde líneas
- **Líneas:** Al menos 1 es obligatoria

### Lector OCR

- **Estados:** UPLOADED → IN_REVIEW → READY_FOR_VERIFICATION → VERIFIED
- **Procesamiento:** Hasta 24 horas (simulado con delay)
- **Edición:** Solo en estado READY_FOR_VERIFICATION
- **Verificación:** Crea automáticamente la factura
- **Rechazo:** Impide crear factura

---

## Notas de implementación

- **BD:** Prisma con MySQL (modelos: Customer, IncomeInvoice, IncomeInvoiceLine, IncomeReaderDocument, ReaderEmailConfig)
- **Almacenamiento:** Local en `/storage/income-documents` (en prod: S3/Blob)
- **OCR:** Mock actual (devuelve estructura vacía). Integrar con Tesseract.js, Azure CV, AWS Textract, etc.
- **Email:** Webhook para recibir por `empresa+lector@platform.com`
- **Auth:** Require `ventas:write` para crear/modificar, `admin` para configuración
- **Auditoría:** Todos los cambios se registran en AuditLog
