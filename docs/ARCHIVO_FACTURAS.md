# Módulo de Archivo de Facturas - Conta API

## Descripción General

El módulo de Archivo de Facturas permite gestionar, organizar y consultar todas las facturas procesadas (ingresos y gastos) en la plataforma Conta API. Incluye capacidades de búsqueda, filtrado por período, descarga de archivos y estadísticas de período.

## Arquitectura

### Backend (facturascripts-api-node)

#### Servicio: `src/services/documentoArchivo.service.ts`

Funciones principales:

- `crearDocumentoArchivo()`: Crea un nuevo registro de documento y almacena el archivo
- `listarDocumentosPorPeriodo()`: Lista documentos filtrados por año, mes, trimestre, tipo y estado
- `obtenerDocumento()`: Obtiene los detalles de un documento específico
- `descargarArchivo()`: Descarga un archivo desde el storage
- `actualizarEstadoDocumento()`: Cambia el estado de un documento
- `eliminarDocumento()`: Marca un documento como anulado (soft delete)
- `obtenerEstadisticasPeriodo()`: Calcula estadísticas (totales, IVA, retenciones)
- `buscarDocumentos()`: Busca documentos por número de factura o emisor

#### Controlador: `src/controllers/documentoArchivo.controller.ts`

Endpoints implementados:

- `POST /companies/:companyId/archivo` - Crear documento
- `GET /companies/:companyId/archivo` - Listar documentos
- `GET /companies/:companyId/archivo/:id` - Obtener documento
- `GET /companies/:companyId/archivo/:id/descargar` - Descargar archivo
- `PATCH /companies/:companyId/archivo/:id/estado` - Actualizar estado
- `DELETE /companies/:companyId/archivo/:id` - Eliminar/anular documento
- `GET /companies/:companyId/archivo/estadisticas/periodo` - Estadísticas
- `GET /companies/:companyId/archivo/buscar` - Buscar documentos

#### Rutas: `src/routes/archivo.routes.ts`

- Configuración de multer para subida de archivos (50 MB máx)
- Filtrado de tipos MIME permitidos (PDF, JPG, PNG, TIFF, Excel, TXT)
- Ordenamiento de rutas (rutas específicas antes que parametrizadas)

### Frontend (conta-api-web)

#### Página: `app/dashboard/archivo/page.tsx`

Características:

- **Filtros avanzados**: Por año, mes, trimestre, tipo (ingreso/gasto)
- **Búsqueda**: Por número de factura, emisor, receptor, nombre de archivo
- **Estadísticas por período**: Total de documentos, ingresos, gastos, IVA, retenciones
- **Tabla de documentos**: Con columnas de fecha, tipo, número, total, confianza OCR
- **Acciones**: Descargar y anular documentos
- **Responsivo**: Diseño adaptable a móvil, tablet y desktop

## Modelo de Datos

### DocumentoArchivo (Prisma)

```prisma
model DocumentoArchivo {
  id                    String        @id @default(cuid())
  companyId             String
  tipo                  String        // "ingreso" | "gasto"
  numeroFactura         String?
  emisor                String?
  receptor              String?
  nifCif                String?
  fecha                 String        // YYYY-MM-DD
  mes                   Int           // 1-12
  trimestre             Int           // 1-4
  año                   Int
  base                  Decimal?      @db.Decimal(14, 2)
  iva                   Decimal?      @db.Decimal(14, 2)
  retencion             Decimal?      @db.Decimal(14, 2)
  total                 Decimal?      @db.Decimal(14, 2)
  
  archivoNombre         String
  archivoTipo           String
  archivoTamaño         Int
  archivoPath           String
  archivoHash           String        // SHA-256
  
  readerDocumentId      String?
  incomeInvoiceId       String?
  origen                String?       // "manual_upload" | "ocr_extractor" | "email"
  estado                String        @default("activo") // "activo" | "reemplazado" | "anulado"
  confianza             Float?        // 0-1
  observaciones         String?
  
  uploadedBy            String?
  uploadedAt            DateTime
  updatedAt             DateTime
  
  @@index([companyId, año, mes])
  @@index([companyId, año, trimestre])
  @@index([companyId, año])
  @@index([companyId, tipo])
  @@index([companyId, uploadedAt])
}
```

## API Endpoints

### 1. Listar Documentos

```
GET /companies/:companyId/archivo?año=2026&mes=7&tipo=ingreso
```

