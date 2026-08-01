# Frontend Implementation Summary - Motor Contable

**Fecha:** 13 de junio de 2026  
**Estado:** ✅ Implementación Fase 1 Completa  
**Stack:** React + TypeScript + Chakra UI + React Router

---

## 📦 Archivos Creados

### 1. **API Types** (`src/api/types.ts`)
- Interfaces TypeScript para todas las respuestas del backend
- Tipos: JournalEntry, JournalEntryDetail, BalanceSheet, ProfitAndLoss, etc.
- Request bodies: ApproveJournalEntryRequest, AdjustJournalEntryLineRequest

### 2. **HTTP Client** (`src/utils/http.ts`)
- Wrapper de fetch para simplificar llamadas HTTP
- Autenticación con JWT token
- Manejo centralizado de errores
- Funciones: httpGet, httpPost, httpPatch, httpDelete

### 3. **API Services**
- **`src/api/accountingApi.ts`**
  - getJournalEntries()
  - getJournalEntryDetail()
  - approveJournalEntry()
  - recalculateJournalEntry()
  - adjustJournalEntryLine()
  - contabilizarFactura()

- **`src/api/reportsApi.ts`**
  - getBalanceSheet()
  - getProfitAndLoss()
  - getLedger()
  - getAnalysisByCustomer()
  - getMonthlyEvolution()
  - getVATBooksIssued()
  - getVATBooksReceived()
  - getTaxSummary303()
  - getTaxSummary190()

### 4. **Hooks** (`src/hooks/useCompanyId.ts`)
- useCompanyId(): obtiene companyId de parámetros de ruta
- useCompanyIdSafe(): versión que no lanza error

### 5. **Utilidades de Formateo** (`src/utils/formatters.ts`)
- formatCurrency(): formatea números como EUR
- formatDate(): formatea fechas ISO
- getEstadoLabel(): etiqueta legible de estado
- getEstadoColor(): color para badge de estado
- getOrigenLabel(): etiqueta de origen de asiento
- validateBalance(): valida que debe = haber
- calculateBalance(): calcula saldo (debe - haber)

### 6. **Componentes Reutilizables**
- **`src/components/accounting/JournalEntryTable.tsx`**
  - Tabla con lista de asientos
  - Props: entries, loading, onSelectEntry, onViewDetail
  - Mostrado en JournalEntryList

- **`src/components/accounting/JournalEntryLinesTable.tsx`**
  - Tabla de líneas contables (debe/haber)
  - Props: lines, totalDebe, totalHaber, balanced, canEdit, onEditLine
  - Mostrado en JournalEntryDetail
  - Validación visual de balance

### 7. **Páginas (Pages)**

#### **A. Contabilidad**

**`src/pages/accounting/JournalEntryList.tsx`**
- Ruta: `/companies/:companyId/accounting/journal-entries`
- Funciones:
  - Listar asientos con filtros (estado, origen, fecha)
  - Paginación
  - Búsqueda en tiempo real
  - Navegación a detalle
- Estado: loading, error, entries
- Filtros: estado, origen, desde, hasta

**`src/pages/accounting/JournalEntryDetail.tsx`**
- Ruta: `/companies/:companyId/accounting/journal-entries/:id`
- Funciones:
  - Mostrar detalle de asiento
  - Tabla de líneas con validación de balance
  - Botón APROBAR (si permitidoAprobar = true)
  - Botón RECALCULAR (si estado = PENDING_REVIEW)
  - Modal de confirmación para aprobación
  - Campo de observaciones
- Acciones:
  - POST /journal-entries/:id/approve
  - POST /journal-entries/:id/recalculate

#### **B. Reportes**

**`src/pages/reports/BalanceSheet.tsx`**
- Ruta: `/companies/:companyId/reports/balance`
- Funciones:
  - Mostrar Balance General estructurado
  - Secciones: Activo (no circulante/circulante), Pasivo, Patrimonio
  - Validación de cuadre (Activo = Pasivo + Patrimonio)
  - Filtros por fecha
  - Expandible por sección
- Componentes auxiliares:
  - BalanceBlock: bloque de balance expandible
  - Grid3Col: grid para resumen

**`src/pages/reports/ProfitAndLoss.tsx`**
- Ruta: `/companies/:companyId/reports/profit-and-loss`
- Funciones:
  - Mostrar Pérdidas y Ganancias estructurado
  - Secciones: Ingresos, Gastos, Resultado Explotación, Resultado Neto
  - Filtros por fecha
  - Margen de beneficio
  - Indicador visual de ganancia/pérdida
