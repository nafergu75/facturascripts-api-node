# Integración Frontend - OCR con iLovePDF

Guía para integrar el nuevo endpoint OCR en el frontend `conta-api-web` (React/Next.js).

## Resumen

El frontend puede ahora:
1. Subir un PDF de factura
2. Recibir el texto OCR extraído
3. Enviar el texto a Claude para extracción contable
4. Guardar la referencia al PDF OCR para auditoría

## Cambios Mínimos al Flow Existente

**Antes:**
```
PDF escaneado (imagen)
  ↓
Enviar directamente a Claude (OCR fallible)
  ↓
Extracción contable
```

**Ahora:**
```
PDF escaneado (imagen)
  ↓
Enviar a backend: POST /ocr/invoices  ← NUEVO
  ↓
Backend usa iLovePDF para OCR profesional
  ↓
Recibir ocrText + ocrPdfPath  ← NUEVO
  ↓
Enviar ocrText a Claude (OCR garantizado)
  ↓
Extracción contable
  ↓
Guardar con referencia a ocrPdfPath  ← NUEVO
```

---

## Implementación en React/Next.js

### Hook Custom: `useInvoiceOCR`

Crear `conta-api-web/app/hooks/useInvoiceOCR.ts`:

```typescript
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'react-hot-toast'; // o tu notificación preferida

export interface OCRResult {
  ocrText: string;
  ocrPdfPath: string;
  pages: number;
  originalFileName: string;
  processingTime: number;
  charCount: number;
}

export function useInvoiceOCR(companyId: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const processInvoice = async (
    file: File,
    options?: {
      invoiceType?: 'expense' | 'income';
      language?: string;
      source?: 'email' | 'manual' | 'api';
    }
  ): Promise<OCRResult | null> => {
    setLoading(true);
    setError(null);

    try {
      // Validar archivo
      if (!file.type.includes('pdf')) {
        throw new Error('Solo se aceptan archivos PDF');
      }

      if (file.size > 150 * 1024 * 1024) {
        throw new Error('PDF demasiado grande (máx 150MB)');
      }

      // Preparar FormData
      const formData = new FormData();
      formData.append('file', file);
      formData.append('invoiceType', options?.invoiceType || 'expense');
      formData.append('language', options?.language || 'es');
      formData.append('source', options?.source || 'manual');

      // Subir a backend
      const response = await fetch(
        `/api/companies/${companyId}/ocr/invoices`,
        {
          method: 'POST',
          body: formData,
          // NO incluir Content-Type: multipart/form-data
          // El navegador lo establece automáticamente
        }
      );

      // Manejar respuesta
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error al procesar OCR');
      }

      toast.success(
        `OCR completado: ${data.data.pages} página(s), ${data.data.processingTime}s`
      );

      setLoading(false);
      return data.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Error desconocido';
      setError(message);
      toast.error(message);
      setLoading(false);
      return null;
    }
  };

  return { processInvoice, loading, error };
}
```

### Componente: `InvoiceUploadWithOCR`

Crear `conta-api-web/components/InvoiceUploadWithOCR.tsx`:

