import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getVatReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyBarChart, monthLabel } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportVatToCsv, exportVatToExcel, exportVatToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function VatReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getVatReport);

  const hasData = (data?.byMonth.length ?? 0) > 0;

  const chartData = useMemo(
    () => (data?.byMonth ?? []).map(m => ({
      label: monthLabel(m.year, m.month),
      'IVA rep.': m.vatOutput,
      'IVA sop.': m.vatInput,
    })),
    [data],
  );

  return (
    <ReportLayout
      id="vat-report"
      title="Informe de IVA"
      description="IVA repercutido (ventas) vs IVA soportado (compras)"
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
          onCsv={() => data && exportVatToCsv(data)}
          onExcel={() => data && exportVatToExcel(data)}
          onPdf={() => data && exportVatToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="IVA repercutido (ventas)"
          value={data!.summary.vatOutput}
          colorScheme="blue"
          hint="IVA cobrado a clientes en facturas emitidas (cuenta 477)"
        />
        <SummaryCard
          label="IVA soportado (compras)"
          value={data!.summary.vatInput}
          colorScheme="orange"
          hint="IVA pagado a proveedores en facturas recibidas (cuenta 472)"
        />
        <SummaryCard
          label="IVA a pagar / devolver"
          value={data!.summary.vatPayable}
          isPositiveGood={false}
          hint="Repercutido − soportado. Positivo = pagar a AEAT; negativo = AEAT devuelve"
        />
      </HStack>

      <MonthlyBarChart
        title="IVA repercutido vs IVA soportado por mes"
        data={chartData}
        bars={[
          { dataKey: 'IVA rep.', name: 'IVA repercutido', color: '#3182ce' },
          { dataKey: 'IVA sop.', name: 'IVA soportado',   color: '#ed8936' },
        ]}
      />

      <Box overflowX="auto">
        <Table size="sm" variant="simple" aria-label="IVA por mes">
          <Thead>
            <Tr>
              <Th scope="col">Mes</Th>
              <Th scope="col" isNumeric>IVA repercutido</Th>
              <Th scope="col" isNumeric>IVA soportado</Th>
              <Th scope="col" isNumeric>A pagar / devolver</Th>
            </Tr>
          </Thead>
          <Tbody>
            {data!.byMonth.map(m => (
              <Tr key={`${m.year}-${m.month}`}>
                <Td>{monthLabel(m.year, m.month)}</Td>
                <Td isNumeric>{formatCurrency(m.vatOutput)}</Td>
                <Td isNumeric>{formatCurrency(m.vatInput)}</Td>
                <Td isNumeric color={m.vatPayable > 0 ? 'red.600' : 'green.600'} fontWeight="semibold">
                  {m.vatPayable > 0 ? 'Pagar ' : 'Devolver '}
                  {formatCurrency(Math.abs(m.vatPayable))}
                </Td>
              </Tr>
            ))}
            <Tr fontWeight="bold" bg="gray.50">
              <Td>Total periodo</Td>
              <Td isNumeric>{formatCurrency(data!.summary.vatOutput)}</Td>
              <Td isNumeric>{formatCurrency(data!.summary.vatInput)}</Td>
              <Td isNumeric color={data!.summary.vatPayable > 0 ? 'red.700' : 'green.700'}>
                {data!.summary.vatPayable > 0 ? 'Pagar ' : 'Devolver '}
                {formatCurrency(Math.abs(data!.summary.vatPayable))}
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </Box>
    </ReportLayout>
  );
}