**Query Parameters:**
- `año` (obligatorio): Número del año (ej. 2026)
- `mes` (opcional): 1-12
- `trimestre` (opcional): 1-4
- `tipo` (opcional): "ingreso" o "gasto"
- `estado` (opcional): "activo", "reemplazado", "anulado"
- `limite` (opcional, default=50): Registros por página
- `pagina` (opcional, default=1): Número de página

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "cuid...",
      "companyId": "company1",
      "tipo": "ingreso",
      "numeroFactura": "INV-2026-001",
      "emisor": "Mi Empresa",
      "receptor": "Cliente A",
      "fecha": "2026-07-17",
      "mes": 7,
      "trimestre": 3,
      "año": 2026,
      "base": 1000.00,
      "iva": 210.00,
      "total": 1210.00,
      "archivoNombre": "factura-001.pdf",
      "archivoTamaño": 245876,
      "estado": "activo",
      "confianza": 0.95,
      "uploadedAt": "2026-07-17T10:30:00Z",
      "updatedAt": "2026-07-17T10:30:00Z"
    }
  ],
  "meta": {
    "total": 150,
    "limite": 50,
    "pagina": 1
  }
}
```

### 2. Crear Documento

```
POST /companies/:companyId/archivo
Content-Type: multipart/form-data
```

**Form Fields:**
- `archivo` (file, obligatorio): PDF, JPG, PNG, TIFF, Excel o TXT
- `tipo` (string, obligatorio): "ingreso" o "gasto"
- `fecha` (string, obligatorio): YYYY-MM-DD
- `numeroFactura` (string, opcional)
- `emisor` (string, opcional)
- `receptor` (string, opcional)
- `nifCif` (string, opcional)
- `base` (number, opcional)
- `iva` (number, opcional)
- `retencion` (number, opcional)
- `total` (number, opcional)
- `origen` (string, opcional): "manual_upload", "ocr_extractor", "email"
- `confianza` (number, opcional): 0-1
- `observaciones` (string, opcional)

**Response:** (201 Created)
```json
{
  "ok": true,
  "data": {
    "id": "cuid...",
    "companyId": "company1",
    ...
  }
}
```

### 3. Obtener Documento

```
GET /companies/:companyId/archivo/:id
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "cuid...",
    ...
  }
}
```

### 4. Descargar Archivo

```
GET /companies/:companyId/archivo/:id/descargar
```

**Response:** (file binary)

Descarga el archivo original con cabeceras apropiadas de Content-Type y Content-Disposition.

### 5. Actualizar Estado

```
PATCH /companies/:companyId/archivo/:id/estado
Content-Type: application/json
```

**Body:**
```json
{
  "estado": "reemplazado",
  "observaciones": "Reemplazado por versión corregida"
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "id": "cuid...",
    "estado": "reemplazado",
    ...
  }
}
```

### 6. Eliminar/Anular Documento

```
DELETE /companies/:companyId/archivo/:id
```

**Response:**
```json
{
  "ok": true,
  "message": "Documento anulado correctamente"
}
```

Nota: No realiza un borrado físico, sino que marca el documento como "anulado".

### 7. Estadísticas de Período

```
GET /companies/:companyId/archivo/estadisticas/periodo?año=2026&mes=7
```

**Query Parameters:**
- `año` (obligatorio)
- `mes` (opcional)
- `trimestre` (opcional)

**Response:**
```json
{
  "ok": true,
  "data": {
    "totalDocumentos": 15,
    "totalIngresos": 25000.00,
    "totalGastos": 8500.00,
    "totalIVA": 4470.00,
    "totalRetencion": 125.00,
    "desglosePorTipo": {
      "ingreso": 10,
      "gasto": 5
    }
  }
}
```

### 8. Búsqueda de Documentos

```
GET /companies/:companyId/archivo/buscar?termino=INV-2026&tipo=ingreso&limite=20
```

**Query Parameters:**
- `termino` (obligatorio): Busca en número de factura, emisor, receptor
- `tipo` (opcional): "ingreso" o "gasto"
- `limite` (opcional, default=20)

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "cuid...",
      ...
    }
  ]
}
```

## Almacenamiento de Archivos

### Rutas Locales

```
storage/archivos/{companyId}/{año}/{mes-2d}/timestamp-nombrearchivo.ext
```

Ejemplo: `storage/archivos/company1/2026/07/1721212800000-factura-001.pdf`

### Vercel Blob (Producción)

Si está disponible `BLOB_READ_WRITE_TOKEN`, los archivos se almacenan en Vercel Blob con URLs públicas.

### Integridad de Archivos

- **Hash SHA-256**: Se calcula y almacena para cada archivo
- **Validación**: Puede verificarse comparando el hash almacenado con el hash actual del archivo descargado

## Seguridad

- **Validación de MIME types**: Solo se permiten tipos de archivo específicos
- **Límite de tamaño**: 50 MB máximo por archivo
- **Aislamiento de empresa**: Los documentos están asociados a una `companyId` específica
- **Soft deletes**: Los documentos se marcan como "anulado" en lugar de borrarse
- **Autenticación**: Todos los endpoints requieren token JWT válido
- **Autorización**: `companyScope` middleware valida que el usuario tenga acceso a la empresa

## Validaciones