```typescript
'use client';

import { useState, useRef } from 'react';
import { useInvoiceOCR } from '@/app/hooks/useInvoiceOCR';
import { FileUp, Loader } from '@phosphor-icons/react';

interface Props {
  companyId: string;
  onOCRComplete: (result: {
    ocrText: string;
    ocrPdfPath: string;
    fileName: string;
  }) => void;
}

export function InvoiceUploadWithOCR({ companyId, onOCRComplete }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { processInvoice, loading, error } = useInvoiceOCR(companyId);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Procesar con OCR
    const result = await processInvoice(file, {
      invoiceType: 'expense',
      language: 'es',
      source: 'manual',
    });

    if (result) {
      // Llamar callback con resultado
      onOCRComplete({
        ocrText: result.ocrText,
        ocrPdfPath: result.ocrPdfPath,
        fileName: result.originalFileName,
      });

      // Limpiar input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        onChange={handleFileSelect}
        disabled={loading}
        className="hidden"
        id="pdf-upload"
      />

      <label htmlFor="pdf-upload" className="cursor-pointer">
        <div className="flex flex-col items-center gap-3">
          {loading ? (
            <>
              <Loader size={32} className="animate-spin text-slate-400" />
              <p className="text-sm text-slate-600">
                Procesando OCR... (esto puede tardar hasta 10 segundos)
              </p>
            </>
          ) : (
            <>
              <FileUp size={32} className="text-slate-400" />
              <p className="text-sm font-medium text-slate-900">
                Clic para subir PDF o arrastra un archivo
              </p>
              <p className="text-xs text-slate-500">
                PDF de factura (máx 150MB)
              </p>
            </>
          )}
        </div>
      </label>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
```

### Página: Integración en Dashboard

Actualizar `conta-api-web/app/dashboard/compras/page.tsx` (o similar):

```typescript
'use client';

import { useState } from 'react';
import { InvoiceUploadWithOCR } from '@/components/InvoiceUploadWithOCR';
import { extractInvoiceData } from '@/app/actions/invoice-extractor';

interface UploadState {
  ocrText?: string;
  ocrPdfPath?: string;
  fileName?: string;
  extractedData?: any;
  loading?: boolean;
}

export default function ComprasPage() {
  const [uploadState, setUploadState] = useState<UploadState>({});

  const handleOCRComplete = async (result: {
    ocrText: string;
    ocrPdfPath: string;
    fileName: string;
  }) => {
    setUploadState({ ...result, loading: true });

    try {
      // PASO 1: OCR completado ✓
      console.log('✓ OCR completado:', result.fileName);
      console.log('  Texto extraído:', result.ocrText.substring(0, 100) + '...');

      // PASO 2: Enviar texto a Claude para extracción contable
      const extractedData = await extractInvoiceData({
        ocrText: result.ocrText,
        invoiceType: 'expense',
        language: 'es',
        // ... otros parámetros según tu prompt
      });

      console.log('✓ Datos contables extraídos:', extractedData);

      setUploadState((prev) => ({
        ...prev,
        extractedData,
        loading: false,
      }));

      // PASO 3: Guardar en BD (opcional)
      await saveInvoice({
        ...extractedData,
        ocrPdfPath: result.ocrPdfPath, // Referencia para auditoría
        originalFileName: result.fileName,
      });

      console.log('✓ Factura guardada');
    } catch (error) {
      console.error('Error:', error);
      setUploadState((prev) => ({ ...prev, loading: false }));
    }
  };

  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Procesar Factura con OCR</h1>

      {/* Paso 1: Upload PDF */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Paso 1: Subir PDF</h2>
        <InvoiceUploadWithOCR
          companyId="1"
          onOCRComplete={handleOCRComplete}
        />
      </div>

      {/* Paso 2: Resultado OCR */}
      {uploadState.ocrText && (
        <div className="border border-slate-200 rounded-lg p-6 bg-slate-50">
          <h2 className="text-lg font-semibold mb-2">Paso 2: Texto OCR</h2>
          <div className="max-h-64 overflow-y-auto p-4 bg-white border rounded">
            <pre className="text-sm whitespace-pre-wrap font-mono">
              {uploadState.ocrText}
            </pre>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            PDF: {uploadState.fileName}
          </p>
        </div>
      )}

      {/* Paso 3: Datos Contables Extraídos */}
      {uploadState.extractedData && (
        <div className="border border-green-200 rounded-lg p-6 bg-green-50">
          <h2 className="text-lg font-semibold mb-4 text-green-900">
            Paso 3: Datos Contables Extraídos
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-600 font-medium">Proveedor</p>
              <p className="text-lg font-semibold">
                {uploadState.extractedData.proveedor?.nombre}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">Nº Factura</p>
              <p className="text-lg font-semibold">
                {uploadState.extractedData.numeroFactura}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">Base</p>
              <p className="text-lg font-semibold">
                €{uploadState.extractedData.base?.toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-600 font-medium">IVA</p>
              <p className="text-lg font-semibold">
                €{uploadState.extractedData.iva?.toFixed(2)}
              </p>
            </div>
          </div>
        </div>
      )}

      {uploadState.loading && (
        <div className="flex items-center justify-center p-8">
          <div className="animate-spin">
            <p>Procesando...</p>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## API Integration en Frontend

### Fetch Helper

Crear `conta-api-web/lib/ocr-client.ts`:

```typescript
import { getToken } from '@/lib/auth';

