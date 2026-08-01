/**
 * Página: Análisis por Cliente
 * Ruta: /companies/:companyId/reports/analytics/customers
 *
 * Muestra tabla de clientes con ingresos totales y gráfico de distribución
 */

import React, { useState, useEffect } from 'react';
import {
  Box,
  Button,
  Heading,
  VStack,
  HStack,
  Container,
  useToast,
  Spinner,
  Alert,
  AlertIcon,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Input,
  FormControl,
  FormLabel,
  Text,
  Badge,
  Progress
} from '@chakra-ui/react';
import { DownloadIcon } from '@chakra-ui/icons';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getCustomerAnalysis } from '../../api/reportsApi';
import { CustomerAnalysisResponse } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';
import { exportCustomerAnalysisToCsv } from '../../utils/exporters';

export function CustomerAnalysisPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [analysis, setAnalysis] = useState<CustomerAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [from, setFrom] = useState(getDefaultFromDate());
  const [to, setTo] = useState(getDefaultToDate());

  // Cargar análisis al montar o cambiar filtros
  useEffect(() => {
    loadAnalysis();
  }, [companyId, from, to]);

  /**
   * Cargar análisis por cliente
   */
  async function loadAnalysis() {
    setLoading(true);
    setError(null);

    try {
      const result = await getCustomerAnalysis(companyId, from, to);
      setAnalysis(result);
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

  if (loading && !analysis) {
    return (
      <Container maxW="6xl" py={6} textAlign="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  const clientes = analysis?.clientes ?? [];
  const totalGeneral = clientes.reduce((sum, c) => sum + c.totalFacturado, 0);
  const clientesOrdenados = [...clientes].sort((a, b) => b.totalFacturado - a.totalFacturado);

  function porcentaje(importe: number): number {
    return totalGeneral > 0 ? (importe / totalGeneral) * 100 : 0;
  }

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Análisis por Cliente</Heading>
          <HStack>
            <Button
              leftIcon={<DownloadIcon />}
              variant="outline"
              isDisabled={loading || !analysis}
              onClick={() => analysis && exportCustomerAnalysisToCsv(analysis)}
            >
              Exportar CSV
            </Button>
            <Button colorScheme="blue" onClick={loadAnalysis} isLoading={loading}>
              Actualizar
            </Button>
          </HStack>
        </HStack>

        {/* Filtros */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Período
          </Heading>

          <HStack spacing={4}>
            <FormControl w="150px">
              <FormLabel fontSize="sm">Desde</FormLabel>
              <Input
                size="sm"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </FormControl>

            <FormControl w="150px">
              <FormLabel fontSize="sm">Hasta</FormLabel>
              <Input
                size="sm"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </FormControl>

            <Button
              size="sm"
              colorScheme="blue"
              alignSelf="flex-end"
              onClick={loadAnalysis}
            >
              Buscar
            </Button>
          </HStack>
        </Box>

        {/* Error */}
        {error && (
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            {error}
          </Alert>
        )}

        {/* Resumen general */}
        {analysis && (
          <>
            <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
              <Heading size="sm" mb={3}>
                Total Facturado
              </Heading>
              <Text fontSize="2xl" fontWeight="bold" color="green.600">
                {formatCurrency(totalGeneral)}
              </Text>
              <Text fontSize="sm" color="gray.600" mt={1}>
                De {clientes.length} clientes
              </Text>
            </Box>

            {/* Tabla de clientes */}
            <Box bg="white" p={4} borderRadius="md" boxShadow="sm" overflowX="auto">
              {clientesOrdenados.length === 0 ? (
                <Text textAlign="center" color="gray.500">
                  No hay datos para este período
                </Text>
              ) : (
                <Table size="sm" variant="striped" colorScheme="gray">
                  <Thead>
                    <Tr>
                      <Th>Cliente</Th>
                      <Th isNumeric>Total Facturado</Th>
                      <Th isNumeric>Saldo Pendiente</Th>
                      <Th isNumeric>% del Total</Th>
                      <Th>Distribución</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {clientesOrdenados.map((item) => (
                      <Tr key={item.id}>
                        <Td fontWeight="bold" fontSize="sm">
                          {item.nombre}
                        </Td>
                        <Td isNumeric fontWeight="bold">
                          {formatCurrency(item.totalFacturado)}
                        </Td>
                        <Td isNumeric>
                          <Badge colorScheme={item.saldoPendiente > 0 ? 'orange' : 'gray'}>
                            {formatCurrency(item.saldoPendiente)}
                          </Badge>
                        </Td>
                        <Td isNumeric>
                          <Text fontSize="sm" fontWeight="bold">
                            {porcentaje(item.totalFacturado).toFixed(1)}%
                          </Text>
                        </Td>
                        <Td>
                          <Progress
                            value={porcentaje(item.totalFacturado)}
                            size="sm"
                            borderRadius="md"
                            colorScheme="green"
                          />
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </Box>

            {/* Gráfico simple (top 5) */}
            <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
              <Heading size="sm" mb={4}>
                Top 5 Clientes por Facturación
              </Heading>

              <VStack align="stretch" spacing={3}>
                {clientesOrdenados.slice(0, 5).map((item, index) => (
                  <Box key={item.id} p={2} border="1px" borderColor="gray.200" borderRadius="md">
                    <HStack justify="space-between" mb={1}>
                      <Text fontSize="sm" fontWeight="bold">
                        {index + 1}. {item.nombre}
                      </Text>
                      <Text fontSize="sm" fontWeight="bold">
                        {formatCurrency(item.totalFacturado)}
                      </Text>
                    </HStack>
                    <Progress
                      value={porcentaje(item.totalFacturado)}
                      size="sm"
                      borderRadius="md"
                      colorScheme="green"
                    />
                  </Box>
                ))}
              </VStack>

              {clientesOrdenados.length > 5 && (
                <Text fontSize="xs" color="gray.500" mt={3}>
                  Mostrando top 5 de {clientesOrdenados.length} clientes
                </Text>
              )}
            </Box>
          </>
        )}
      </VStack>
    </Container>
  );
}

function getDefaultFromDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-01-01`;
}

function getDefaultToDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos para ver análisis.';
  }
  if (error.statusCode === 404) {
    return 'No hay datos para este período.';
  }
  return error.message || 'Error desconocido.';
}
