import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getIncomeReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyBarChart, monthLabel } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportIncomeToCsv, exportIncomeToExcel, exportIncomeToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function IncomeReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getIncomeReport);

  const hasData = (data?.byMonth.length ?? 0) > 0;

  const chartData = useMemo(
    () => (data?.byMonth ?? []).map(m => ({ label: monthLabel(m.year, m.month), Ingresos: m.amount })),
    [data],
  );

  return (
    <ReportLayout
      id="income-report"
      title="Informe de ingresos"
      description="Base imponible de facturas emitidas contabilizadas"
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
          onCsv={() => data && exportIncomeToCsv(data)}
          onExcel={() => data && exportIncomeToExcel(data)}
          onPdf={() => data && exportIncomeToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="Total ingresos (base imponible)"
          value={data!.summary.totalIncome}
          colorScheme="blue"
          hint="Suma de bases imponibles de facturas emitidas contabilizadas en el periodo"
        />
      </HStack>

      <MonthlyBarChart
        title="Evolución de ingresos por mes"
        data={chartData}
        bars={[{ dataKey: 'Ingresos', name: 'Base imponible', color: '#3182ce' }]}
      />

      <Box overflowX="auto">
        <Table size="sm" variant="simple" aria-label="Ingresos por mes">
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
            <Tr fontWeight="bold" bg="blue.50">
              <Td>Total periodo</Td>
              <Td isNumeric>{formatCurrency(data!.summary.totalIncome)}</Td>
            </Tr>
          </Tbody>
        </Table>
      </Box>
    </ReportLayout>
  );
}