export interface ProcessInvoiceParams {
  file: File;
  companyId: string;
  invoiceType?: 'expense' | 'income';
  language?: string;
  source?: 'email' | 'manual' | 'api';
}

export async function processInvoiceOCR(
  params: ProcessInvoiceParams
): Promise<{
  ocrText: string;
  ocrPdfPath: string;
  pages: number;
  originalFileName: string;
  processingTime: number;
  charCount: number;
}> {
  const token = getToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const formData = new FormData();
  formData.append('file', params.file);
  formData.append('invoiceType', params.invoiceType || 'expense');
  formData.append('language', params.language || 'es');
  formData.append('source', params.source || 'manual');

  const response = await fetch(
    `/api/companies/${params.companyId}/ocr/invoices`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'OCR processing failed');
  }

  const data = await response.json();
  return data.data;
}

export async function getOCRStatus(companyId: string) {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const response = await fetch(
    `/api/companies/${companyId}/ocr/status`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) throw new Error('Failed to get OCR status');
  const data = await response.json();
  return data.data;
}
```

---

## Flujo Completo en la App

### Caso de Uso: Procesar Factura de Gasto

```typescript
// 1. Usuario sube PDF escaneado
const file = new File([...], 'factura_gasolina.pdf', { type: 'application/pdf' });

// 2. Frontend sube a backend
const ocrResult = await processInvoiceOCR({
  file,
  companyId: '1',
  invoiceType: 'expense',
  language: 'es',
});

// ocrResult contiene:
// - ocrText: "FACTURA\nProveedor: Shell...\nTotal: 45,50€"
// - ocrPdfPath: "/tmp/ocr/processed/ocr_1721302345678_xyz.pdf"
// - pages: 1

// 3. Frontend envía ocrText a Claude (tu flujo actual)
const contableData = await extractInvoiceData({
  ocrText: ocrResult.ocrText,
  invoiceType: 'expense',
  // ... resto de parámetros
});

// contableData contiene:
// - proveedor: { nombre: "Shell Español", nif: "A12345678" }
// - numeroFactura: "2026-00145"
// - base: 45.50
// - iva: 9.56
// - cuentas: [{ codigo: "600000", nombre: "Compras...", debe: 45.50 }]

