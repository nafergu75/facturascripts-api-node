# API de Importación de Datos Contables Históricos

Endpoints para importar balances, mayores y estados de resultados de años anteriores.

**Base URL:** `http://localhost:3000`

## Autenticación

Todos los endpoints requieren JWT válido en el header:
```
Authorization: Bearer <token>
```

## Endpoints

### 1. Upload de Archivo

**Endpoint:** `POST /companies/:companyId/import/upload`

Sube un archivo Excel o CSV y obtiene preview + mapeos sugeridos.

**Headers:**
```
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

**Body:**
```
file: <archivo .xlsx, .xls o .csv>
importType: BALANCE | MAYOR | PYG
ejercicio: 2025
sheetName?: "Balance" (opcional, solo para Excel)
```

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "uploadedFile": "balance_2025.xlsx",
    "fileSize": 52384,
    "preview": {
      "totalRows": 150,
      "totalColumns": 5,
      "headers": ["Código", "Nombre", "Debe", "Haber", "Categoría"],
      "sampleRows": [
        {"Código": "1000", "Nombre": "Caja", "Debe": "50000.00", "Haber": "0.00"}
      ],
      "sheetName": "Balance"
    },
    "suggestedMappings": {
      "Código": "cuentaCodigo",
      "Nombre": "cuentaNombre",
      "Debe": "debe",
      "Haber": "haber"
    },
    "importType": "BALANCE",
    "ejercicio": 2025
  }
}
```

**Ejemplo cURL:**
```bash
curl -X POST http://localhost:3000/companies/1/import/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@balance_2025.xlsx" \
  -F "importType=BALANCE" \
  -F "ejercicio=2025"
```

---

### 2. Sugerir Mapeos de Columnas

**Endpoint:** `POST /companies/:companyId/import/:sessionId/suggest-mapping`

Obtiene nuevos mapeos sugeridos (útil si el usuario modifica los mapeos manuales).

**Body:**
```json
{
  "columnMappings": {
    "Código": null,
    "Nombre": "cuentaNombre",
    "Debe": "debe",
    "Haber": "haber"
  }
}
```

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "suggestedMappings": {
      "Código": "cuentaCodigo",
      "Nombre": "cuentaNombre",
      "Debe": "debe",
      "Haber": "haber"
    },
    "originalHeaders": ["Código", "Nombre", "Debe", "Haber", "Categoría"]
  }
}
```

---

### 3. Validar Datos

**Endpoint:** `POST /companies/:companyId/import/:sessionId/validate`

Valida los datos sin importar. Ejecuta todas las validaciones contables.

**Body:**
```json
{
  "companyId": "1",
  "importType": "BALANCE",
  "ejercicio": 2025,
  "columnMappings": {
    "Código": "cuentaCodigo",
    "Nombre": "cuentaNombre",
    "Debe": "debe",
    "Haber": "haber"
  },
  "manualAccountMappings": {
    "1000": "100000",
    "5000": "500000"
  },
  "sheetName": "Balance"
}
```

**Response (200 - Válido):**
```json
{
  "ok": true,
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "success": true,
    "ejercicio": 2025,
    "importType": "BALANCE",
    "totalRows": 150,
    "processedRows": 150,
    "errorRows": 0,
    "errors": [],
    "warnings": [
      "Cuenta 572000 tiene saldo negativo (naturaleza mixta)"
    ],
    "validationResult": {
      "isBalanced": true,
      "activo": "1200000.00",
      "pasivo": "500000.00",
      "patrimonio": "700000.00",
      "difference": "0.00",
      "errors": [],
      "warnings": []
    },
    "openingEntry": {
      "numero": "2026/00001",
      "fecha": "2026-01-01T00:00:00Z",
      "ejercicio": 2026,
      "descripcion": "Asiento de apertura del ejercicio 2026",
      "totalDebe": "1200000.00",
      "totalHaber": "1200000.00",
      "isBalanced": true,
      "lineas": 150
    }
  }
}
```

**Response (400 - Inválido):**
```json
{
  "ok": false,
  "error": "Importación fallida",
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "errors": [
      "Balance no cuadra. Activo (1200000) ≠ Pasivo + PN (800000). Diferencia: 400000"
    ],
    "warnings": []
  }
}
```

---

### 4. Confirmar e Importar

**Endpoint:** `POST /companies/:companyId/import/:sessionId/confirm`

Confirma la importación y guarda los datos en la base de datos.

**Body:** (idéntico al validate)
```json
{
  "companyId": "1",
  "importType": "BALANCE",
  "ejercicio": 2025,
  "columnMappings": {
    "Código": "cuentaCodigo",
    "Nombre": "cuentaNombre",
    "Debe": "debe",
    "Haber": "haber"
  },
  "manualAccountMappings": {
    "1000": "100000",
    "5000": "500000"
  }
}
```

**Response (201 - Éxito):**
```json
{
  "ok": true,
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "ejercicio": 2025,
    "importType": "BALANCE",
    "totalRows": 150,
    "processedRows": 150,
    "errorRows": 0,
    "duration": "2.5s",
    "openingEntry": {
      "numero": "2026/00001",
      "fecha": "2026-01-01T00:00:00Z",
      "ejercicio": 2026,
      "descripcion": "Asiento de apertura del ejercicio 2026",
      "totalDebe": "1200000.00",
      "totalHaber": "1200000.00",
      "isBalanced": true,
      "lineas": [
        {
          "accountCode": "100000",
          "accountName": "Caja y Bancos",
          "description": "Apertura de Caja y Bancos",
          "debit": "50000.00",
          "credit": "0.00",
          "lineNumber": 1
        }
      ]
    },
    "message": "Importación completada exitosamente"
  }
}
```

---

### 5. Obtener Estado

**Endpoint:** `GET /companies/:companyId/import/:sessionId/status`

Obtiene el estado actual de una importación.

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "state": "IMPORTADO",
    "importType": "BALANCE",
    "ejercicio": 2025,
    "totalRows": 150,
    "processedRows": 150,
    "errorRows": 0,
    "validationErrors": [],
    "validationWarnings": [
      "Cuenta 572000 tiene saldo negativo"
    ],
    "startedAt": "2026-07-18T10:30:45.123Z",
    "completedAt": "2026-07-18T10:30:48.456Z"
  }
}
```

