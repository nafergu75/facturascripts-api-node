# Frontend - Motor Contable Automático

## Estructura de Carpetas

```
src/
├── api/
│   ├── types.ts                    # Interfaces de respuestas del API
│   ├── accountingApi.ts            # Servicio de contabilidad
│   └── reportsApi.ts               # Servicio de reportes
├── components/
│   └── accounting/
│       ├── JournalEntryTable.tsx      # Tabla de asientos
│       └── JournalEntryLinesTable.tsx # Tabla de líneas
├── hooks/
│   └── useCompanyId.ts             # Hook para obtener companyId
├── pages/
│   ├── accounting/
│   │   ├── JournalEntryList.tsx     # Listado de asientos
│   │   └── JournalEntryDetail.tsx   # Detalle de asiento
│   └── reports/
│       ├── BalanceSheet.tsx         # Balance General
│       └── ProfitAndLoss.tsx        # Pérdidas y Ganancias
├── routes/
│   ├── accounting.routes.tsx        # Rutas de contabilidad
│   └── reports.routes.tsx           # Rutas de reportes
├── utils/
│   ├── http.ts                      # Cliente HTTP wrapper
│   └── formatters.ts                # Funciones de formateo
└── FRONTEND_README.md               # Este archivo
```

## Instalación

### 1. Dependencias Requeridas

```bash
npm install react react-dom react-router-dom
npm install @chakra-ui/react @emotion/react @emotion/styled framer-motion
npm install @chakra-ui/icons
```

### 2. Configuración de Chakra UI

Asegúrate de que en tu `main.tsx` o `App.tsx` esté envuelto con `ChakraProvider`:

```tsx
import { ChakraProvider } from '@chakra-ui/react';

function App() {
  return (
    <ChakraProvider>
      {/* Tu aplicación aquí */}
    </ChakraProvider>
  );
}
```

### 3. Variables de Entorno

Crea un archivo `.env` en la raíz del proyecto:

```env
REACT_APP_API_URL=http://localhost:3000/api
```

## Integración en React Router

En tu archivo principal de rutas (`App.tsx` o `routes/index.tsx`):

```tsx
import { Routes, Route } from 'react-router-dom';
import { AccountingRoutes } from './routes/accounting.routes';
import { ReportsRoutes } from './routes/reports.routes';

export function AppRoutes() {
  return (
    <Routes>
      {/* Rutas protegidas por empresa */}
      <Route path="/companies/:companyId">
        <Route path="accounting/*" element={<AccountingRoutes />} />
        <Route path="reports/*" element={<ReportsRoutes />} />
      </Route>
    </Routes>
  );
}
```

## Rutas Disponibles

### Contabilidad

| Ruta | Componente | Descripción |
|------|-----------|-------------|
| `/companies/:companyId/accounting/journal-entries` | JournalEntryList | Listado de asientos |
| `/companies/:companyId/accounting/journal-entries/:id` | JournalEntryDetail | Detalle de asiento |

### Reportes

| Ruta | Componente | Descripción |
|------|-----------|-------------|
| `/companies/:companyId/reports/balance` | BalanceSheet | Balance General |
| `/companies/:companyId/reports/profit-and-loss` | ProfitAndLoss | Pérdidas y Ganancias |

## Autenticación

El cliente HTTP (`src/utils/http.ts`) busca el JWT token en `localStorage`:

```typescript
const token = localStorage.getItem('jwt_token');
```

Asegúrate de que al hacer login, el token se guarde en el localStorage:

```typescript
localStorage.setItem('jwt_token', responseToken);
```

Si el token expira (401), el usuario será redirigido a `/login`.

## Uso de Servicios API

### Ejemplos

#### Obtener lista de asientos

```tsx
import { getJournalEntries } from '@api/accountingApi';

const result = await getJournalEntries(companyId, {
  estado: 'PENDING_REVIEW',
  from: '2026-01-01',
  to: '2026-12-31',
  take: 20
});
```

#### Aprobar un asiento

```tsx
import { approveJournalEntry } from '@api/accountingApi';

const updated = await approveJournalEntry(
  companyId,
  journalEntryId,
  'Aprobado por QA'
);
```

#### Obtener Balance General

