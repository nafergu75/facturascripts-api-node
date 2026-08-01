# Ejemplos de cURL - Testing de API

Copiar y pegar estos comandos directamente en terminal para testear.

**Nota:** Reemplazar:
- `{TOKEN}` con tu JWT
- `{COMPANY_ID}` con el UUID de tu empresa
- `{CUSTOMER_ID}` con el UUID de un cliente existente

---

## Variables de ambiente (primero)

```bash
# Guardar en variables
API="http://localhost:3000/api"
TOKEN="tu-jwt-token-aqui"
COMPANY_ID="comp-uuid-aqui"
CUSTOMER_ID="cust-uuid-aqui"
```

---

## 1. Crear cliente nuevo

```bash
curl -X POST "$API/customers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nombreFiscal": "Acme Inc.",
    "nifCif": "B12345678",
    "direccion": "C/ Ejemplo 1",
    "pais": "ES",
    "provincia": "Barcelona",
    "municipio": "Barcelona",
    "cp": "08001",
    "email": "acme@example.com"
  }' | jq .
```

---

## 2. Crear factura de ingreso (cliente existente)

```bash
curl -X POST "$API/invoices/income" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "'$CUSTOMER_ID'"},
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
  }' | jq .
```

---

## 3. Crear factura de ingreso (cliente nuevo)

```bash
curl -X POST "$API/invoices/income" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {
      "nuevo": {
        "nombreFiscal": "Nueva Empresa S.L.",
        "nifCif": "B87654321",
        "direccion": "Av. Principal 10",
        "pais": "ES",
        "provincia": "Madrid",
        "municipio": "Madrid",
        "cp": "28001",
        "email": "empresa@example.com"
      }
    },
    "serie": "2024",
    "lineas": [
      {
        "descripcion": "Consultoría empresarial",
        "cantidad": 1,
        "precioUnitario": 5000,
        "tipoIva": 21
      }
    ]
  }' | jq .
```

---

## 4. Listar facturas de ingreso

```bash
# Todas
curl "$API/invoices/income" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Por estado
curl "$API/invoices/income?estado=PENDING" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Por período
curl "$API/invoices/income?desde=2024-01-01&hasta=2024-12-31" \
  -H "Authorization: Bearer $TOKEN" | jq .

# Con paginación
curl "$API/invoices/income?skip=0&take=20" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 5. Obtener factura por ID

```bash
# Guardar ID de la factura anterior
INVOICE_ID="inv-uuid-de-la-factura"

curl "$API/invoices/income/$INVOICE_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 6. Cambiar estado de factura (marcar como cobrada)

```bash
curl -X PATCH "$API/invoices/income/$INVOICE_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "estado": "PAID"
  }' | jq .
```

---

## 7. Crear factura rectificativa (abono automático)

```bash
# Sin líneas (automáticamente niega las de la original)
curl -X POST "$API/invoices/income/$INVOICE_ID/credit-note" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .
```

---

## 8. Crear factura rectificativa (líneas personalizadas)

```bash
curl -X POST "$API/invoices/income/$INVOICE_ID/credit-note" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "lineas": [
      {
        "descripcion": "Devolución parcial - Consultoría",
        "cantidad": -1,
        "precioUnitario": 1000,
        "tipoIva": 21,
        "tipoRetencion": 15
      }
    ]
  }' | jq .
```

---

## 9. Resumen de ingresos por período (Dashboard)

```bash
curl "$API/invoices/income/resumen/periodo?desde=2024-01-01&hasta=2024-12-31" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 10. Subir documento desde móvil (foto)

```bash
# Con imagen local
curl -X POST "$API/income-reader/mobile-upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @/ruta/a/factura.jpg | jq .

# O especificar nombre
curl -X POST "$API/income-reader/mobile-upload?nombre=factura.jpg" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @/ruta/a/factura.jpg | jq .
```

---

## 11. Subir documento desde web (JSON base64)

```bash
# Convertir archivo a base64
BASE64=$(cat /ruta/a/factura.pdf | base64 -w 0)

curl -X POST "$API/income-reader/web-upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nombreArchivo": "factura.pdf",
    "mimeType": "application/pdf",
    "contenidoBase64": "'$BASE64'"
  }' | jq .
```

---

## 12. Webhook de email (mock)

```bash
curl -X POST "$API/income-reader/email-hook" \
  -H "Content-Type: application/json" \
  -d '{
    "readerEmail": "empresa+lector@platform.com",
    "remitente": "proveedor@example.com",
    "adjuntos": [
      {
        "nombre": "factura.pdf",
        "mimetype": "application/pdf",
        "buffer": "JVBERi0xLjQKJeLj..."
      }
    ]
  }' | jq .