// 4. Frontend guarda factura con referencia al PDF OCR
await saveInvoice({
  ...contableData,
  ocrPdfPath: ocrResult.ocrPdfPath,  // ← Nuevo: referencia para auditoría
  originalFileName: 'factura_gasolina.pdf',
  processingDate: new Date(),
});
```

---

## Manejo de Errores en Frontend

```typescript
async function handleInvoiceUpload(file: File) {
  try {
    const result = await processInvoiceOCR({
      file,
      companyId: '1',
      invoiceType: 'expense',
    });
    
    console.log('OCR exitoso:', result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Error desconocido';
    
    if (msg.includes('PDF')) {
      toast.error('Archivo inválido. Sube un PDF.');
    } else if (msg.includes('too large')) {
      toast.error('PDF demasiado grande (máx 150MB).');
    } else if (msg.includes('authentication')) {
      toast.error('Servidor OCR no disponible. Contacta a soporte.');
    } else if (msg.includes('credits')) {
      toast.error('Cuota OCR agotada. Intenta mañana.');
    } else {
      toast.error(`Error: ${msg}`);
    }
  }
}
```

---

## Componente de Status

Crear `conta-api-web/components/OCRStatus.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';
import { getOCRStatus } from '@/lib/ocr-client';

export function OCRStatus({ companyId }: { companyId: string }) {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const data = await getOCRStatus(companyId);
        setStatus(data);
      } catch (error) {
        console.error('Failed to get OCR status:', error);
      } finally {
        setLoading(false);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 30000); // Check every 30s

    return () => clearInterval(interval);
  }, [companyId]);

  if (loading) return <p>Cargando estado...</p>;
  if (!status) return <p>No disponible</p>;

  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
      <h3 className="font-semibold mb-3">Estado del Servicio OCR</h3>
      <div className="space-y-2 text-sm">
        <p>
          <span className="text-slate-600">Estado:</span>
          <span className="font-medium ml-2 text-green-600">
            {status.status}
          </span>
        </p>
        <p>
          <span className="text-slate-600">Tamaño máximo:</span>
          <span className="font-medium ml-2">{status.limits.maxFileSize}</span>
        </p>
        <p>
          <span className="text-slate-600">Uso disco OCR:</span>
          <span className="font-medium ml-2">{status.diskUsage.ocr}</span>
        </p>
      </div>
    </div>
  );
}
```

---

## Cambios Necesarios en Base de Datos

Si quieres guardar referencia al PDF OCR, agregar columna a tabla de facturas:

```sql
-- En Prisma schema
model Invoice {
  id            String   @id @default(cuid())
  numeroFactura String
  proveedor     String
  base          Decimal
  iva           Decimal
  
  // Nuevo: referencia al PDF OCR para auditoría
  ocrPdfPath    String?  // Path interno del PDF OCR
  ocrProcessedAt DateTime? // Cuándo se procesó el OCR
  
  // ... resto de campos
}
```

---

## Resumen de Cambios

| Área | Cambio | Impacto |
|------|--------|--------|
| **Backend** | + 3 archivos (config, service, controller) + rutas | ✅ Cero impacto en flujo existente |
| **Frontend** | + 1 hook, + 1 componente, actualizar página | ✅ Optional, puede agregarse gradualmente |
| **BD** | + 1 columna (ocrPdfPath) | ✅ Migration reversible |
| **Claude prompt** | Ninguno | ✅ Sigue siendo igual |
| **Flujo contable** | Mismo flujo, mejor precisión | ✅ Mejora directa |

---

## Testing Frontend

```bash
# 1. Asegurar que backend está corriendo
npm run dev  # en facturascripts-api-node/

# 2. En otra terminal, frontend
cd conta-api-web
npm run dev

# 3. Navegar a página de compras
# http://localhost:3000/dashboard/compras

# 4. Seleccionar PDF y ver flujo completo
```

---

## Gradual Rollout

### Fase 1: Opcional (hoy)
- Agregar componente de upload OCR como opción alternativa
- Usuarios pueden elegir: "Upload PDF" vs "Upload text"

### Fase 2: Preferido (próxima)
- OCR es el flujo por defecto
- Fallback a text input si es necesario

### Fase 3: Solo OCR
- Eliminar input de texto directo
- Todos usan OCR para garantizar precisión

---

## Referencias

- Hook Pattern: `conta-api-web/app/hooks/useInvoiceOCR.ts`
- Componente: `conta-api-web/components/InvoiceUploadWithOCR.tsx`
- API Client: `conta-api-web/lib/ocr-client.ts`
- Docs backend: `facturascripts-api-node/docs/ILOVEPDF_INTEGRATION.md`

---

**Versión:** 1.0  
**Status:** ✅ Listo para implementación
