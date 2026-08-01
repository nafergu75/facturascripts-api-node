import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getResultReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyBarChart, monthLabel } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportResultToCsv, exportResultToExcel, exportResultToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function ResultReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getResultReport);

  const hasData = (data?.byMonth.length ?? 0) > 0;

  const chartData = useMemo(
    () => (data?.byMonth ?? []).map(m => ({
      label: monthLabel(m.year, m.month),
      Ingresos: m.income,
      Gastos: m.expenses,
    })),
    [data],
  );

  return (
    <ReportLayout
      id="result-report"
      title="Informe de resultado"
      description="Ingresos contabilizados menos gastos contabilizados"
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
          onCsv={() => data && exportResultToCsv(data)}
          onExcel={() => data && exportResultToExcel(data)}
          onPdf={() => data && exportResultToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="Total ingresos"
          value={data!.summary.totalIncome}
          colorScheme="blue"
        />
        <SummaryCard
          label="Total gastos"
          value={data!.summary.totalExpenses}
          colorScheme="red"
        />
        <SummaryCard
          label="Resultado del periodo"
          value={data!.summary.result}
          isPositiveGood={true}
          hint="Ingresos − gastos. Verde = beneficio; rojo = pérdida"
        />
      </HStack>

      <MonthlyBarChart
        title="Ingresos y gastos por mes"
        data={chartData}
        bars={[
          { dataKey: 'Ingresos', name: 'Ingresos', color: '#3182ce' },
          { dataKey: 'Gastos',   name: 'Gastos',   color: '#e53e3e' },
        ]}
      />

      <Box overflowX="auto">
        <Table size="sm" variant="simple" aria-label="Resultado por mes">
          <Thead>
            <Tr>
              <Th scope="col">Mes</Th>
              <Th scope="col" isNumeric>Ingresos</Th>
              <Th scope="col" isNumeric>Gastos</Th>
              <Th scope="col" isNumeric>Resultado</Th>
            </Tr>
          </Thead>
          <Tbody>
            {data!.byMonth.map(m => (
              <Tr key={`${m.year}-${m.month}`}>
                <Td>{monthLabel(m.year, m.month)}</Td>
                <Td isNumeric color="blue.600">{formatCurrency(m.income)}</Td>
                <Td isNumeric color="red.600">{formatCurrency(m.expenses)}</Td>
                <Td isNumeric color={m.result >= 0 ? 'green.600' : 'red.600'} fontWeight="semibold">
                  {m.result >= 0 ? '+' : ''}{formatCurrency(m.result)}
                </Td>
              </Tr>
            ))}
            <Tr fontWeight="bold" bg="gray.50">
              <Td>Total periodo</Td>
              <Td isNumeric>{formatCurrency(data!.summary.totalIncome)}</Td>
              <Td isNumeric>{formatCurrency(data!.summary.totalExpenses)}</Td>
              <Td isNumeric color={data!.summary.result >= 0 ? 'green.700' : 'red.700'}>
                {data!.summary.result >= 0 ? '+' : ''}{formatCurrency(data!.summary.result)}
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </Box>
    </ReportLayout>
  );
}