---

### 6. Obtener Progreso

**Endpoint:** `GET /companies/:companyId/import/:sessionId/progress`

Obtiene el porcentaje de progreso en tiempo real.

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "percentage": 75,
    "processedRows": 113,
    "totalRows": 150,
    "status": "MAPEADO"
  }
}
```

---

### 7. Obtener Asiento de Apertura

**Endpoint:** `GET /companies/:companyId/import/:sessionId/opening-entry`

Obtiene el asiento de apertura generado.

**Query Parameters:**
- `format`: `json` (default) o `csv`

**Response (200):**
```json
{
  "ok": true,
  "data": {
    "message": "Asiento de apertura disponible",
    "sessionId": "upload_1721302345678_a1b2c3d4e",
    "format": "json"
  }
}
```

**Example con formato CSV:**
```
GET /companies/1/import/upload_1721302345678_a1b2c3d4e/opening-entry?format=csv
```

---

### 8. Cancelar Importación

**Endpoint:** `DELETE /companies/:companyId/import/:sessionId/cancel`

Cancela una importación en curso (solo si no está IMPORTADO o FALLIDO).

**Response (200):**
```json
{
  "ok": true,
  "message": "Importación cancelada",
  "data": {
    "sessionId": "upload_1721302345678_a1b2c3d4e"
  }
}
```

**Response (400 - No se puede cancelar):**
```json
{
  "ok": false,
  "error": "No se puede cancelar: sesión no encontrada o ya terminada"
}
```

---

## Flujo Típico

### 1. User sube archivo
```
POST /companies/1/import/upload
→ Recibe: sessionId, suggestedMappings, preview
```

### 2. (Opcional) Ajusta mapeos
```
POST /companies/1/import/:sessionId/suggest-mapping
→ Recibe: nuevos mapeos sugeridos
```

### 3. Valida antes de importar
```
POST /companies/1/import/:sessionId/validate
→ Recibe: errores/warnings de validación
→ Si hay errores: mostrar al user, vuelve a step 2
→ Si todo OK: procede a step 4
```

### 4. Confirma la importación
```
POST /companies/1/import/:sessionId/confirm
→ Guarda en BD
→ Recibe: openingEntry generado
```

### 5. (Opcional) Monitorea progreso
```
GET /companies/1/import/:sessionId/progress
GET /companies/1/import/:sessionId/status
```

---

## Errores Comunes

| Código | Error | Solución |
|--------|-------|----------|
| 400 | `Formato no soportado` | Asegurar que el archivo es .xlsx, .xls o .csv |
| 400 | `Archivo demasiado grande` | El archivo excede 50MB. Dividir en múltiples archivos. |
| 400 | `Balance no cuadra` | Activo ≠ Pasivo + PN. Revisar datos de entrada. |
| 400 | `Mayor no cuadra` | Debe ≠ Haber. Datos inconsistentes. |
| 404 | `Sesión no encontrada o expirada` | La sesión tiene más de 24 horas. Subir archivo nuevamente. |
| 401 | `No autorizado` | Token JWT inválido o expirado. |
| 422 | `Mapeos de columnas inválidos` | Verificar que los nombres de columnas coincidan. |

---

## Mapeos de Columnas Sugeridos Automáticamente

El sistema sugiere mapeos basándose en similitud de nombres (Levenshtein):

**Para BALANCE:**
- Detecta: "Código", "Cuenta", "Code", "Account" → `cuentaCodigo`
- Detecta: "Nombre", "Description", "Desc" → `cuentaNombre`
- Detecta: "Debe", "Debit", "Debe €" → `debe`
- Detecta: "Haber", "Credit", "Haber €" → `haber`

**Para MAYOR:**
- Detecta: "Fecha", "Date", "Fecha Mov" → `fecha`
- Detecta: "Cuenta", "Code", "Account" → `cuentaCodigo`
- Detecta: "Descripción", "Description", "Concepto" → `descripcion`
- Detecta: "Debe", "Debit" → `debe`
- Detecta: "Haber", "Credit" → `haber`

**Confianza:**
- 100%: Mapeo manual explícito
- 85-100%: Coincidencia automática muy probable
- 70-85%: Coincidencia automática probable
- < 70%: No se sugiere, requiere mapeo manual

---

## Ejemplos cURL Completos

### Ejemplo 1: Importar Balance completo

```bash
# 1. Upload
RESPONSE=$(curl -s -X POST http://localhost:3000/companies/1/import/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@balance_2025.xlsx" \
  -F "importType=BALANCE" \
  -F "ejercicio=2025")