- Datos visuales:
  - Tabla detallada
  - Resumen en 3 cajas (Ingresos, Gastos, Resultado)

### 8. **Rutas**
- **`src/routes/accounting.routes.tsx`**
  - Routes: /journal-entries, /journal-entries/:id

- **`src/routes/reports.routes.tsx`**
  - Routes: /balance, /profit-and-loss
  - TODO: /ledger, /analytics/monthly, /analytics/by-customer

### 9. **Documentación**
- **`src/FRONTEND_README.md`** - Guía de instalación e integración
- **`FRONTEND_IMPLEMENTATION_SUMMARY.md`** - Este archivo

---

## 🚀 Integración en tu Aplicación React

### Paso 1: Instalar Dependencias

```bash
npm install @chakra-ui/react @emotion/react @emotion/styled framer-motion
```

### Paso 2: Envolver App con ChakraProvider

En tu `main.tsx` o `App.tsx`:

```tsx
import { ChakraProvider } from '@chakra-ui/react';

function App() {
  return (
    <ChakraProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/companies/:companyId">
            <Route path="accounting/*" element={<AccountingRoutes />} />
            <Route path="reports/*" element={<ReportsRoutes />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ChakraProvider>
  );
}
```

### Paso 3: Importar Rutas

```tsx
import { AccountingRoutes } from '@routes/accounting.routes';
import { ReportsRoutes } from '@routes/reports.routes';
```

### Paso 4: Configurar Autenticación

En tu componente de login o al hacer auth:

```typescript
localStorage.setItem('jwt_token', token);
```

### Paso 5: Variable de Entorno

Crear `.env`:

```env
REACT_APP_API_URL=http://localhost:3000/api
```

---

## 📊 Cobertura de Componentes - Fase 1

| Componente | Archivo | Estado | Notas |
|-----------|---------|--------|-------|
| JournalEntryList | ✅ | Completo | Listado con filtros |
| JournalEntryDetail | ✅ | Completo | Detalle + Aprobar/Recalcular |
| BalanceSheet | ✅ | Completo | Balance General |
| ProfitAndLoss | ✅ | Completo | P&L con márgenes |
| LineAdjustmentModal | ⏳ | Pendiente | Fase 2 |
| VATBooks | ⏳ | Pendiente | Fase 2 |
| TaxSummary | ⏳ | Pendiente | Fase 2 |
| Mayor | ⏳ | Pendiente | Fase 3 |
| Analytics | ⏳ | Pendiente | Fase 3 |

---

## 🔌 Endpoints Consumidos

### Contabilidad

```
GET  /api/companies/:companyId/accounting/journal-entries
     - Parámetros: estado, origen, from, to, skip, take
     - Respuesta: { asientos: [], total, paginacion }

GET  /api/companies/:companyId/accounting/journal-entries/:id
     - Respuesta: JournalEntryDetail

POST /api/companies/:companyId/accounting/journal-entries/:id/approve
     - Body: { observaciones? }
     - Respuesta: JournalEntryDetail

POST /api/companies/:companyId/accounting/journal-entries/:id/recalculate
     - Respuesta: JournalEntryDetail
```

### Reportes

```
GET  /api/companies/:companyId/reports/balance
     - Parámetros: from, to
     - Respuesta: BalanceSheetResponse

GET  /api/companies/:companyId/reports/profit-and-loss
     - Parámetros: from, to
     - Respuesta: ProfitAndLossResponse
```

---

## 🎨 UI/UX - Decisiones de Diseño

### Colores de Estados

| Estado | Color | Label |
|--------|-------|-------|
| DRAFT | Gray | Borrador |
| PENDING_REVIEW | Yellow | Pendiente de Revisión |
| POSTED | Green | Contabilizado |
| REVERSED | Red | Reversado |

### Validaciones Visuales

- ✅ Asiento balanceado: alert success verde
- ❌ Asiento desbalanceado: alert error rojo
- ⚠️ Errores de validación: alert warning

### Usabilidad para No-Contables

- Labels claros sin jerga contable
- Íconos de estado (+/- colores)
- Campos requeridos marcados
- Confirmaciones antes de acciones irreversibles

---

## 🧪 Testing (Recomendado)

### Frameworks Sugeridos

```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom jest
```

### Ejemplo de Test

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

