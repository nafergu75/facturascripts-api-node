import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getExpensesReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyBarChart, monthLabel } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportExpensesToCsv, exportExpensesToExcel, exportExpensesToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function ExpensesReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getExpensesReport);

  const hasData = (data?.byMonth.length ?? 0) > 0;

  const chartData = useMemo(
    () => (data?.byMonth ?? []).map(m => ({ label: monthLabel(m.year, m.month), Gastos: m.amount })),
    [data],
  );

  return (
    <ReportLayout
      id="expenses-report"
      title="Informe de gastos"
      description="Base imponible de facturas recibidas contabilizadas"
      loading={loading}
      error={error}
      hasData={hasData}
      onRetry={retry}
      filterBar={
        <PeriodFilters
          filters={filters}
          appliedFilters={appliedFilters}
          onChange={setFilters}
          onApply={apply}
          isLoading={loading}
        />
      }
      exportButton={
        <ExportButtons
          isDisabled={!data || loading}
          onCsv={() => data && exportExpensesToCsv(data)}
          onExcel={() => data && exportExpensesToExcel(data)}
          onPdf={() => data && exportExpensesToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="Total gastos (base imponible)"
          value={data!.summary.totalExpenses}
          colorScheme="red"
          hint="Suma de bases imponibles de facturas recibidas contabilizadas en el periodo"
        />
      </HStack>

      <MonthlyBarChart
        title="Evolución de gastos por mes"
        data={chartData}
        bars={[{ dataKey: 'Gastos', name: 'Base imponible', color: '#e53e3e' }]}
      />

      <Box overflowX="auto">
        <Table size="sm" variant="simple" aria-label="Gastos por mes">
          <Thead>
            <Tr>
              <Th scope="col">Mes</Th>
              <Th scope="col" isNumeric>Base imponible</Th>
            </Tr>
          </Thead>
          <Tbody>
            {data!.byMonth.map(m => (
              <Tr key={`${m.year}-${m.month}`}>
                <Td>{monthLabel(m.year, m.month)}</Td>
                <Td isNumeric>{formatCurrency(m.amount)}</Td>
              </Tr>
            ))}
            <Tr fontWeight="bold" bg="red.50">
              <Td>Total periodo</Td>
              <Td isNumeric>{formatCurrency(data!.summary.totalExpenses)}</Td>
            </Tr>
          </Tbody>
        </Table>
      </Box>
    </ReportLayout>
  );
}