SESSION_ID=$(echo $RESPONSE | jq -r '.data.sessionId')
echo "Session: $SESSION_ID"

# 2. Validate
curl -s -X POST http://localhost:3000/companies/1/import/$SESSION_ID/validate \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "1",
    "importType": "BALANCE",
    "ejercicio": 2025,
    "columnMappings": {
      "Código": "cuentaCodigo",
      "Nombre": "cuentaNombre",
      "Debe": "debe",
      "Haber": "haber"
    }
  }' | jq '.'

# 3. Confirm
curl -s -X POST http://localhost:3000/companies/1/import/$SESSION_ID/confirm \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "1",
    "importType": "BALANCE",
    "ejercicio": 2025,
    "columnMappings": {
      "Código": "cuentaCodigo",
      "Nombre": "cuentaNombre",
      "Debe": "debe",
      "Haber": "haber"
    }
  }' | jq '.'
```

---

## Formatos de Entrada Aceptados

### Balance (BALANCE)
```
Código | Nombre Cuenta        | Debe      | Haber
1000   | Caja y Bancos       | 50000.00  | 0.00
4100   | Clientes            | 30000.00  | 0.00
2100   | Proveedores         | 0.00      | 20000.00
```

### Mayor (MAYOR)
```
Fecha      | Cuenta | Descripción           | Debe     | Haber
01/01/2025 | 1000   | Saldo apertura caja  | 50000.00 | 0.00
05/01/2025 | 4100   | Factura cliente ABC  | 30000.00 | 0.00
```

---

## Estado del Asiento de Apertura

El asiento de apertura se genera automáticamente si:
1. ✅ Balance es válido (Activo = Pasivo + PN)
2. ✅ Todos los códigos de cuenta son válidos (6 dígitos)
3. ✅ No hay cuentas de resultado (Ingresos/Gastos se excluyen)

El asiento:
- Número: `{año}/00001` (ej: 2026/00001)
- Fecha: 1 de enero del año destino
- Líneas: Una por cada cuenta con saldo
- Cuadratura garantizada: Debe = Haber siempre
