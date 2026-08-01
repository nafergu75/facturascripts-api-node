# Frontend Quick Start - Motor Contable (5 pasos)

**Tiempo estimado:** 30 minutos

---

## ✅ Paso 1: Instalar Dependencias (5 min)

```bash
npm install @chakra-ui/react @emotion/react @emotion/styled framer-motion
```

---

## ✅ Paso 2: Configurar Path Aliases en TypeScript (3 min)

Edita `tsconfig.json`:

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

---

## ✅ Paso 3: Envolver App con Chakra UI Provider (2 min)

En tu `main.tsx`:

```tsx
import { ChakraProvider } from '@chakra-ui/react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ChakraProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ChakraProvider>
  </React.StrictMode>
);
```

---

## ✅ Paso 4: Integrar Rutas en App.tsx (10 min)

```tsx
import { Routes, Route } from 'react-router-dom';
import { AccountingRoutes } from '@routes/accounting.routes';
import { ReportsRoutes } from '@routes/reports.routes';

export function App() {
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

---

## ✅ Paso 5: Configurar Variables de Entorno (5 min)

Crea `.env` en la raíz:

```env
REACT_APP_API_URL=http://localhost:3000/api
```

---

## 🚀 ¡Listo! Prueba en el navegador

```
http://localhost:5173/companies/tu-company-id/accounting/journal-entries
```

---

## 📁 Estructura de Archivos Creados

```
src/
├── api/
│   ├── types.ts ✅
│   ├── accountingApi.ts ✅
│   └── reportsApi.ts ✅
├── components/
│   └── accounting/
│       ├── JournalEntryTable.tsx ✅
│       └── JournalEntryLinesTable.tsx ✅
├── hooks/
│   └── useCompanyId.ts ✅
├── pages/
│   ├── accounting/
│   │   ├── JournalEntryList.tsx ✅
│   │   └── JournalEntryDetail.tsx ✅
│   └── reports/
│       ├── BalanceSheet.tsx ✅
│       └── ProfitAndLoss.tsx ✅
├── routes/
│   ├── accounting.routes.tsx ✅
│   └── reports.routes.tsx ✅
├── utils/
│   ├── http.ts ✅
│   └── formatters.ts ✅
└── FRONTEND_README.md ✅
```

---

## 🧪 Verificación Post-Instalación

Antes de usar el frontend:

1. **JWT Token en localStorage:**
   ```javascript
   localStorage.setItem('jwt_token', 'tu-token-aqui');
   ```

2. **Backend disponible:**
   ```bash
   curl -H "Authorization: Bearer tu-token" \
        http://localhost:3000/api/companies/tu-company-id/accounting/journal-entries
   ```

3. **CORS habilitado en backend:**
   ```bash
   # Si ves error CORS, el backend no tiene CORS configurado
   ```

---

## 📱 Rutas Disponibles Inmediatamente

| Ruta | Componente | Funcionalidad |
|------|-----------|----------------|
| `/companies/:companyId/accounting/journal-entries` | JournalEntryList | Listado + filtros |
| `/companies/:companyId/accounting/journal-entries/:id` | JournalEntryDetail | Detalle + Aprobar |
| `/companies/:companyId/reports/balance` | BalanceSheet | Balance General |
| `/companies/:companyId/reports/profit-and-loss` | ProfitAndLoss | P&L |

---

## 🎯 Próxima Fase

Cuando termines de verificar que funciona:

1. Ver: `FRONTEND_IMPLEMENTATION_SUMMARY.md` para detalles técnicos
2. Leer: `src/FRONTEND_README.md` para documentación completa
3. Testear: Casos en `docs/QA_TESTING_CHECKLIST.md`

---

## ⚡ Comandos Útiles

```bash
# Compilar sin errores de TypeScript
npm run type-check

# Ejecutar en desarrollo
npm run dev

# Build para producción
npm run build

# Testing (una vez configurado)
npm test
```

---

**¿Todo OK? Felicidades, tu frontend está listo. 🎉**
