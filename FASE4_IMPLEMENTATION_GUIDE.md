# Frontend Fase 4 - Implementation Guide

**Estado:** ✅ Componentes & Utilidades Creados  
**Fecha:** 13 de junio de 2026

---

## 📦 Entregables Fase 4

### 1. **Utilidades de Exportación** (`src/utils/exporters.ts`)

Funciones implementadas:
```typescript
✅ exportToCsv(filename, rows, headers)
✅ exportBalanceToCsv(balanceData)
✅ exportPyGToCsv(pygData)
✅ exportLedgerToCsv(ledgerData)
✅ exportCustomerAnalysisToCsv(customerAnalysisData)
✅ exportMonthlyEvolutionToCsv(monthlyData)
```

**Integración en páginas:**

#### BalanceSheet.tsx
```typescript
import { exportBalanceToCsv } from '../../utils/exporters';

// En JSX, agregar botón:
<Button
  size="sm"
  colorScheme="green"
  variant="outline"
  onClick={() => exportBalanceToCsv(balance!)}
  isDisabled={!balance}
>
  📥 Exportar CSV
</Button>
```

#### ProfitAndLoss.tsx
```typescript
import { exportPyGToCsv } from '../../utils/exporters';

<Button
  size="sm"
  colorScheme="green"
  variant="outline"
  onClick={() => exportPyGToCsv(pyg!)}
  isDisabled={!pyg}
>
  📥 Exportar CSV
</Button>
```

#### LedgerPage.tsx
```typescript
import { exportLedgerToCsv } from '../../utils/exporters';

<Button
  size="sm"
  colorScheme="green"
  variant="outline"
  onClick={() => exportLedgerToCsv(ledger!)}
  isDisabled={!ledger}
>
  📥 Exportar CSV
</Button>
```

#### CustomerAnalysis.tsx
```typescript
import { exportCustomerAnalysisToCsv } from '../../utils/exporters';

<Button
  size="sm"
  colorScheme="green"
  variant="outline"
  onClick={() => exportCustomerAnalysisToCsv(analysis!)}
  isDisabled={!analysis}
>
  📥 Exportar CSV
</Button>
```

---

### 2. **Gráficos Avanzados con Recharts**

#### MonthlyEvolutionChartV2 (`src/components/reports/MonthlyEvolutionChartV2.tsx`)

**Características:**
- ✅ LineChart y BarChart (seleccionables)
- ✅ Tooltips interactivos con formatCurrency
- ✅ Checkboxes para mostrar/ocultar series
- ✅ Soporte para comparativa período-a-período
- ✅ Botón de exportación CSV

**Integración en AccountingDashboard:**

```typescript
import { MonthlyEvolutionChartV2 } from '../../components/reports/MonthlyEvolutionChartV2';
import { exportMonthlyEvolutionToCsv } from '../../utils/exporters';

// En JSX:
{monthlyData && (
  <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
    <Heading size="sm" mb={4}>
      Evolución de Ingresos vs Gastos
    </Heading>
    <MonthlyEvolutionChartV2
      data={monthlyData.items}
      comparisonData={monthlyPreviousYear?.items} // Si está disponible
      loading={false}
      onExport={() => exportMonthlyEvolutionToCsv(monthlyData)}
    />
  </Box>
)}
```

#### CustomerAnalysisChart (`src/components/reports/CustomerAnalysisChart.tsx`)

**Características:**
- ✅ BarChart horizontal
- ✅ Top N clientes (configurable, default 10)
- ✅ Botón "Ver todos" para expandir
- ✅ Tooltips con porcentaje
- ✅ Exportación CSV

**Integración en CustomerAnalysis.tsx:**

```typescript
import { CustomerAnalysisChart } from '../../components/reports/CustomerAnalysisChart';
import { exportCustomerAnalysisToCsv } from '../../utils/exporters';

// En JSX:
<Box bg="white" p={4} borderRadius="md" boxShadow="sm">
  <Heading size="sm" mb={4}>
    Gráfico de Clientes
  </Heading>
  <CustomerAnalysisChart
    items={analysis?.items || []}
    topN={5}
    onExport={() => exportCustomerAnalysisToCsv(analysis!)}
  />
</Box>
```

---

### 3. **Comparativas Período-a-Período**

#### Evolución Mensual Comparativa

**Implementación:**

```typescript
// En AccountingDashboard.tsx

// Cargar datos de dos períodos
useEffect(() => {
  const currentYear = new Date().getFullYear();
  const previousYear = currentYear - 1;

  const [current, previous] = await Promise.all([
    getMonthlyEvolution(companyId, `${currentYear}-01-01`, `${currentYear}-12-31`),
    getMonthlyEvolution(companyId, `${previousYear}-01-01`, `${previousYear}-12-31`)
  ]);

  setMonthlyData(current);
  setMonthlyPreviousYear(previous);
}, [companyId]);

// Pasar a componente:
<MonthlyEvolutionChartV2
  data={monthlyData?.items}
  comparisonData={monthlyPreviousYear?.items}
/>
```

#### PyG Comparativa (Tabla)

En `ProfitAndLoss.tsx`:

```typescript
// Agregar filtro de año
const [year, setYear] = useState(new Date().getFullYear());
const [previousYear, setPreviousYear] = useState(year - 1);

// Cargar dos períodos
const [pyg, pygPrev] = await Promise.all([
  getProfitAndLoss(companyId, {
    from: `${year}-01-01`,
    to: `${year}-12-31`
  }),
  getProfitAndLoss(companyId, {
    from: `${previousYear}-01-01`,
    to: `${previousYear}-12-31`
  })
]);

// Mostrar tabla comparativa:
<Table size="sm">
  <Thead>
    <Tr>
      <Th>Concepto</Th>
      <Th isNumeric>Año {year}</Th>
      <Th isNumeric>Año {previousYear}</Th>
      <Th isNumeric>Variación</Th>
    </Tr>
  </Thead>
  <Tbody>
    <Tr>
      <Td>Ingresos</Td>
      <Td isNumeric>{formatCurrency(pyg.ingresos)}</Td>
      <Td isNumeric>{formatCurrency(pygPrev.ingresos)}</Td>
      <Td isNumeric color={pyg.ingresos >= pygPrev.ingresos ? 'green.600' : 'red.600'}>
        {((pyg.ingresos - pygPrev.ingresos) / pygPrev.ingresos * 100).toFixed(1)}%
      </Td>
    </Tr>
    {/* Repetir para Gastos, Resultado, etc. */}
  </Tbody>
</Table>
```

---

### 4. **Alertas/Notificaciones en Dashboard**

**Implementación en `AccountingDashboard.tsx`:**

```typescript
import { useMemo } from 'react';

// Calcular alertas basadas en datos cargados
const alerts = useMemo(() => {
  const items = [];

  // Alerta 1: Asientos pendientes
  if (pendingEntries && pendingEntries.asientos.length > 3) {
    items.push({
      id: 'pending-entries',
      type: 'warning',
      title: '⏳ Asientos Pendientes',
      description: `Tienes ${pendingEntries.asientos.length} asientos esperando revisión`,
      action: () => navigate(`/companies/${companyId}/accounting/journal-entries`),
      actionLabel: 'Ver Asientos'
    });
  }

  // Alerta 2: IVA a ingresar elevado
  if (vatData && Math.abs(vatData.cuotaAIngresar) > 10000) {
    const isDebt = vatData.cuotaAIngresar < 0;
    items.push({
      id: 'high-iva',
      type: 'info',
      title: '💰 IVA a Ingresar/Devolver',
      description: `${isDebt ? 'Devolución' : 'Ingreso'} de ${formatCurrency(Math.abs(vatData.cuotaAIngresar))} detectado`,
      action: () => navigate(`/companies/${companyId}/tax/summary`),
      actionLabel: 'Ver Detalle'
    });
  }

  // Alerta 3: Beneficio negativo (pérdidas)
  if (pygData && pygData.resultadoNeto < -5000) {
    items.push({
      id: 'losses',
      type: 'error',
      title: '📉 Pérdidas Detectadas',
      description: `Las pérdidas acumuladas son ${formatCurrency(Math.abs(pygData.resultadoNeto))}`,
      action: () => navigate(`/companies/${companyId}/reports/profit-and-loss`),
      actionLabel: 'Analizar'
    });
  }

  return items;
}, [pendingEntries, vatData, pygData, companyId, navigate]);

// En JSX, renderizar alertas:
{alerts.map(alert => (
  <Alert
    key={alert.id}
    status={alert.type}
    borderRadius="md"
    mb={4}
  >
    <AlertIcon />
    <Box flex="1">
      <AlertTitle>{alert.title}</AlertTitle>
      <AlertDescription fontSize="sm">
        {alert.description}
      </AlertDescription>
    </Box>
    {alert.action && (
      <Button
        size="sm"
        onClick={alert.action}
        ml={2}
      >
        {alert.actionLabel}
      </Button>
    )}
  </Alert>
))}
```

---

## 🔧 Instalación de Recharts

```bash
npm install recharts
```

---

## 📊 Archivos Nuevos/Modificados

| Archivo | Cambio | LOC |
|---------|--------|-----|
| `src/utils/exporters.ts` | NUEVO | 250 |
| `src/components/reports/MonthlyEvolutionChartV2.tsx` | NUEVO | 280 |
| `src/components/reports/CustomerAnalysisChart.tsx` | NUEVO | 200 |
| `src/pages/reports/BalanceSheet.tsx` | MOD | +15 |
| `src/pages/reports/ProfitAndLoss.tsx` | MOD | +15 |
| `src/pages/reports/LedgerPage.tsx` | MOD | +15 |
| `src/pages/reports/CustomerAnalysis.tsx` | MOD | +25 |
| `src/pages/accounting/AccountingDashboard.tsx` | MOD | +50 |

**Total nuevas:** ~730 LOC

---

## 🎯 Checklist de Integración

- [ ] Instalar Recharts: `npm install recharts`
- [ ] Copiar `src/utils/exporters.ts`
- [ ] Copiar `MonthlyEvolutionChartV2.tsx`
- [ ] Copiar `CustomerAnalysisChart.tsx`
- [ ] Agregar botones de exportación en 5 páginas
- [ ] Reemplazar gráfico en Dashboard con MonthlyEvolutionChartV2
- [ ] Agregar CustomerAnalysisChart en CustomerAnalysis.tsx
- [ ] Implementar lógica de alertas en Dashboard
- [ ] Cargar datos comparativos (año anterior) en Dashboard
- [ ] Probar exportaciones CSV
- [ ] Probar gráficos interactivos
- [ ] Probar alertas con diferentes umbrales

---

## 📝 Notas Técnicas

1. **Exportaciones**: Generadas completamente en frontend. Para PDF, agregar llamada a backend endpoint.

2. **Recharts**: 
   - LineChart para comparativas de tendencia
   - BarChart para distribuciónde clientes
   - Tooltips personalizados con formatCurrency

3. **Comparativas**: Cargar dos períodos en paralelo para máximo rendimiento

4. **Alertas**: Basadas en umbrales configurables (puedes ajustar los números)

---

**Fase 4 lista para integración. ~730 líneas de código nuevo.**