describe('JournalEntryList', () => {
  it('debe mostrar asientos cargados', async () => {
    render(<JournalEntryListPage />);
    
    await waitFor(() => {
      expect(screen.getByText(/Asientos Contables/)).toBeInTheDocument();
    });
  });

  it('debe filtrar por estado', async () => {
    const user = userEvent.setup();
    render(<JournalEntryListPage />);
    
    const selectEstado = screen.getByDisplayValue('Todos');
    await user.selectOption(selectEstado, 'PENDING_REVIEW');
    
    await waitFor(() => {
      // Validar que la tabla se actualizó
    });
  });
});
```

---

## 📝 Convenciones de Código

### Estructura de Componentes

```tsx
// 1. Imports
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Button } from '@chakra-ui/react';

// 2. Props Interface
interface MyComponentProps {
  title: string;
  onAction?: () => void;
}

// 3. Component
export function MyComponent({ title, onAction }: MyComponentProps) {
  // 4. State
  const [data, setData] = useState(null);
  
  // 5. Effects
  useEffect(() => {
    loadData();
  }, []);
  
  // 6. Handlers
  function handleClick() {
    // ...
  }
  
  // 7. Render
  return (
    <Box>
      {/* JSX */}
    </Box>
  );
}

// 8. Helper functions (fuera del componente)
function helperFunction() {
  // ...
}
```

### Nombres de Variables

- Componentes: PascalCase (JournalEntryList)
- Variables/funciones: camelCase (journalEntries, handleApprove)
- Constantes: UPPER_SNAKE_CASE (API_BASE_URL)
- Tipos: PascalCase (JournalEntry, APIErrorResponse)

---

## ⚡ Rendimiento

### Optimizaciones Implementadas

- ✅ State management local (no Redux para fase 1)
- ✅ Lazy loading de reportes (cargan al hacer click)
- ✅ Paginación de asientos (take=20 por defecto)
- ⏳ Memoización de componentes (React.memo) - pendiente
- ⏳ React Query para caching - fase 2

### Recomendaciones Futuras

```bash
npm install @tanstack/react-query
```

---

## 🐛 Troubleshooting Común

### "Cannot find module @api/types"

Asegúrate de tener configurado path alias en `tsconfig.json`:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@api/*": ["src/api/*"],
      "@components/*": ["src/components/*"],
      "@pages/*": ["src/pages/*"],
      "@hooks/*": ["src/hooks/*"],
      "@routes/*": ["src/routes/*"],
      "@utils/*": ["src/utils/*"]
    }
  }
}
```

### "401 Unauthorized" en todas las llamadas

Verifica que el token esté en localStorage:

```javascript
localStorage.setItem('jwt_token', token);
```

Y que el backend tenga CORS habilitado.

### Componentes no se actualizan tras acciones

Usa `await` en funciones async y maneja el estado correctamente:

```tsx
async function handleApprove() {
  const updated = await approveJournalEntry(companyId, asientoId);
  setAsiento(updated); // Actualizar state
}
```

---

## 📦 Próximas Fases

### **Fase 2 (Componentes Secundarios)**
- [ ] LineAdjustmentModal (editar línea de asiento)
- [ ] VATBooks (Libro IVA emitidas/recibidas)
- [ ] TaxSummary (Modelo 303)
- [ ] Exportar reportes (PDF/Excel)

### **Fase 3 (Analytics)**
- [ ] Mayor (histórico de movimientos por cuenta)
- [ ] Análisis por cliente
- [ ] Evolución mensual (gráficos)
- [ ] Dashboard principal

### **Fase 4 (Testing & Polish)**
- [ ] Unit tests (Jest + RTL)
- [ ] E2E tests (Cypress)
- [ ] Dark mode
- [ ] Internacionalización (i18n)
- [ ] PWA features

---

## 🎯 Roadmap de Integración Recomendado

**Semana 1:**
1. Instalar dependencias
2. Copiar archivos de API, hooks, utils
3. Integrar AccountingRoutes y ReportsRoutes
4. Verificar autenticación

**Semana 2:**
5. Testing de JournalEntryList con datos reales
6. Testing de JournalEntryDetail (aprobar/recalcular)
7. Testing de BalanceSheet
8. Testing de ProfitAndLoss

**Semana 3:**
9. Inicio Fase 2 (LineAdjustmentModal)
10. Inicio VATBooks
11. Integración con factura de ingreso

---

## 📞 Soporte

- Documentación backend: `docs/FRONTEND_INTEGRATION_SPEC.md`
- Tests de API: `docs/QA_TESTING_CHECKLIST.md`
- Especificación técnica: `docs/superpowers/specs/2026-06-13-motor-contable-hibrido-design.md`

---

**Implementación completada: 13 de junio de 2026**  
**Próxima fase: Fase 2 - Componentes Secundarios**