```

---

## 13. Listar documentos pendientes de verificar

```bash
curl "$API/income-reader/pending" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 14. Obtener detalle de un documento

```bash
# Guardar ID del documento
DOC_ID="doc-uuid-del-documento"

curl "$API/income-reader/$DOC_ID" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 15. Actualizar datos extraídos (corregir OCR)

```bash
curl -X PUT "$API/income-reader/$DOC_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nifEmisor": "B12345678",
    "nombreEmisor": "Proveedor Correcto",
    "numero": "2024-001",
    "fecha": "2024-06-10",
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
  }' | jq .
```

---

## 16. Verificar documento y crear factura

```bash
curl -X POST "$API/income-reader/$DOC_ID/verify" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq .

# Respuesta incluirá linkedInvoiceId (la factura creada)
```

---

## 17. Rechazar documento

```bash
curl -X POST "$API/income-reader/$DOC_ID/reject" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "motivo": "Documento ilegible o duplicado"
  }' | jq .
```

---

## 18. Obtener configuración de email del lector

```bash
curl "$API/income-reader/config" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

---

## 19. Crear/actualizar configuración de email del lector

```bash
curl -X POST "$API/income-reader/config" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "readerEmail": "empresa+lector@platform.com",
    "isActive": true
  }' | jq .
```

---

## Flujo completo en un script

```bash
#!/bin/bash

API="http://localhost:3000/api"
TOKEN="tu-token-aqui"

echo "=== 1. Crear cliente nuevo ==="
CUSTOMER=$(curl -s -X POST "$API/customers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "nombreFiscal": "Test Client S.L.",
    "nifCif": "B99999999",
    "email": "test@example.com"
  }')
CUSTOMER_ID=$(echo $CUSTOMER | jq -r '.customer.id')
echo "Cliente creado: $CUSTOMER_ID"

echo ""
echo "=== 2. Crear factura de ingreso ==="
INVOICE=$(curl -s -X POST "$API/invoices/income" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "customer": {"id": "'$CUSTOMER_ID'"},
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
  }')
INVOICE_ID=$(echo $INVOICE | jq -r '.invoice.id')
echo "Factura creada: $INVOICE_ID"
echo $INVOICE | jq '.invoice | {numeroCompleto, estado, totalFactura}'

echo ""
echo "=== 3. Listar facturas ==="
curl -s "$API/invoices/income" \
  -H "Authorization: Bearer $TOKEN" | jq '.items | length' | sed 's/^/Total: /'

echo ""
echo "=== 4. Cambiar estado a PAID ==="
curl -s -X PATCH "$API/invoices/income/$INVOICE_ID/status" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"estado": "PAID"}' | jq '.invoice | {numeroCompleto, estado}'

echo ""
echo "=== 5. Resumen ==="
curl -s "$API/invoices/income/resumen/periodo" \
  -H "Authorization: Bearer $TOKEN" | jq '.resumen'
```

---

## Consejos de testing

### Instalación de dependencias (si falta `jq`):

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# Windows (con WSL)
sudo apt-get install jq
```

### Pretty-print respuestas:

```bash
# Con jq (recomendado)
curl ... | jq .

# Sin jq (solo cat)
curl ... 
```

### Guardar respuesta en archivo:

```bash
curl ... -o response.json
cat response.json | jq .
```

### Testear con Postman:

1. Copiar la URL: `http://localhost:3000/api/invoices/income`
2. Seleccionar método (GET, POST, PATCH)
3. Headers → Authorization → Bearer {TOKEN}
4. Body → raw → JSON
5. Pegar JSON de los ejemplos
6. Send

---

## Troubleshooting

### "401 Unauthorized"
```
❌ TOKEN invalido o expirado
✅ Generar nuevo token
```

### "403 Forbidden"
```
❌ Usuario sin permiso 'ventas:write'
✅ Verificar rol en BD o JWT claims
```

### "404 Not Found"
```
❌ Recurso no existe
✅ Verificar ID del cliente/factura/documento
```

### "400 Bad Request"
```
❌ Validación fallida (campos requeridos, etc.)
✅ Ver mensaje de error y revisar payload
```

---

## Automatización con shell script

Guardar como `test_api.sh` y ejecutar:

```bash
chmod +x test_api.sh
./test_api.sh
```

Esto crea cliente → factura → lista → cambia estado en uno.

---

**Nota:** Para testing en localhost, asegurar que `npm run dev` está en ejecución.
