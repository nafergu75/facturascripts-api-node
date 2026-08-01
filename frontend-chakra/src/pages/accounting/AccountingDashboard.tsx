/**
 * Página: Dashboard Contable Principal
 * Ruta: /companies/:companyId/accounting/dashboard
 *
 * Vista general con KPIs, gráficos y accesos rápidos
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Heading,
  VStack,
  HStack,
  Container,
  Grid,
  GridItem,
  useToast,
  Spinner,
  Alert,
  AlertIcon,
  Text,
  Stat,
  StatLabel,
  StatNumber,
  StatHelpText,
  Icon,
  Select,
  FormControl,
  FormLabel
} from '@chakra-ui/react';
import { ArrowUpIcon, ArrowDownIcon, DownloadIcon } from '@chakra-ui/icons';
import { useCompanyId } from '../../hooks/useCompanyId';
import {
  getProfitAndLoss,
  getMonthlyEvolution,
  getCustomerAnalysis
} from '../../api/reportsApi';
import { getVatSummary } from '../../api/taxApi';
import { getJournalEntries } from '../../api/accountingApi';
import {
  ProfitAndLossResponse,
  MonthlyEvolutionResponse,
  MonthlyEvolutionItem,
  CustomerAnalysisResponse,
  VatSummaryResponse,
  JournalEntry
} from '../../api/types';
import { MonthlyEvolutionChart } from '../../components/reports/MonthlyEvolutionChart';
import { formatCurrency } from '../../utils/formatters';
import { exportMonthlyEvolutionToCsv } from '../../utils/exporters';

export function AccountingDashboardPage() {
  const companyId = useCompanyId();
  const navigate = useNavigate();
  const toast = useToast();

  // Estado
  const [pygData, setPygData] = useState<ProfitAndLossResponse | null>(null);
  const [monthlyData, setMonthlyData] = useState<MonthlyEvolutionResponse | null>(null);
  const [customerData, setCustomerData] = useState<CustomerAnalysisResponse | null>(null);
  const [vatData, setVatData] = useState<VatSummaryResponse | null>(null);
  const [pendingEntries, setPendingEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState('Q2');

  // Cargar datos al montar o cambiar año
  useEffect(() => {
    loadDashboardData();
  }, [companyId, year]);

  /**
   * Cargar todos los datos del dashboard
   */
  async function loadDashboardData() {
    setLoading(true);
    setError(null);

    try {
      const fromDate = `${year}-01-01`;
      const toDate = new Date().toISOString().split('T')[0];

      const [pyg, monthly, customer, vat, pending] = await Promise.all([
        getProfitAndLoss(companyId, { from: fromDate, to: toDate }),
        getMonthlyEvolution(companyId, year),
        getCustomerAnalysis(companyId, fromDate, toDate),
        getVatSummary(companyId, `${quarter}-${year}`),
        getJournalEntries(companyId, { estado: 'PENDING_REVIEW', take: 5 })
      ]);

      setPygData(pyg);
      setMonthlyData(monthly);
      setCustomerData(customer);
      setVatData(vat);
      setPendingEntries(pending);
    } catch (err) {
      const errorMsg = handleAPIError(err);
      setError(errorMsg);
      toast({
        title: 'Error',
        description: errorMsg,
        status: 'error',
        duration: 5000,
        isClosable: true
      });
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Container maxW="6xl" py={6} textAlign="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  if (error) {
    return (
      <Container maxW="6xl" py={6}>
        <Alert status="error">
          <AlertIcon />
          {error}
        </Alert>
      </Container>
    );
  }

  const isPositive = (pygData?.resultadoExplotacion ?? 0) >= 0;
  const vatIsDebt = (vatData?.cuotaAIngresar ?? 0) < 0;

  const ingresosTotales = pygData?.ingresos ?? 0;
  const margen =
    ingresosTotales !== 0
      ? ((pygData?.resultadoExplotacion ?? 0) / ingresosTotales) * 100
      : 0;

  const monthlyItems: MonthlyEvolutionItem[] = monthlyData
    ? Object.keys(monthlyData.meses)
        .sort()
        .map((mesKey) => ({
          mes: `${monthlyData.year}-${mesKey}`,
          ...monthlyData.meses[mesKey]
        }))
    : [];

  const totalIngresosAno = monthlyItems.reduce((sum, m) => sum + m.ingresos, 0);
  const totalGastosAno = monthlyItems.reduce((sum, m) => sum + m.gastos, 0);

  const topClientes = [...(customerData?.clientes ?? [])]
    .sort((a, b) => b.totalFacturado - a.totalFacturado)
    .slice(0, 5);

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Dashboard Contable</Heading>
          <Button colorScheme="blue" onClick={loadDashboardData}>
            Refrescar
          </Button>
        </HStack>

        {/* Filtro de año */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <HStack spacing={4}>
            <FormControl w="120px">
              <FormLabel fontSize="sm">Año</FormLabel>
              <Select
                value={year}
                onChange={(e) => setYear(parseInt(e.target.value))}
              >
                {[2024, 2025, 2026, 2027].map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </Select>
            </FormControl>
            <FormControl w="140px">
              <FormLabel fontSize="sm">Trimestre IVA</FormLabel>
              <Select
                value={quarter}
                onChange={(e) => setQuarter(e.target.value)}
              >
                <option value="Q1">Q1 (Ene-Mar)</option>
                <option value="Q2">Q2 (Abr-Jun)</option>
                <option value="Q3">Q3 (Jul-Sep)</option>
                <option value="Q4">Q4 (Oct-Dic)</option>
              </Select>
            </FormControl>
          </HStack>
        </Box>

        {/* KPIs Principales */}
        <Grid templateColumns="repeat(4, 1fr)" gap={4}>
          {/* Ingresos */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Stat>
              <StatLabel fontSize="sm" color="gray.600">
                Ingresos {year}
              </StatLabel>
              <StatNumber color="green.600" fontSize="2xl">
                {formatCurrency(pygData?.ingresos ?? 0)}
              </StatNumber>
              <StatHelpText fontSize="xs">
                {((pygData?.ingresos ?? 0) / (totalIngresosAno || 1) * 100).toFixed(0)}% del total anual
              </StatHelpText>
            </Stat>
          </GridItem>

          {/* Gastos */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Stat>
              <StatLabel fontSize="sm" color="gray.600">
                Gastos {year}
              </StatLabel>
              <StatNumber color="red.600" fontSize="2xl">
                {formatCurrency(pygData?.gastos ?? 0)}
              </StatNumber>
              <StatHelpText fontSize="xs">
                {((pygData?.gastos ?? 0) / (totalGastosAno || 1) * 100).toFixed(0)}% del total anual
              </StatHelpText>
            </Stat>
          </GridItem>

          {/* Resultado de explotación */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Stat>
              <StatLabel fontSize="sm" color="gray.600">
                Resultado Explotación {year}
              </StatLabel>
              <StatNumber
                color={isPositive ? 'green.600' : 'red.600'}
                fontSize="2xl"
              >
                {formatCurrency(pygData?.resultadoExplotacion ?? 0)}
              </StatNumber>
              <StatHelpText>
                <HStack spacing={1}>
                  <Icon as={isPositive ? ArrowUpIcon : ArrowDownIcon} />
                  <Text fontSize="xs">
                    {margen.toFixed(1)}% margen
                  </Text>
                </HStack>
              </StatHelpText>
            </Stat>
          </GridItem>

          {/* IVA */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Stat>
              <StatLabel fontSize="sm" color="gray.600">
                IVA {quarter} {year}
              </StatLabel>
              <StatNumber
                color={vatIsDebt ? 'green.600' : 'red.600'}
                fontSize="2xl"
              >
                {formatCurrency(Math.abs(vatData?.cuotaAIngresar ?? 0))}
              </StatNumber>
              <StatHelpText fontSize="xs">
                {vatIsDebt ? '💰 A devolver' : '📊 A ingresar'}
              </StatHelpText>
            </Stat>
          </GridItem>
        </Grid>

        {/* Gráfico de evolución mensual */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <HStack justify="space-between" mb={4}>
            <Heading size="sm">Evolución de Ingresos vs Gastos</Heading>
            <Button
              size="sm"
              leftIcon={<DownloadIcon />}
              variant="outline"
              isDisabled={loading || !monthlyData}
              onClick={() => monthlyData && exportMonthlyEvolutionToCsv(monthlyData)}
            >
              Exportar CSV
            </Button>
          </HStack>
          <MonthlyEvolutionChart
            data={monthlyItems}
            loading={false}
          />
        </Box>

        {/* Dos columnas: Top clientes + Asientos pendientes */}
        <Grid templateColumns="repeat(2, 1fr)" gap={4}>
          {/* Top Clientes */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Heading size="sm" mb={4}>
              Top 5 Clientes
            </Heading>

            {topClientes.length > 0 ? (
              <VStack align="stretch" spacing={2}>
                {topClientes.map((item, idx) => (
                  <HStack key={item.id} justify="space-between" p={2} bg="gray.50" borderRadius="md">
                    <Text fontSize="sm" fontWeight="bold">
                      {idx + 1}. {item.nombre}
                    </Text>
                    <Text fontSize="sm" fontWeight="bold" color="green.600">
                      {formatCurrency(item.totalFacturado)}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            ) : (
              <Text color="gray.500" fontSize="sm">
                Sin datos
              </Text>
            )}

            <Button
              size="sm"
              variant="outline"
              mt={3}
              w="100%"
              onClick={() => navigate(`/reports/analytics/customers`)}
            >
              Ver Análisis Completo
            </Button>
          </GridItem>

          {/* Asientos Pendientes */}
          <GridItem bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Heading size="sm" mb={4}>
              ⏳ Asientos Pendientes
            </Heading>

            {pendingEntries.length > 0 ? (
              <VStack align="stretch" spacing={2}>
                {pendingEntries.map((entry) => (
                  <HStack
                    key={entry.id}
                    justify="space-between"
                    p={2}
                    bg="yellow.50"
                    borderRadius="md"
                    cursor="pointer"
                    onClick={() =>
                      navigate(
                        `/accounting/journal-entries/${entry.id}`
                      )
                    }
                    _hover={{ bg: 'yellow.100' }}
                  >
                    <Text fontSize="sm" fontWeight="bold">
                      {entry.numeroAsiento}
                    </Text>
                    <Text fontSize="xs" color="gray.600">
                      {formatCurrency(entry.totalDebe)}
                    </Text>
                  </HStack>
                ))}
              </VStack>
            ) : (
              <Text color="gray.500" fontSize="sm">
                ✅ Sin asientos pendientes
              </Text>
            )}

            <Button
              size="sm"
              variant="outline"
              mt={3}
              w="100%"
              onClick={() => navigate(`/accounting/journal-entries`)}
            >
              Ver Todos
            </Button>
          </GridItem>
        </Grid>

        {/* Accesos Rápidos */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Accesos Rápidos
          </Heading>

          <Grid templateColumns="repeat(3, 1fr)" gap={3}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/reports/balance`)}
            >
              Balance General
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/reports/profit-and-loss`)}
            >
              P&L
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/reports/ledger`)}
            >
              Mayor
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/tax/vat-books`)}
            >
              Libros IVA
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate(`/tax/summary`)}
            >
              Resumen 303
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigate(`/accounting/journal-entries`)
              }
            >
              Asientos
            </Button>
          </Grid>
        </Box>
      </VStack>
    </Container>
  );
}

function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos.';
  }
  return error.message || 'Error desconocido.';
}
