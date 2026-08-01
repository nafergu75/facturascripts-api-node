# Integración de iLovePDF - OCR de Facturas

Guía completa de integración de la librería oficial de iLovePDF para procesamiento OCR de PDFs de facturas en Conta API.

## Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Instalación](#instalación)
3. [Configuración](#configuración)
4. [Arquitectura](#arquitectura)
5. [API Endpoints](#api-endpoints)
6. [Flujo del Usuario](#flujo-del-usuario)
7. [Ejemplos de Uso](#ejemplos-de-uso)
8. [Manejo de Errores](#manejo-de-errores)
9. [Límites y Cuotas](#límites-y-cuotas)
10. [Troubleshooting](#troubleshooting)

---

## Visión General

### ¿Por Qué iLovePDF?

- ✅ **Librería oficial** del servicio iLovePDF
- ✅ **OCR de alta calidad** para documentos escaneados
- ✅ **Soporte para múltiples idiomas** (español, inglés, etc.)
- ✅ **PDFs searchable** (con texto embebido)
- ✅ **API REST + SDK Node.js** bien documentada
- ✅ **Plan gratuito** con 150 MB / mes

### Flujo General

```
Usuario sube PDF
    ↓
Backend recibe en /ocr/invoices
    ↓
iLovePDF procesa OCR (5-10 segundos típicamente)
    ↓
Backend extrae texto con pdf-parse
    ↓
Retorna ocrText + ocrPdfPath
    ↓
Frontend envía ocrText a Claude para extracción contable
    ↓
Resultado contable guardado con referencia al PDF OCR
```

---

## Instalación

### Paso 1: Instalar dependencias

```bash
cd facturascripts-api-node

# iLovePDF (SDK oficial)
npm install ilovepdf

# Para extracción de texto de PDFs
npm install pdf-parse

# Ya están instaladas:
# - multer (para upload de archivos)
# - express, typescript, zod, dotenv
```

### Paso 2: Verificar instalación

```bash
npm list ilovepdf pdf-parse
# Debería mostrar ambas como instaladas
```

---

## Configuración

### Variables de Entorno

Crear/actualizar `.env` en la raíz del proyecto:

```bash
# iLovePDF API Keys (obtener de https://app.ilovepdf.com/user/profile/api)
ILOVEPDF_PUBLIC_KEY=your_public_key_here
ILOVEPDF_SECRET_KEY=your_secret_key_here

# Directorios temporales (opcionales)
TEMP_UPLOAD_DIR=/tmp/ocr/uploads
TEMP_OCR_DIR=/tmp/ocr/processed
```

### Obtener las Claves de API

1. Ir a https://app.ilovepdf.com/user/profile/api
2. Iniciar sesión (crear cuenta si es necesario)
3. Copiar `Public Key` y `Secret Key`
4. Guardar en `.env`

### Validar Configuración

```bash
# En la aplicación (se valida automáticamente al arrancar)
# Si falta alguna clave, error claro en logs
npm run dev
# Debería mostrar: "API escuchando en http://localhost:3000"
```

---

## Arquitectura

### Componentes Creados

#### 1. **Config** (`src/config/ilovepdf.config.ts`)
- Centraliza configuración de iLovePDF
- Valida variables de entorno
- Define límites y paths

#### 2. **Service** (`src/services/ilovepdf.service.ts`)
- Interfaz limpia con iLovePDF
- Manejo de errores específicos
- Polling con timeout
- Limpieza de archivos temporales

#### 3. **Utils** (`src/utils/pdfTextExtractor.ts`)
- Extrae texto de PDFs OCR
- Normaliza y limpia texto
- Validación de archivos PDF

#### 4. **Controller** (`src/controllers/ocr.controller.ts`)
- Orquesta upload, OCR y extracción
- Manejo HTTP y códigos de error
- Status del servicio

#### 5. **Routes** (`src/routes/ocr.routes.ts`)
- 3 endpoints principales
- Multer para upload seguro
- Validación de archivos

---

## API Endpoints

### 1. Procesar Factura con OCR

**Endpoint:** `POST /companies/:companyId/ocr/invoices`

**Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: multipart/form-data
```

**Parámetros:**
- `file` (requerido): Archivo PDF
- `invoiceType` (opcional): `expense` | `income` (default: `expense`)
- `language` (opcional): Código idioma (default: `es`)
- `source` (opcional): `email` | `manual` | `api` (default: `manual`)

**Request:**
```bash
curl -X POST http://localhost:3000/companies/1/ocr/invoices \
  -H "Authorization: Bearer <token>" \
  -F "file=@factura_123.pdf" \
  -F "invoiceType=expense" \
  -F "language=es"
```

**Response (200 OK):**
```json
{
  "ok": true,
  "data": {
    "ocrText": "FACTURA\nEmisor: Acme Corp\nNIF: A12345678\n...",
    "ocrPdfPath": "/tmp/ocr/processed/ocr_1721302345678_a1b2c3d4e.pdf",
    "pages": 1,
    "originalFileName": "factura_123.pdf",
    "processingTime": 8,
    "invoiceType": "expense",
    "charCount": 2547
  }
}
```

**Response (400 Bad Request):**
```json
{
  "ok": false,
  "error": "Invalid PDF file",
  "details": {
    "validationError": "File not found"
  }
}
```

**Response (503 Service Unavailable):**
```json
{
  "ok": false,
  "error": "iLovePDF authentication failed. Check API keys."
}
```

---

### 2. Obtener Estado del Servicio OCR

**Endpoint:** `GET /companies/:companyId/ocr/status`

**Headers:**
```
Authorization: Bearer <jwt_token>
```

**Request:**
```bash
curl http://localhost:3000/companies/1/ocr/status \
  -H "Authorization: Bearer <token>"
```

**Response (200 OK):**
```json
{
  "ok": true,
  "data": {
    "service": "iLovePDF",
    "status": "operational",
    "companyId": "1",
    "limits": {
      "maxFileSize": "150MB",
      "maxPages": 1000
    },
    "account": {
      "authenticated": true,
      "timestamp": "2026-07-18T10:30:45Z"
    },
    "diskUsage": {
      "uploads": "0 B",
      "ocr": "125 MB"
    },
    "timestamp": "2026-07-18T10:30:50Z"
  }
}
```

---

### 3. Limpiar Archivos Temporales

**Endpoint:** `POST /companies/:companyId/ocr/cleanup`

**Headers:**
```
Authorization: Bearer <jwt_token>
Content-Type: application/json
```

**Body:**
```json
{
  "daysOld": 7
}
```

**Request:**
```bash
curl -X POST http://localhost:3000/companies/1/ocr/cleanup \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"daysOld": 7}'
```

**Response (200 OK):**
```json
{
  "ok": true,
  "data": {
    "deleted": 5,
    "failed": 0,
    "timestamp": "2026-07-18T10:35:20Z"
  }
}
```

---

## Flujo del Usuario

### 1. Frontend Sube PDF

```typescript
// En React/Next.js (conta-api-web)
const handleInvoiceUpload = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('invoiceType', 'expense');
  formData.append('language', 'es');

  const response = await fetch(
    `/api/companies/1/ocr/invoices`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    }
  );

  const { ok, data, error } = await response.json();
  if (ok) {
    // data.ocrText contiene el texto extraído
    // data.ocrPdfPath es la referencia al PDF OCR
    return {
      ocrText: data.ocrText,
      ocrPdfPath: data.ocrPdfPath,
      pages: data.pages,
    };
  } else {
    console.error('OCR Error:', error);
  }
};
```

### 2. Frontend Envía Texto a Claude

```typescript
// Usar el ocrText para extracción contable
const extractInvoiceData = async (ocrText: string) => {
  const response = await fetch('/api/invoice-extractor/extract', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      ocrText, // <-- Texto del OCR
      invoiceType: 'expense',
      language: 'es',
      // ... otros parámetros
    }),
  });

  return response.json();
};
```

### 3. Guardar Referencia al PDF OCR

```typescript
// Guardar en base de datos junto con datos contables
const saveInvoice = async (data: any, ocrPdfPath: string) => {
  await fetch('/api/invoice/save', {
    method: 'POST',
    body: JSON.stringify({
      ...data, // datos contables extraídos por Claude
      ocrPdfPath, // referencia al PDF OCR
      processingDate: new Date(),
    }),
  });
};
```

---

## Ejemplos de Uso

### Ejemplo 1: Procesar Factura de Gasto

```bash
# 1. Subir PDF y obtener OCR
curl -X POST http://localhost:3000/companies/1/ocr/invoices \
  -H "Authorization: Bearer eyJ..." \
  -F "file=@gastos/factura_gasolina.pdf" \
  -F "invoiceType=expense" \
  -F "source=email"

# Respuesta:
{
  "ok": true,
  "data": {
    "ocrText": "FACTURA DE COMPRA\nProveedor: Shell Español\n...",
    "ocrPdfPath": "/tmp/ocr/processed/ocr_1721302345678_xyz.pdf",
    "pages": 1,
    "processingTime": 6,
    "charCount": 1845
  }
}

# 2. Usar ocrText con Claude (vía tu endpoint actual)
# POST /invoice-extractor/extract
{
  "ocrText": "FACTURA DE COMPRA...",
  "invoiceType": "expense",
  "language": "es"
}
```

### Ejemplo 2: Factura de Venta Multipágina

```typescript
// En Node.js backend
const response = await fetch('http://localhost:3000/companies/1/ocr/invoices', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${jwt}`,
  },
  body: formData, // PDF de 2 páginas
});

const { data } = await response.json();
console.log(`Procesadas ${data.pages} páginas`);
console.log(`Texto extraído: ${data.charCount} caracteres`);
console.log(`Tiempo: ${data.processingTime}s`);

// Guardar PDF OCR para auditoría
await saveAuditReference(data.ocrPdfPath, data.originalFileName);
```

---

## Manejo de Errores

### Errores Comunes

| Código | HTTP | Causa | Solución |
|--------|------|-------|----------|
| `FILE_NOT_FOUND` | 400 | Archivo no existe | Verificar ruta |
| `FILE_TOO_LARGE` | 413 | > 150MB | Dividir o comprimir PDF |
| `AUTH_FAILED` | 503 | Claves API inválidas | Verificar .env |
| `INSUFFICIENT_CREDITS` | 503 | Sin cuota en iLovePDF | Esperar renovación o upgrade |
| `TIMEOUT` | 504 | Procesamiento > 10 min | PDF muy complejo, reintentar |
| `PROCESSING_ERROR` | 500 | Error interno | Ver logs |

### Ejemplo: Manejo en Frontend

```typescript
const processInvoice = async (file: File) => {
  try {
    const response = await fetch('/api/companies/1/ocr/invoices', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const { error, details } = await response.json();
      
      switch (response.status) {
        case 400:
          toast.error(`PDF inválido: ${error}`);
          break;
        case 413:
          toast.error('PDF muy grande (máx 150MB)');
          break;
        case 503:
          toast.error('Servicio OCR no disponible');
          break;
        case 504:
          toast.error('Procesamiento tardó demasiado, reintentar');
          break;
        default:
          toast.error(`Error: ${error}`);
      }
      return;
    }

    const { data } = await response.json();
    console.log('OCR exitoso:', data);
  } catch (err) {
    toast.error('Error de conexión');
  }
};
```

---

## Límites y Cuotas

### Plan Gratuito de iLovePDF

- **Cuota mensual:** 150 MB / mes
- **Archivo máximo:** 150 MB
- **Páginas máximo:** 1000 por tarea
- **Rate limit:** ~100 req/hora
- **Idiomas soportados:** 100+

### Recomendaciones

1. **Monitorear uso:** Revisar https://app.ilovepdf.com/dashboard
2. **Plan pagado:** Si necesitas > 150MB/mes, considerar plan premium
3. **Caché local:** Guardar PDFs OCR para evitar reprocesar
4. **Cleanup automático:** Ejecutar `/ocr/cleanup` regularmente

### Verificar Uso Actual

```bash
# Ver tamaño de archivos OCR almacenados
curl http://localhost:3000/companies/1/ocr/status \
  -H "Authorization: Bearer <token>"

# Respuesta muestra:
# "diskUsage": { "uploads": "0 B", "ocr": "125 MB" }
```

---

## Troubleshooting

### Error: "iLovePDF authentication failed"

**Causa:** Claves API inválidas o no configuradas

**Solución:**
```bash
# 1. Verificar .env
grep ILOVEPDF .env

# 2. Si vacío, obtener claves de:
# https://app.ilovepdf.com/user/profile/api

# 3. Guardar en .env:
ILOVEPDF_PUBLIC_KEY=your_actual_key
ILOVEPDF_SECRET_KEY=your_actual_secret

# 4. Reiniciar servidor
npm run dev
```

### Error: "Insufficient credits"

**Causa:** Has usado toda la cuota mensual (150 MB)

**Solución:**
- Esperar a que se renueve el 1 del mes siguiente
- O contratar plan premium en https://app.ilovepdf.com

### Error: "File too large"

**Causa:** PDF > 150 MB

**Solución:**
```bash
# Comprimir PDF antes de subir
# Con ImageMagick:
convert -density 150 -quality 60 input.pdf output.pdf

# Con Ghostscript:
gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite \
   -dCompatibilityLevel=1.4 -r150x150 \
   -sOutputFile=output.pdf input.pdf
```

### Slow OCR (tarda > 10 segundos)

**Causa:** PDF tiene imágenes de baja calidad o muchas páginas

**Solución:**
- Aumentar timeout en `ILovePDFService` (maxAttempts)
- Pre-procesar imagen del PDF para mejorar calidad
- Dividir PDF multipage en documentos individuales

### PDFTextExtractor falla

**Causa:** PDF no es searchable (imagen pura sin OCR)

**Solución:** Asegurar que el PDF viene de iLovePDF (es searchable)

```typescript
// Verificar que PDF es válido
const validation = await validatePdfFile('/tmp/ocr/processed/xxx.pdf');
if (!validation.isValid) {
  console.error('PDF no es válido:', validation.error);
}
```

---

## Integración con Flujo Actual

### Antes (solo Claude)

```
Factura escaneada (imagen)
  ↓
Enviar imagen a Claude
  ↓ (Claude intenta OCR, no siempre preciso)
Extracción contable
```

### Ahora (iLovePDF + Claude)

```
Factura escaneada (imagen PDF)
  ↓
Enviar a /ocr/invoices
  ↓
iLovePDF hace OCR profesional
  ↓
Extrae texto con pdf-parse
  ↓
Enviar ocrText a Claude
  ↓ (Claude ya tiene texto puro, muy preciso)
Extracción contable
  ↓
Guardar con referencia a ocrPdfPath
```

### Cambios Mínimos en Flujo Existente

✅ **No cambiar:** Prompt de Claude, estructura de datos, endpoints contables

✅ **Solo agregar:** Paso previo de OCR con iLovePDF

✅ **Resultado:** Mayor precisión en extracción, especialmente con PDFs escaneados

---

## Testing

### Test Manual con cURL

```bash
# 1. Obtener token JWT
TOKEN=$(curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"pass"}' | jq -r '.token')

# 2. Subir PDF y procesar
curl -X POST http://localhost:3000/companies/1/ocr/invoices \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@test-invoice.pdf" \
  -F "invoiceType=expense" \
  -F "language=es" \
  | jq '.'

# 3. Verificar status
curl http://localhost:3000/companies/1/ocr/status \
  -H "Authorization: Bearer $TOKEN" \
  | jq '.data.diskUsage'
```

### Test Programático (Jest)

```typescript
// src/controllers/ocr.controller.test.ts
describe('OCR Controller', () => {
  it('should process invoice PDF with OCR', async () => {
    const response = await request(app)
      .post('/companies/1/ocr/invoices')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', 'test-data/factura.pdf')
      .field('invoiceType', 'expense')
      .field('language', 'es');

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.ocrText).toMatch(/FACTURA|Invoice|Facture/i);
    expect(response.body.data.ocrPdfPath).toContain('ocr_');
  });
});
```

---

## Performance

### Tiempos Típicos

| Operación | Tiempo |
|-----------|--------|
| Upload + iLovePDF | 5-10s |
| Extracción de texto | 0.5-1s |
| **Total** | **5-11s** |

### Optimizaciones

1. **Caché de PDFs OCR:** No reprocesar si ya está hecho
2. **Compresión previa:** Reducir tamaño antes de iLovePDF
3. **Limpieza automática:** Liberar espacio disco
4. **Rate limiting:** Evitar saturar cuota

---

## Referencias

- [iLovePDF GitHub](https://github.com/ilovepdf)
- [iLovePDF API Docs](https://developer.ilovepdf.com/)
- [pdf-parse NPM](https://www.npmjs.com/package/pdf-parse)
- [iLovePDF Dashboard](https://app.ilovepdf.com)

---

**Versión:** 1.0  
**Fecha:** 2026-07-18  
**Status:** ✅ Producción
