import React, { useMemo } from 'react';
import { HStack, Box, Table, Thead, Tbody, Tr, Th, Td } from '@chakra-ui/react';
import { useFinancialReport } from '../../hooks/useFinancialReport';
import { getTreasuryReport } from '../../api/reportsApi';
import { ReportLayout } from '../../components/reports/ReportLayout';
import { PeriodFilters } from '../../components/reports/PeriodFilters';
import { SummaryCard } from '../../components/reports/SummaryCard';
import { MonthlyLineChart } from '../../components/reports/MonthlyBarChart';
import { ExportButtons } from '../../components/reports/ExportButtons';
import { exportTreasuryToCsv, exportTreasuryToExcel, exportTreasuryToPdf } from '../../utils/exporters';
import { formatCurrency } from '../../utils/formatters';

export function TreasuryReportView() {
  const { data, loading, error, filters, appliedFilters, setFilters, apply, retry } =
    useFinancialReport(getTreasuryReport);

  const hasData = (data?.movements.length ?? 0) > 0;

  // Un punto por fecha distinta para el gráfico de evolución de saldo
  const chartData = useMemo(() => {
    if (!data?.movements.length) return [];
    const byDate = new Map<string, number>();
    for (const m of data.movements) byDate.set(m.date, m.balance);
    return [...byDate.entries()].map(([label, Saldo]) => ({ label, Saldo }));
  }, [data]);

  return (
    <ReportLayout
      id="treasury-report"
      title="Informe de tesorería"
      description="Movimientos en cuentas 57x (Caja y Bancos) con estado POSTED"
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
          onCsv={() => data && exportTreasuryToCsv(data)}
          onExcel={() => data && exportTreasuryToExcel(data)}
          onPdf={() => data && exportTreasuryToPdf(data)}
        />
      }
    >
      <HStack spacing={4} flexWrap="wrap">
        <SummaryCard
          label="Saldo apertura"
          value={data!.summary.openingBalance}
          colorScheme="gray"
          hint="Saldo acumulado en cuentas de tesorería al inicio del periodo"
        />
        <SummaryCard
          label="Total entradas"
          value={data!.summary.totalIn}
          colorScheme="green"
          hint="Suma de movimientos DEBE en cuentas 57x durante el periodo"
        />
        <SummaryCard
          label="Total salidas"
          value={data!.summary.totalOut}
          colorScheme="red"
          hint="Suma de movimientos HABER en cuentas 57x durante el periodo"
        />
        <SummaryCard
          label="Saldo cierre"
          value={data!.summary.closingBalance}
          isPositiveGood={true}
          hint="Saldo al final del periodo = apertura + entradas − salidas"
        />
      </HStack>

      <MonthlyLineChart
        title="Evolución del saldo de tesorería"
        data={chartData}
        lines={[{ dataKey: 'Saldo', name: 'Saldo acumulado', color: '#2b6cb0' }]}
      />

      <Box overflowX="auto">
        <Table size="sm" variant="simple" aria-label="Movimientos de tesorería del periodo">
          <Thead>
            <Tr>
              <Th scope="col">Fecha</Th>
              <Th scope="col">Descripción</Th>
              <Th scope="col">Referencia</Th>
              <Th scope="col" isNumeric>Importe</Th>
              <Th scope="col" isNumeric>Saldo</Th>
            </Tr>
          </Thead>
          <Tbody>
            {/* Fila de apertura */}
            <Tr bg="gray.50" fontSize="xs">
              <Td colSpan={4} color="gray.500" fontStyle="italic">Saldo de apertura</Td>
              <Td isNumeric fontWeight="semibold">{formatCurrency(data!.summary.openingBalance)}</Td>
            </Tr>

            {data!.movements.map((m, i) => (
              <Tr key={i}>
                <Td fontFamily="mono" fontSize="xs" whiteSpace="nowrap">{m.date}</Td>
                <Td maxW="220px" isTruncated title={m.description}>{m.description}</Td>
                <Td fontSize="xs" color="gray.500">{m.reference}</Td>
                <Td
                  isNumeric
                  color={m.amount >= 0 ? 'green.600' : 'red.600'}
                  fontWeight="semibold"
                >
                  {m.amount >= 0 ? '+' : ''}{formatCurrency(m.amount)}
                </Td>
                <Td isNumeric>{formatCurrency(m.balance)}</Td>
              </Tr>
            ))}

            {/* Fila de cierre */}
            <Tr fontWeight="bold" bg="blue.50">
              <Td colSpan={4}>Saldo de cierre</Td>
              <Td isNumeric color={data!.summary.closingBalance >= 0 ? 'green.700' : 'red.700'}>
                {formatCurrency(data!.summary.closingBalance)}
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </Box>
    </ReportLayout>
  );
}