### Fecha
- Formato: YYYY-MM-DD
- Debe ser una fecha válida
- Se calcula automáticamente mes y trimestre

### Montos (Decimals)
- Base, IVA, retención y total se almacenan con 14,2 dígitos (hasta 999.999.999,99)
- Se convierten a Decimal en la BD para evitar errores de punto flotante

### Tipo
- Solo "ingreso" o "gasto"
- Obligatorio

### Estado
- Solo "activo", "reemplazado", "anulado"
- Por defecto "activo"

## Casos de Uso

### 1. Subir una factura de ingreso

```bash
curl -X POST http://localhost:3000/api/conta/companies/1/archivo \
  -H "Authorization: Bearer TOKEN" \
  -F "archivo=@factura.pdf" \
  -F "tipo=ingreso" \
  -F "fecha=2026-07-17" \
  -F "numeroFactura=INV-2026-001" \
  -F "emisor=Mi Empresa" \
  -F "receptor=Cliente A" \
  -F "base=1000" \
  -F "iva=210" \
  -F "total=1210"
```

### 2. Listar facturas de julio 2026

```bash
curl http://localhost:3000/api/conta/companies/1/archivo?año=2026&mes=7 \
  -H "Authorization: Bearer TOKEN"
```

### 3. Filtrar por tipo y período

```bash
curl "http://localhost:3000/api/conta/companies/1/archivo?año=2026&trimestre=2&tipo=gasto" \
  -H "Authorization: Bearer TOKEN"
```

### 4. Buscar por número de factura

```bash
curl "http://localhost:3000/api/conta/companies/1/archivo/buscar?termino=INV-2026" \
  -H "Authorization: Bearer TOKEN"
```

### 5. Descargar un archivo

```bash
curl http://localhost:3000/api/conta/companies/1/archivo/documentid/descargar \
  -H "Authorization: Bearer TOKEN" \
  -o factura.pdf
```

### 6. Marcar un documento como reemplazado

```bash
curl -X PATCH http://localhost:3000/api/conta/companies/1/archivo/documentid/estado \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"estado":"reemplazado","observaciones":"Factura corregida"}'
```

## Integración con OCR

Cuando un documento se procesa con OCR (IncomeReaderDocument), el sistema:

1. Extrae datos usando el lector OCR
2. Calcula la confianza (0-1) basada en la precisión de extracción
3. Crea un registro de DocumentoArchivo con `origen="ocr_extractor"`
4. Guarda los metadatos de IVA, retención, etc.
5. Opcionalmente vincula con IncomeInvoice si se confirma

El campo `confianza` ayuda a identificar documentos que requieren revisión manual.

## Migración del Banco de Datos

La tabla `DocumentoArchivo` está definida en `prisma/schema.prisma`. Para aplicar los cambios:

```bash
npx prisma migrate dev --name "add-documento-archivo"
```

O si usa Vercel Postgres:

```bash
npx prisma migrate deploy
```

## Troubleshooting

### Error: "Archivo es obligatorio"
Asegúrese de enviar un archivo en el formulario multipart/form-data.

### Error: "Tipo debe ser 'ingreso' o 'gasto'"
Verifique que el campo `tipo` tiene uno de los dos valores válidos.

### Error: "Fecha inválida"
La fecha debe estar en formato YYYY-MM-DD y ser una fecha válida.

### Error 413: Payload Too Large
El archivo supera 50 MB. Comprima el PDF o divida el documento.

### Error 401: Unauthorized
Verifique que el token JWT es válido y no ha expirado.

### Los archivos no se descargan desde Vercel Blob
Asegúrese de que `BLOB_READ_WRITE_TOKEN` está configurado correctamente en las variables de entorno.

## Rendimiento

### Índices de BD

```sql
CREATE INDEX idx_documento_archivo_companyId_año_mes 
  ON documentoArchivo(companyId, año, mes);

CREATE INDEX idx_documento_archivo_companyId_año_trimestre 
  ON documentoArchivo(companyId, año, trimestre);

CREATE INDEX idx_documento_archivo_companyId_año 
  ON documentoArchivo(companyId, año);

CREATE INDEX idx_documento_archivo_companyId_tipo 
  ON documentoArchivo(companyId, tipo);

CREATE INDEX idx_documento_archivo_companyId_uploadedAt 
  ON documentoArchivo(companyId, uploadedAt);
```

Estos índices están automáticamente creados en Prisma según la definición del modelo.

### Paginación

Las listas usan paginación con límite por defecto de 50 registros. Para grandes períodos, ajuste el parámetro `limite`.

## Próximas Mejoras

- [ ] Exportar archivo completo como ZIP
- [ ] Generación automática de reportes por período
- [ ] Integración con flujo de aprobación de documentos
- [ ] Versionado automático de documentos reemplazados
- [ ] Análisis de duplicados por hash
- [ ] Sincronización con FacturaScripts
