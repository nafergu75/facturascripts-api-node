/**
 * Página: Pérdidas y Ganancias
 * Ruta: /companies/:companyId/reports/profit-and-loss
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
  Divider
} from '@chakra-ui/react';
import { DownloadIcon } from '@chakra-ui/icons';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getProfitAndLoss } from '../../api/reportsApi';
import { ProfitAndLossResponse, ReportDateRange, APIErrorResponse } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';
import { exportPyGToCsv } from '../../utils/exporters';

export function ProfitAndLossPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [pyg, setPyG] = useState<ProfitAndLossResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [dateRange, setDateRange] = useState<ReportDateRange>({
    from: getDefaultFromDate(),
    to: getDefaultToDate()
  });

  // Cargar PyG al montar o cambiar filtros
  useEffect(() => {
    loadPyG();
  }, [companyId, dateRange]);

  /**
   * Cargar PyG
   */
  async function loadPyG() {
    setLoading(true);
    setError(null);

    try {
      const result = await getProfitAndLoss(companyId, dateRange);
      setPyG(result);
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

  if (error || !pyg) {
    return (
      <Container maxW="6xl" py={6}>
        <Alert status="error">
          <AlertIcon />
          {error || 'No se pudo cargar el reporte de PyG'}
        </Alert>
      </Container>
    );
  }

  const esPositivo = pyg.resultadoExplotacion >= 0;

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Pérdidas y Ganancias</Heading>
          <HStack>
            <Button
              leftIcon={<DownloadIcon />}
              variant="outline"
              isDisabled={loading || !pyg}
              onClick={() => exportPyGToCsv(pyg)}
            >
              Exportar CSV
            </Button>
            <Button colorScheme="blue" onClick={loadPyG}>
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
                value={dateRange.from}
                onChange={(e) =>
                  setDateRange((prev) => ({ ...prev, from: e.target.value }))
                }
              />
            </FormControl>

            <FormControl w="150px">
              <FormLabel fontSize="sm">Hasta</FormLabel>
              <Input
                size="sm"
                type="date"
                value={dateRange.to}
                onChange={(e) =>
                  setDateRange((prev) => ({ ...prev, to: e.target.value }))
                }
              />
            </FormControl>

            <Button
              size="sm"
              colorScheme="blue"
              alignSelf="flex-end"
              onClick={loadPyG}
            >
              Buscar
            </Button>
          </HStack>
        </Box>

        {/* Reporte PyG */}
        <Box bg="white" p={6} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={6} textAlign="center">
            Período: {dateRange.from} al {dateRange.to}
          </Heading>

          <Table size="sm" variant="unstyled">
            <Tbody>
              <Tr bg="blue.50">
                <Td fontWeight="bold" fontSize="md" color="blue.600">
                  Total Ingresos
                </Td>
                <Td isNumeric fontWeight="bold">
                  {formatCurrency(pyg.ingresos)}
                </Td>
              </Tr>

              <Tr height={2} />

              <Tr bg="red.50">
                <Td fontWeight="bold" fontSize="md" color="red.600">
                  Total Gastos
                </Td>
                <Td isNumeric fontWeight="bold">
                  {formatCurrency(pyg.gastos)}
                </Td>
              </Tr>

              <Tr height={3} />

              {/* RESULTADO DE EXPLOTACIÓN */}
              <Tr bg={esPositivo ? 'green.50' : 'red.50'} height="60px">
                <Td fontWeight="bold" fontSize="lg">
                  RESULTADO DE EXPLOTACIÓN
                </Td>
                <Td
                  isNumeric
                  fontWeight="bold"
                  fontSize="lg"
                  color={esPositivo ? 'green.600' : 'red.600'}
                >
                  {formatCurrency(pyg.resultadoExplotacion)}
                </Td>
              </Tr>
            </Tbody>
          </Table>
        </Box>

        {/* Resumen visual */}
        <HStack spacing={4} w="100%">
          <Box flex={1} bg="blue.50" p={4} borderRadius="md">
            <Text fontSize="sm" color="gray.600">
              Total Ingresos
            </Text>
            <Text fontSize="2xl" fontWeight="bold" color="blue.600">
              {formatCurrency(pyg.ingresos)}
            </Text>
          </Box>

          <Box flex={1} bg="red.50" p={4} borderRadius="md">
            <Text fontSize="sm" color="gray.600">
              Total Gastos
            </Text>
            <Text fontSize="2xl" fontWeight="bold" color="red.600">
              {formatCurrency(pyg.gastos)}
            </Text>
          </Box>

          <Box
            flex={1}
            bg={esPositivo ? 'green.50' : 'red.50'}
            p={4}
            borderRadius="md"
          >
            <Text fontSize="sm" color="gray.600">
              Resultado de Explotación
            </Text>
            <Text
              fontSize="2xl"
              fontWeight="bold"
              color={esPositivo ? 'green.600' : 'red.600'}
            >
              {esPositivo ? '+' : ''}{formatCurrency(pyg.resultadoExplotacion)}
            </Text>
          </Box>
        </HStack>

        {/* Margen sobre ingresos */}
        {pyg.ingresos > 0 && (
          <Box bg="gray.50" p={4} borderRadius="md">
            <Text fontSize="sm" color="gray.600" mb={2}>
              Margen sobre Ingresos
            </Text>
            <Text fontSize="lg" fontWeight="bold">
              {(
                ((pyg.resultadoExplotacion / pyg.ingresos) * 100)
              ).toFixed(2)}%
            </Text>
          </Box>
        )}
      </VStack>
    </Container>
  );
}

/**
 * Obtener fecha por defecto (inicio de año)
 */
function getDefaultFromDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-01-01`;
}

/**
 * Obtener fecha por defecto (hoy)
 */
function getDefaultToDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Manejar error de API
 */
function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos para ver reportes.';
  }
  if (error.statusCode === 404) {
    return 'No hay datos para este período.';
  }
  return error.message || 'Error desconocido.';
}
