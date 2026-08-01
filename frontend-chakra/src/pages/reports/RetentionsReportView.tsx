import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td, Heading, Badge, Divider } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getRetentionReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyBarChart, monthLabel } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportRetentionsToCsv, exportRetentionsToExcel, exportRetentionsToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function RetentionsReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getRetentionReport);

  const hasData = (data?.byMonth.length ?? 0) > 0 || (data?.byProvider.length ?? 0) > 0;

  const chartData = useMemo(
    () => (data?.byMonth ?? []).map(m => ({
      label: monthLabel(m.year, m.month),
      Retenciones: m.amount,
    })),
    [data],
  );

  return (
    <ReportLayout
      id="retentions-report"
      title="Informe de retenciones IRPF"
      description="Retenciones practicadas a proveedores — base para el Modelo 190"
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
          onCsv={() => data && exportRetentionsToCsv(data)}
          onExcel={() => data && exportRetentionsToExcel(data)}
          onPdf={() => data && exportRetentionsToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="Total retenciones practicadas"
          value={data!.summary.totalRetentions}
          colorScheme="purple"
          hint="Importe retenido a proveedores e ingresado (o a ingresar) a AEAT"
        />
      </HStack>

      <MonthlyBarChart
        title="Retenciones por mes"
        data={chartData}
        bars={[{ dataKey: 'Retenciones', name: 'Retenciones', color: '#805ad5' }]}
      />

      {/* Sub-sección: por mes */}
      <Box>
        <Heading as="h3" size="sm" mb={3}>Detalle por mes</Heading>
        <Box overflowX="auto">
          <Table size="sm" variant="simple" aria-label="Retenciones por mes">
            <Thead>
              <Tr>
                <Th scope="col">Mes</Th>
                <Th scope="col" isNumeric>Retenciones</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data!.byMonth.map(m => (
                <Tr key={`${m.year}-${m.month}`}>
                  <Td>{monthLabel(m.year, m.month)}</Td>
                  <Td isNumeric>{formatCurrency(m.amount)}</Td>
                </Tr>
              ))}
              <Tr fontWeight="bold" bg="purple.50">
                <Td>Total periodo</Td>
                <Td isNumeric>{formatCurrency(data!.summary.totalRetentions)}</Td>
              </Tr>
            </Tbody>
          </Table>
        </Box>
      </Box>

      <Divider />

      {/* Sub-sección: por proveedor (Modelo 190) */}
      <Box>
        <Heading as="h3" size="sm" mb={1}>Por perceptor (Modelo 190)</Heading>
        <Box fontSize="xs" color="gray.500" mb={3}>
          Ordenado por importe retenido descendente
        </Box>
        <Box overflowX="auto">
          <Table size="sm" variant="simple" aria-label="Retenciones por perceptor — datos para Modelo 190">
            <Thead>
              <Tr>
                <Th scope="col">NIF</Th>
                <Th scope="col">Nombre / razón social</Th>
                <Th scope="col">Tipo de renta</Th>
                <Th scope="col" isNumeric>Base</Th>
                <Th scope="col" isNumeric>Retención</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data!.byProvider.map(p => (
                <Tr key={p.nif}>
                  <Td fontFamily="mono" fontSize="xs">{p.nif}</Td>
                  <Td>{p.nombre}</Td>
                  <Td>
                    <Badge colorScheme="purple" fontSize="xs">{p.tipo}</Badge>
                  </Td>
                  <Td isNumeric>{formatCurrency(p.base)}</Td>
                  <Td isNumeric fontWeight="semibold">{formatCurrency(p.retencion)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      </Box>
    </ReportLayout>
  );
}