```tsx
import { getBalanceSheet } from '@api/reportsApi';

const balance = await getBalanceSheet(companyId, {
  from: '2026-01-01',
  to: '2026-12-31'
});
```

## Hooks Personalizados

### useCompanyId

Obtener el `companyId` de los parámetros de la ruta:

```tsx
import { useCompanyId } from '@hooks/useCompanyId';

export function MyComponent() {
  const companyId = useCompanyId(); // Lanza error si no está en ruta válida
  // ...
}
```

O de forma segura:

```tsx
import { useCompanyIdSafe } from '@hooks/useCompanyId';

const companyId = useCompanyIdSafe(); // Retorna null si no está disponible
```

## Funciones de Formateo

En `src/utils/formatters.ts`:

```typescript
formatCurrency(1000.50);  // "1.000,50 €"
formatDate('2026-06-13'); // "13/06/2026"
getEstadoLabel('PENDING_REVIEW'); // "Pendiente de Revisión"
getEstadoColor('POSTED'); // "green"
validateBalance(1000, 1000); // true
```

## Estados y Validaciones

### Estados de Asiento

```typescript
type Estado = 'DRAFT' | 'PENDING_REVIEW' | 'POSTED' | 'REVERSED';

const labels = {
  DRAFT: 'Borrador',
  PENDING_REVIEW: 'Pendiente de Revisión',
  POSTED: 'Contabilizado',
  REVERSED: 'Reversado'
};
```

## Manejo de Errores

Todos los servicios de API lanzan excepciones `APIErrorResponse`:

```typescript
interface APIErrorResponse {
  statusCode: number;
  message: string;
  details?: Record<string, any>;
}
```

Ejemplo de manejo:

```tsx
try {
  const result = await getJournalEntries(companyId, filters);
} catch (error) {
  if (error.statusCode === 401) {
    // Token expirado
  } else if (error.statusCode === 403) {
    // Sin permisos
  } else if (error.statusCode === 404) {
    // No encontrado
  } else {
    // Error genérico
  }
  console.error(error.message);
}
```

## Proximas Fases

### Fase 2
- [ ] LineAdjustmentModal (editar líneas)
- [ ] VATBooks (Libro IVA emitidas/recibidas)
- [ ] TaxSummary (Modelo 303)

### Fase 3
- [ ] Mayor por cuenta
- [ ] Analytics - Análisis por cliente
- [ ] Analytics - Evolución mensual
- [ ] Exportar reportes (PDF, Excel)

### Fase 4
- [ ] Dashboard principal (resumen de asientos pendientes)
- [ ] Integración con factura de ingreso (flow automático)
- [ ] Tests unitarios (Jest + React Testing Library)
- [ ] Tests E2E (Cypress o Playwright)

## Dependencias de UI Instaladas

```json
{
  "@chakra-ui/react": "^2.x.x",
  "@emotion/react": "^11.x.x",
  "@emotion/styled": "^11.x.x",
  "framer-motion": "^10.x.x"
}
```

Si usas Chakra UI, todos los componentes usan `Box`, `Table`, `Button`, `Modal`, etc. de Chakra.

## Troubleshooting

### "companyId no encontrado en parámetros de ruta"

Asegúrate de que la ruta esté configurada correctamente:

```tsx
<Route path="/companies/:companyId">
  <Route path="accounting/*" element={<AccountingRoutes />} />
</Route>
```

### "401 Unauthorized"

El token no está en localStorage o ha expirado. Redirige al login.

### CORS errors

Asegúrate de que el backend tiene CORS habilitado. En el backend:

```typescript
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
```

## Testing

### Estructura sugerida para tests

```
src/
├── __tests__/
│   ├── pages/
│   │   └── JournalEntryList.test.tsx
│   ├── components/
│   │   └── JournalEntryTable.test.tsx
│   └── api/
│       └── accountingApi.test.ts
```

Ejemplo de test:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JournalEntryListPage } from '@pages/accounting/JournalEntryList';

describe('JournalEntryList', () => {
  it('debe cargar y mostrar asientos', async () => {
    render(<JournalEntryListPage />);
    
    await waitFor(() => {
      expect(screen.getByText(/Asientos Contables/)).toBeInTheDocument();
    });
  });
});
```

---

**Última actualización:** 13 de junio de 2026
