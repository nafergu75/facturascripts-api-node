# Frontend Fase 2 - Quick Reference

**Estado:** ✅ Completada  
**Nuevos componentes:** 3  
**Líneas de código:** ~910 LOC  
**Tiempo para integrar:** 10 minutos

---

## 📦 Qué se agregó

### 1. LineAdjustmentModal (Modal para editar líneas)
**Archivo:** `src/components/accounting/LineAdjustmentModal.tsx`

```typescript
<LineAdjustmentModal
  isOpen={isLineAdjustOpen}
  onClose={onLineAdjustClose}
  companyId={companyId}
  journalEntryId={journalEntryId}
  line={selectedLine}
  onSuccess={handleLineAdjustSuccess}
/>
```

**Integrado en:** JournalEntryDetail.tsx (cambios mínimos)

---

### 2. VATBooks (Libros de IVA)
**Archivo:** `src/pages/tax/VATBooks.tsx`

**Ruta:** `/companies/:companyId/tax/vat-books`

**Tabs:** 
- Facturas Emitidas (IVA Repercutido)
- Facturas Recibidas (IVA Soportado)

**Filtros:** Período (desde/hasta)

---

### 3. TaxSummary (Resumen Modelo 303)
**Archivo:** `src/pages/tax/TaxSummary.tsx`

**Ruta:** `/companies/:companyId/tax/summary`

**Filtros:** Año + Trimestre (Q1-Q4)

**Mostrado:**
- Cuotas IVA emitidas vs recibidas
- Resultado a ingresar/devolver
- Retenciones por tipo (Modelo 190)

---

## 🔌 Servicios nuevos (taxApi.ts)

```typescript
getVatBooksIssued(companyId, from, to)
getVatBooksReceived(companyId, from, to)
getVatSummary(companyId, period)          // period = "Q1-2026"
getRetentionSummary(companyId, year)
exportModelo303(companyId, period, format)
```

---

## 📍 Nuevas rutas

Agregar a App.tsx o router principal:

```tsx
<Route path="/companies/:companyId/tax/*" element={<TaxRoutes />} />
```

Rutas disponibles:
- `/companies/:companyId/tax/vat-books`
- `/companies/:companyId/tax/summary`

---

## 🎯 Cambios Mínimos en Código Existente

### JournalEntryDetail.tsx
```typescript
// ANTES:
onEditLine?: (lineId: string) => void;

// AHORA:
onEditLine?: (line: JournalEntryLine) => void;
```

**También agregar:**
```typescript
import { LineAdjustmentModal } from '../../components/accounting/LineAdjustmentModal';

// En state:
const [selectedLine, setSelectedLine] = useState<JournalEntryLine | null>(null);
const { isOpen: isLineAdjustOpen, onOpen: onLineAdjustOpen, onClose: onLineAdjustClose } = useDisclosure();

// Handlers:
function handleEditLine(line: JournalEntryLine) {
  setSelectedLine(line);
  onLineAdjustOpen();
}

async function handleLineAdjustSuccess() {
  await loadDetail();
}

// En JSX (antes del Modal de aprobación):
{selectedLine && (
  <LineAdjustmentModal
    isOpen={isLineAdjustOpen}
    onClose={onLineAdjustClose}
    companyId={companyId}
    journalEntryId={journalEntryId}
    line={selectedLine}
    onSuccess={handleLineAdjustSuccess}
  />
)}
```

---

## ✅ Validación Post-Implementación

Probar que funciona:

```bash
# 1. LineAdjustmentModal
- Abrir asiento en PENDING_REVIEW
- Click botón "Editar" en una línea
- Cambiar valores → Guardar
- Asiento se recarga ✅

# 2. VATBooks
http://localhost:5173/companies/tu-id/tax/vat-books
- Ver tabs ✅
- Cambiar fechas → Actualizar ✅
- Ver totales ✅

# 3. TaxSummary
http://localhost:5173/companies/tu-id/tax/summary
- Cambiar trimestre/año ✅
- Ver resumen IVA ✅
- Ver retenciones ✅
```

---

## 📊 Resumen de Cambios

| Archivo | Tipo | Cambio |
|---------|------|--------|
| `src/api/types.ts` | Mod | +5 interfaces |
| `src/api/taxApi.ts` | Nuevo | 80 LOC |
| `src/components/accounting/LineAdjustmentModal.tsx` | Nuevo | 200 LOC |
| `src/pages/tax/VATBooks.tsx` | Nuevo | 280 LOC |
| `src/pages/tax/TaxSummary.tsx` | Nuevo | 350 LOC |
| `src/routes/tax.routes.tsx` | Nuevo | 20 LOC |
| `src/components/accounting/JournalEntryLinesTable.tsx` | Mod | 1 línea |
| `src/pages/accounting/JournalEntryDetail.tsx` | Mod | ~30 líneas |

**Total:** 7 nuevos + 2 modificados = **~910 LOC nuevas**

---

## 🚀 Integración (5 min)

1. Copiar archivos nuevos a carpeta `src/`
2. Actualizar imports en `JournalEntryDetail.tsx`
3. Agregar `<TaxRoutes />` en router principal
4. Verificar tipos en `types.ts` están presentes
5. ¡Listo! ✅

---

## 🎨 Componentes Visuales

### LineAdjustmentModal
- Modal con formulario
- Validación en-vivo
- Botones: Guardar, Cancelar
- Mensaje de error si falla

### VATBooks
- Tabs elegantes
- Tablas con datos
- Filtros de período
- Resumen de totales

### TaxSummary
- Selectores año/trimestre
- Grid de 2 columnas (Emitidas/Recibidas)
- Box destacado para resultado
- Tabla de retenciones

---

## 📝 Tipos Nuevos

```typescript
interface VatBookEntry {
  id: string;
  fechaFactura: string;
  numeroFactura: string;
  nif?: string;
  nombre?: string;
  baseImponible: number;
  tipoIva: number;
  cuotaIva: number;
  retencion?: number;
  estado?: string;
}

interface VatSummaryResponse {
  periodo: string;
  empresa: { nif: string; nombre: string };
  emitidas: { bases: number; cuotas: number };
  recibidas: { bases: number; cuotas: number };
  cuotaAIngresar: number;
  retencionesRecibidas?: number;
  deuda?: number;
}

interface RetentionEntry {
  id: string;
  tipoRetencion: string;
  nifTercero: string;
  nombreTercero: string;
  baseRetencion: number;
  porcentajeRetencion: number;
  cuotaRetencion: number;
}

interface RetentionSummaryResponse {
  periodo: string;
  retenciones: RetentionEntry[];
  totalBase: number;
  totalCuota: number;
}
```

---

## 🔐 Permisos

Todos los componentes usan:
- `useCompanyId()` - Obtiene companyId de ruta
- Headers con JWT token (automático en httpGet)
- Error handling para 401/403/404

---

## 📚 Documentación Completa

Ver: `FASE2_IMPLEMENTATION_SUMMARY.md`

---

**Fase 2 lista para usar. ¡Cópia los archivos y disfruta! 🚀**
