# Frontend Integration Spec - Motor Contable Automático

**Objetivo:** Especificar cómo el frontend React debe consumir el motor contable para usuarios no-contables y advisors.

**Fecha:** 13 de junio de 2026  
**Estado:** Especificación v1.0

---

## 📋 Tabla de Contenidos

1. [Arquitectura Frontend](#arquitectura-frontend)
2. [Componentes Principales](#componentes-principales)
3. [Flujos de Usuario](#flujos-de-usuario)
4. [Patrones de Consumo de API](#patrones-de-consumo-de-api)
5. [Estados y Validaciones](#estados-y-validaciones)
6. [Reportes y Vistas](#reportes-y-vistas)
7. [Manejo de Errores](#manejo-de-errores)

---

## 🏗️ Arquitectura Frontend

### Niveles

```
┌─────────────────────────────────────────────────────┐
│ Views (Páginas)                                      │
│ - DashboardView, InvoiceDetailView, ReportsView    │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ Containers (Lógica + Estado)                        │
│ - InvoiceContainer, AccountingContainer, ReportsCtx │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ Components (UI reutilizable)                        │
│ - JournalEntryCard, ApprovalModal, BalanceTable    │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ Services (Consumo de API)                           │
│ - accountingService.ts, reportsService.ts           │
└─────────────────────────────────────────────────────┘
```

### State Management

Usar **React Context + Hooks** (sin Redux, para mantener simpleza):

- `AccountingContext`: Global state de asientos y facturas
- `AuthContext`: Usuario actual y permisos
- Local state en componentes para UI temporal

---

## 🎨 Componentes Principales

### 1. JournalEntryList

**Responsabilidad:** Mostrar lista de asientos filtrados

**Props:**
```typescript
interface JournalEntryListProps {
  companyId: string;
  filtros?: {
    estado?: 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';
    desde?: string; // ISO date
    hasta?: string;
  };
  onSelectAsiento?: (asientoId: string) => void;
}
```

**Endpoint consumido:**
```
GET /api/companies/{companyId}/accounting/journal-entries
  ?estado=PENDING_REVIEW
  &from=2026-01-01&to=2026-12-31
```

**Respuesta esperada:**
```json
{
  "asientos": [
    {
      "id": "asiento-123",
      "numeroAsiento": "FAC-ING-FAC-001",
      "estado": "PENDING_REVIEW",
      "fechaAsiento": "2026-06-13",
      "origen": "INCOME_INVOICE",
      "facturaId": "inv-456",
      "totalDebe": 1210,
      "validaciones": {
        "cuadrado": true,
        "errores": []
      }
    }
  ],
  "total": 15,
  "paginacion": { "skip": 0, "take": 20 }
}
```

**Comportamiento:**
- ✅ Tabla con columnas: N°Asiento, Fecha, Estado, Total, Acciones
- ✅ Filtros por estado y rango de fechas
- ✅ Badge visual para estado (verde POSTED, amarillo PENDING, rojo ERROR)
- ✅ Click en fila abre detail view

---

### 2. JournalEntryDetail

**Responsabilidad:** Mostrar detalles completos del asiento + acciones

**Props:**
```typescript
interface JournalEntryDetailProps {
  journalEntryId: string;
  companyId: string;
  onApproveSuccess?: () => void;
}
```

**Endpoints consumidos:**
```
GET /api/companies/{companyId}/accounting/journal-entries/{journalEntryId}
POST /api/companies/{companyId}/accounting/journal-entries/{journalEntryId}/approve
PATCH /api/companies/{companyId}/accounting/journal-entries/{journalEntryId}/lines/{lineId}
```

**Respuesta de detail:**
```json
{
  "asiento": {
    "id": "asiento-123",
    "numeroAsiento": "FAC-ING-FAC-001",
    "estado": "PENDING_REVIEW",
    "fechaAsiento": "2026-06-13",
    "origen": "INCOME_INVOICE",
    "facturaId": "inv-456",
    "lineas": [
      {
        "id": "linea-1",
        "accountCode": "430",
        "accountName": "Clientes",
        "debe": 1210,
        "haber": 0,
        "descripcion": "Venta factura FAC-001"
      },
      {
        "id": "linea-2",
        "accountCode": "700",
        "accountName": "Ventas de productos",
        "debe": 0,
        "haber": 1000
      },
      {
        "id": "linea-3",
        "accountCode": "477",
        "accountName": "IVA Repercutido",
        "debe": 0,
        "haber": 210
      }
    ],
    "totalDebe": 1210,
    "totalHaber": 1210,
    "createdAt": "2026-06-13T10:00:00Z",
    "createdBy": "user-123"
  },
  "validaciones": {
    "cuadrado": true,
    "errores": []
  },
  "permitidoAprobar": true,
  "permitidoAjustar": false // true si es DRAFT/PENDING_REVIEW
}
```

**Comportamiento:**
- ✅ Mostrar tabla de líneas (Código, Nombre Cuenta, Debe, Haber)
- ✅ Validación visual: "✅ Asiento cuadrado" o "❌ Desbalanceado"
- ✅ Si `permitidoAprobar`: botón APROBAR (abre modal de confirmación)
- ✅ Si `permitidoAjustar`: click en línea abre modal de ajuste
- ✅ Mostrar origen (ej: "Factura de ingreso FAC-001")

---

### 3. ApprovalModal

**Responsabilidad:** Confirmar aprobación de asiento

**Props:**
```typescript
interface ApprovalModalProps {
  asientoId: string;
  companyId: string;
  numeroAsiento: string;
  onSuccess?: () => void;
  onCancel?: () => void;
}
```

**Endpoint:**
```
POST /api/companies/{companyId}/accounting/journal-entries/{asientoId}/approve
Body: {
  "observaciones": "Verificado por contable"
}
```

**Comportamiento:**
- ✅ Mostrar número de asiento + confirmación
- ✅ Campo textarea para observaciones (opcional)
- ✅ Botones: APROBAR (POST), CANCELAR
- ✅ Loading spinner durante POST
- ✅ Toast de éxito si aprobación exitosa
- ✅ Error toast si falla

---

### 4. LineAdjustmentModal

**Responsabilidad:** Cambiar cuenta o montos de una línea

**Props:**
```typescript
interface LineAdjustmentModalProps {
  journalEntryId: string;
  lineId: string;
  companyId: string;
  currentAccountCode: string;
  currentDebe: number;
  currentHaber: number;
  onSuccess?: () => void;
}
```

**Endpoint:**
```
PATCH /api/companies/{companyId}/accounting/journal-entries/{journalEntryId}/lines/{lineId}
Body: {
  "accountCode": "7001",  // opcional
  "debe": 100,            // opcional
  "haber": 0              // opcional
}
```

**Comportamiento:**
- ✅ Combobox para seleccionar cuenta (autocomplete)
- ✅ Campos numéricos para debe/haber (solo uno puede tener valor)
- ✅ Validación: suma de debe = suma de haber
- ✅ Si validación falla: mostrar error rojo
- ✅ Botones: GUARDAR, CANCELAR
- ✅ GUARDAR solo habilitado si:
  - Al menos un campo cambió
  - Asiento está balanceado
  - Usuario tiene permiso contabilidad:write

---

### 5. BalanceSheet

**Responsabilidad:** Mostrar Balance General

**Props:**
```typescript
interface BalanceSheetProps {
  companyId: string;
  desde: string; // ISO date
  hasta: string;
}
```

**Endpoint:**
```
GET /api/companies/{companyId}/reports/balance
  ?from=2026-01-01&to=2026-12-31
```

**Respuesta:**
```json
{
  "fecha": "2026-06-13",
  "activo": {
    "noCirculante": {
      "inmovilizado": 0,
      "deudoresLargoP": 0
    },
    "circulante": {
      "clientes": 1210,
      "tesoreria": 5000
    },
    "totalActivo": 6210
  },
  "pasivo": {
    "noCirculante": {
      "deudas": 0
    },
    "circulante": {
      "proveedores": 1000,
      "acreedores": 0
    },
    "totalPasivo": 1000
  },
  "patrimonioNeto": {
    "capital": 3000,
    "reservas": 0,
    "resultado": 1210
  },
  "totalPatrimonio": 4210,
  "cuadre": true // Activo = Pasivo + Patrimonio
}
```

**Comportamiento:**
- ✅ Mostrar estructura de Balance en tabla anidada
- ✅ Ocultar cuentas con saldo 0
- ✅ Resaltar totales en negrita
- ✅ Si no cuadra: mostrar advertencia "⚠️ Balance no cuadra"
- ✅ Click en grupo expande/contrae subcuentas

---

### 6. ProfitAndLoss

**Responsabilidad:** Mostrar Pérdidas y Ganancias

**Props:**
```typescript
interface ProfitAndLossProps {
  companyId: string;
  desde: string;
  hasta: string;
}
```

**Endpoint:**
```
GET /api/companies/{companyId}/reports/profit-and-loss
  ?from=2026-01-01&to=2026-12-31
```

**Respuesta:**
```json
{
  "periodo": "2026",
  "ingresos": {
    "ventas": 2500,
    "otrosIngresos": 0,
    "totalIngresos": 2500
  },
  "gastos": {
    "personaServicio": 0,
    "serviciosExteriores": 1000,
    "otrosGastos": 0,
    "totalGastos": 1000
  },
  "resultadoExplotacion": 1500,
  "otrosResultados": 0,
  "resultadoAntes": 1500,
  "impuestos": 0,
  "resultadoNeto": 1500
}
```

**Comportamiento:**
- ✅ Mostrar estructura P&L con indentación
- ✅ Mostrar porcentajes (% sobre ventas)
- ✅ Gráfico opcional: barras Ingresos vs Gastos
- ✅ Resaltar resultado neto en verde (ganancia) o rojo (pérdida)

---

### 7. VATBooks

**Responsabilidad:** Mostrar Libro IVA (emitidas/recibidas)

**Props:**
```typescript
interface VATBooksProps {
  companyId: string;
  tipoLibro: 'EMITIDAS' | 'RECIBIDAS';
  periodo: string; // Q2-2026
}
```

**Endpoints:**
```
GET /api/companies/{companyId}/tax/vat/books/issued?period=Q2-2026
GET /api/companies/{companyId}/tax/vat/books/received?period=Q2-2026
```

**Respuesta:**
```json
{
  "periodo": "Q2-2026",
  "tipoLibro": "EMITIDAS",
  "facturas": [
    {
      "id": "vat-1",
      "numeroFactura": "FAC-001",
      "fechaFactura": "2026-06-13",
      "nifCliente": "12345678A",
      "nombreCliente": "Cliente S.L.",
      "baseImponible": 1000,
      "tipoIva": 21,
      "cuotaIva": 210,
      "estado": "REGISTRADA"
    }
  ],
  "totalBases": 2500,
  "totalCuotas": 525,
  "cuotasDeducibles": 0
}
```

**Comportamiento:**
- ✅ Tabla con columnas: N°Factura, Fecha, Cliente/Proveedor, Base, IVA, Cuota
- ✅ Resumen en footer: Total bases, Total cuotas, Cuotas deducibles (RECIBIDAS)
- ✅ Combo para cambiar período (Q1-2026, Q2-2026, etc.)
- ✅ Botón EXPORTAR PDF/EXCEL

---

### 8. TaxSummary (Modelo 303)

**Responsabilidad:** Mostrar resumen IVA para declaración

**Props:**
```typescript
interface TaxSummaryProps {
  companyId: string;
  periodo: string; // Q2-2026
}
```

**Endpoint:**
```
GET /api/companies/{companyId}/tax/vat/summary?period=Q2-2026
POST /api/companies/{companyId}/tax/export/modelo-303?format=txt
```

**Respuesta:**
```json
{
  "periodo": "Q2-2026",
  "empresa": {
    "nif": "A28123456",
    "nombre": "Mi Empresa S.L."
  },
  "emitidas": {
    "bases": 2500,
    "cuotas": 525
  },
  "recibidas": {
    "bases": 1000,
    "cuotas": 210
  },
  "cuotaAIngresar": 315,
  "retencionesRecibidas": 150,
  "deuda": 165
}
```

**Comportamiento:**
- ✅ Mostrar resumen en formato tabla con dos columnas (Emitidas / Recibidas)
- ✅ Cálculo automático: Cuota a Ingresar = Emitidas - Recibidas
- ✅ Botón EXPORTAR MODELO 303 (descarga .txt)
- ✅ Botón VER DETALLES (expande línea por línea)

---

## 🔄 Flujos de Usuario

### Flujo 1: Usuario No-Contable Confirma Factura

```
1. Usuario ve invoice en estado DRAFT
2. Click en "Confirmar" → API POST /invoices/income/{id}/status
3. Enganche automático contabiliza (backend)
4. Si éxito: "Factura confirmada. Asiento generado."
5. Si error en contabilización:
   - La factura se confirma igual (fail-safe)
   - Toast advertencia: "⚠️ Error en contabilización. Avisa a admin."
6. Usuario ve nueva pestaña "Asientos" → lista asientos pendientes
```

### Flujo 2: Advisor Revisa y Aprueba Asiento

```
1. Advisor accede a módulo "Contabilidad" → Asientos Pendientes
2. Ve lista filtrada por estado=PENDING_REVIEW
3. Click en asiento → abre detail view
4. Revisa líneas:
   - Si alguna es incorrecta: click en línea → modal ajuste
   - Cambia cuenta o montos
   - Sistema valida: debe = haber
   - Click GUARDAR si validación ok
5. Una vez satisfecho: botón APROBAR asiento
6. Modal pide confirmación
7. Click APROBAR → POST /journal-entries/{id}/approve
8. Si éxito:
   - Estado del asiento → POSTED
   - Toast: "Asiento aprobado ✓"
   - Lista actualiza automáticamente
9. Advisor regresa a lista
```

### Flujo 3: Modificación de Factura Contabilizada

```
1. Usuario modifica factura ya POSTED
2. Backend: onInvoiceModified enganche
   - Asiento original → REVERSED (POSTED)
   - Nuevo asiento → PENDING_REVIEW (con datos actualizados)
3. Frontend actualiza automáticamente:
   - Si estaba viendo detail del asiento original:
     - Muestra "⚠️ Este asiento fue reversado"
     - Link a nuevo asiento: "Ver nuevo asiento..."
4. Advisor ve nuevo asiento en lista PENDING_REVIEW
5. Aprueba nuevo asiento (mismo flujo que Flujo 2)
```

### Flujo 4: Generar Reporte de Balance

```
1. Usuario accede a "Reportes" → "Balance General"
2. Selecciona rango de fechas (ej: 01/01/2026 - 13/06/2026)
3. Sistema: GET /reports/balance?from=2026-01-01&to=2026-06-13
4. Muestra balance en tabla anidada
5. Si activo ≠ pasivo + patrimonio:
   - Advertencia: "⚠️ Balance no cuadra. Verifica asientos."
6. Usuario puede click en grupo → expande detalles
7. Click en cuenta → abre Mayor (histórico de movimientos)
```

---

## 🔌 Patrones de Consumo de API

### Patrón 1: Listar con Filtros y Paginación

```typescript
// accountingService.ts
export async function getJournalEntries(
  companyId: string,
  filters?: {
    estado?: string;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }
): Promise<JournalEntryListResponse> {
  const params = new URLSearchParams();
  if (filters?.estado) params.set('estado', filters.estado);
  if (filters?.from) params.set('from', filters.from);
  if (filters?.to) params.set('to', filters.to);
  if (filters?.skip !== undefined) params.set('skip', String(filters.skip));
  if (filters?.take !== undefined) params.set('take', String(filters.take));

  const response = await fetch(
    `/api/companies/${companyId}/accounting/journal-entries?${params}`,
    {
      headers: { Authorization: `Bearer ${getToken()}` }
    }
  );

  if (!response.ok) {
    throw new Error(`Error: ${response.status} - ${response.statusText}`);
  }

  return response.json();
}
```

### Patrón 2: Detalle + Acciones

```typescript
// accountingService.ts
export async function getJournalEntryDetail(
  companyId: string,
  journalEntryId: string
): Promise<JournalEntryDetailResponse> {
  const response = await fetch(
    `/api/companies/${companyId}/accounting/journal-entries/${journalEntryId}`,
    {
      headers: { Authorization: `Bearer ${getToken()}` }
    }
  );

  if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
  return response.json();
}

export async function approveJournalEntry(
  companyId: string,
  journalEntryId: string,
  observaciones?: string
): Promise<JournalEntryDetailResponse> {
  const response = await fetch(
    `/api/companies/${companyId}/accounting/journal-entries/${journalEntryId}/approve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getToken()}`
      },
      body: JSON.stringify({ observaciones })
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Aprobación fallida');
  }

  return response.json();
}
```

### Patrón 3: Contexto Global para Invalidar Cache

```typescript
// AccountingContext.tsx
interface AccountingContextType {
  asientos: JournalEntry[];
  loading: boolean;
  error: string | null;
  refreshAsientos: () => Promise<void>;
  selectAsiento: (id: string) => void;
  selectedAsiento: JournalEntry | null;
}

export const useAccounting = () => {
  const context = useContext(AccountingContext);
  if (!context) {
    throw new Error('useAccounting debe usarse dentro de AccountingProvider');
  }
  return context;
};

// En componente:
function JournalEntryList() {
  const { asientos, loading, error, refreshAsientos } = useAccounting();

  useEffect(() => {
    refreshAsientos();
  }, []);

  const handleApproveSuccess = async () => {
    await refreshAsientos(); // Invalida cache
  };

  return (
    // ...
  );
}
```

---

## 🎯 Estados y Validaciones

### Estados de Asiento

```typescript
type JournalEntryEstado = 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';

const estadoBadgeColor = {
  DRAFT: 'gray',
  PENDING_REVIEW: 'yellow',
  POSTED: 'green',
  REVERSED: 'red'
};

const estadoPermitidoAprobar = {
  DRAFT: false,
  PENDING_REVIEW: true,
  POSTED: false,
  REVERSED: false
};

const estadoPermitidoAjustar = {
  DRAFT: true,
  PENDING_REVIEW: true,
  POSTED: false,
  REVERSED: false
};
```

### Validaciones en Líneas

```typescript
// Al editar una línea en modal
function validateLineAdjustment(
  asiento: JournalEntry,
  lineId: string,
  newValues: { accountCode?: string; debe?: number; haber?: number }
): ValidationResult {
  const updatedAsiento = {
    ...asiento,
    lineas: asiento.lineas.map(l => 
      l.id === lineId ? { ...l, ...newValues } : l
    )
  };

  const totalDebe = updatedAsiento.lineas.reduce((s, l) => s + (l.debe ?? 0), 0);
  const totalHaber = updatedAsiento.lineas.reduce((s, l) => s + (l.haber ?? 0), 0);

  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    return {
      valid: false,
      error: `Asiento desbalanceado: debe=${totalDebe}, haber=${totalHaber}`
    };
  }

  return { valid: true };
}
```

---

## 📊 Reportes y Vistas

### Dashboard Principal

```
┌─ DASHBOARD CONTABLE ──────────────────────────────┐
│                                                    │
│ 📈 Resumen (período seleccionable)                │
│  - Ingresos Q2: €2.500                           │
│  - Gastos Q2: €1.000                             │
│  - Beneficio: €1.500                             │
│                                                    │
│ ⏳ Asientos Pendientes: 3                         │
│  [VER TODOS] →                                    │
│                                                    │
│ 💰 Balance Quick View                             │
│  Activo: €6.210  |  Pasivo: €1.000  |  Pat: €4.210
│                                                    │
│ 📋 Documentos Pendientes                          │
│  - Modelo 303 Q2: Generado ✓                      │
│  - Modelo 190: Pendiente ⚠️                       │
│                                                    │
└────────────────────────────────────────────────────┘
```

### Reporte Balance

```
Rango: 01/01/2026 - 13/06/2026

BALANCE GENERAL
================

ACTIVO
  No Circulante
    - Inmovilizado Material          €0,00
    - Deudores L/P                   €0,00
  Circulante
    - Clientes                       €1.210,00
    - Tesorería                      €5.000,00
                                    ─────────────
TOTAL ACTIVO                         €6.210,00

PASIVO
  No Circulante
    - Deudas L/P                     €0,00
  Circulante
    - Proveedores                    €1.000,00
    - Acreedores                     €0,00
                                    ─────────────
TOTAL PASIVO                         €1.000,00

PATRIMONIO NETO
  - Capital                          €3.000,00
  - Resultado del Período            €2.210,00
                                    ─────────────
TOTAL PATRIMONIO                     €5.210,00
                                    ─────────────
TOTAL PASIVO + PATRIMONIO            €6.210,00

✅ Balance Cuadra
```

---

## 🚨 Manejo de Errores

### Errores de API

```typescript
interface APIError {
  statusCode: number;
  message: string;
  details?: Record<string, any>;
}

async function handleAPIError(error: any): Promise<string> {
  if (error.response?.status === 400) {
    // Bad request - validación fallida
    return error.response.data.message || 'Datos inválidos';
  }
  if (error.response?.status === 401) {
    // Unauthorized - token expirado
    redirectToLogin();
    return 'Sesión expirada';
  }
  if (error.response?.status === 403) {
    // Forbidden - sin permisos
    return 'No tienes permisos para esta acción';
  }
  if (error.response?.status === 500) {
    // Server error
    return 'Error del servidor. Contacta a soporte.';
  }
  return error.message || 'Error desconocido';
}
```

### Errores en Componentes

```typescript
function JournalEntryDetail({ journalEntryId }: Props) {
  const [asiento, setAsiento] = useState<JournalEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadAsiento();
  }, [journalEntryId]);

  async function loadAsiento() {
    setLoading(true);
    setError(null);
    try {
      const data = await getJournalEntryDetail(companyId, journalEntryId);
      setAsiento(data.asiento);
    } catch (err) {
      setError(handleAPIError(err));
      // Mostrar error en toast o alert
      toast.error(error);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBanner message={error} onRetry={loadAsiento} />;
  if (!asiento) return <NotFound />;

  return <AsientoContent asiento={asiento} />;
}
```

---

## 📝 Notas de Implementación

### Performance

- Usar paginación en listas (take=20 por defecto)
- Cachear contexto con useCallback para evitar re-renders
- Lazy load de reportes (cargar solo al hacer click)
- Debounce en filtros de búsqueda

### Accesibilidad

- Labels en todos los inputs
- ARIA labels en botones icon-only
- Navegación con Tab
- Toast messages anunciables

### Seguridad

- Validar permisos en frontend (opcional, truthy para UX)
- Backend siempre valida permisos
- Nunca guardar tokens en localStorage (usar httpOnly cookies si es posible)
- CSRF tokens en formularios que muteen estado

### Localización

- Números: usar intl.NumberFormat para EUR
- Fechas: usar intl.DateTimeFormat para ES-es
- Textos: usar i18n (ej: i18next)

---

## ✅ Checklist de Integración

- [ ] Crear carpeta `src/services/accounting/`
- [ ] Implementar `accountingService.ts` (CRUD + approve + adjust)
- [ ] Implementar `reportsService.ts` (balance, pyg, books)
- [ ] Implementar `taxService.ts` (303, 190, exports)
- [ ] Crear `AccountingContext` y `useAccounting` hook
- [ ] Crear componentes: JournalEntryList, JournalEntryDetail
- [ ] Crear componentes: ApprovalModal, LineAdjustmentModal
- [ ] Crear componentes: BalanceSheet, ProfitAndLoss
- [ ] Crear componentes: VATBooks, TaxSummary
- [ ] Integrar hooks en invoice controller (confirmación automática)
- [ ] Testing: unit tests para services
- [ ] Testing: E2E tests para flujos principales
- [ ] Documentación: README para developers

---

**Fin de especificación v1.0**
