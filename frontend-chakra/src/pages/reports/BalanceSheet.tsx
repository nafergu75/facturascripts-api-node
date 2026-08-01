/**
 * Página: Balance General
 * Ruta: /companies/:companyId/reports/balance
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
import { getBalanceSheet } from '../../api/reportsApi';
import { BalanceSheetResponse, ReportDateRange, APIErrorResponse } from '../../api/types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { exportBalanceToCsv } from '../../utils/exporters';

export function BalanceSheetPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [balance, setBalance] = useState<BalanceSheetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [dateRange, setDateRange] = useState<ReportDateRange>({
    from: getDefaultFromDate(),
    to: getDefaultToDate()
  });

  // Cargar balance al montar o cambiar filtros
  useEffect(() => {
    loadBalance();
  }, [companyId, dateRange]);

  /**
   * Cargar balance
   */
  async function loadBalance() {
    setLoading(true);
    setError(null);

    try {
      const result = await getBalanceSheet(companyId, dateRange);
      setBalance(result);
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

  if (error || !balance) {
    return (
      <Container maxW="6xl" py={6}>
        <Alert status="error">
          <AlertIcon />
          {error || 'No se pudo cargar el balance'}
        </Alert>
      </Container>
    );
  }

  const totalActivo = balance.activo.noCirculante + balance.activo.circulante;
  const totalPasivo = balance.pasivo.noCirculante + balance.pasivo.circulante;
  const totalPatrimonio = balance.patrimonioNeto;
  const cuadra = Math.abs(totalActivo - (totalPasivo + totalPatrimonio)) < 0.01;

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Balance General</Heading>
          <HStack>
            <Button
              leftIcon={<DownloadIcon />}
              variant="outline"
              isDisabled={loading || !balance}
              onClick={() => exportBalanceToCsv(balance)}
            >
              Exportar CSV
            </Button>
            <Button colorScheme="blue" onClick={loadBalance}>
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
              onClick={loadBalance}
            >
              Buscar
            </Button>
          </HStack>
        </Box>

        {/* Validación de cuadre */}
        {cuadra ? (
          <Alert status="success" borderRadius="md">
            <AlertIcon />
            ✅ Balance cuadra correctamente (Activo = Pasivo + Patrimonio)
          </Alert>
        ) : (
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            ❌ Balance NO CUADRA. Verifica los asientos contables.
          </Alert>
        )}

        {/* ACTIVO */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4} color="blue.600">
            ACTIVO
          </Heading>

          <BalanceRow label="No Circulante" value={balance.activo.noCirculante} />
          <BalanceRow label="Circulante" value={balance.activo.circulante} />

          <Divider my={3} />

          <HStack justify="space-between" p={2} bg="blue.50" borderRadius="md">
            <Text fontWeight="bold">TOTAL ACTIVO</Text>
            <Text fontWeight="bold" fontSize="lg">
              {formatCurrency(totalActivo)}
            </Text>
          </HStack>
        </Box>

        {/* PASIVO */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4} color="orange.600">
            PASIVO
          </Heading>

          <BalanceRow label="No Circulante" value={balance.pasivo.noCirculante} />
          <BalanceRow label="Circulante" value={balance.pasivo.circulante} />

          <Divider my={3} />

          <HStack justify="space-between" p={2} bg="orange.50" borderRadius="md">
            <Text fontWeight="bold">TOTAL PASIVO</Text>
            <Text fontWeight="bold" fontSize="lg">
              {formatCurrency(totalPasivo)}
            </Text>
          </HStack>
        </Box>

        {/* PATRIMONIO NETO */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4} color="green.600">
            PATRIMONIO NETO
          </Heading>

          <HStack justify="space-between" p={2} bg="green.50" borderRadius="md">
            <Text fontWeight="bold">TOTAL PATRIMONIO</Text>
            <Text fontWeight="bold" fontSize="lg">
              {formatCurrency(totalPatrimonio)}
            </Text>
          </HStack>
        </Box>

        {/* Resumen */}
        <Box bg="gray.50" p={4} borderRadius="md">
          <Text fontSize="sm" color="gray.600" mb={2}>
            Resumen del período: {dateRange.from} al {dateRange.to}
          </Text>
          <Grid3Col
            label="Total Activo"
            value={formatCurrency(totalActivo)}
            color="blue.600"
          />
          <Grid3Col
            label="Total Pasivo"
            value={formatCurrency(totalPasivo)}
            color="orange.600"
          />
          <Grid3Col
            label="Total Patrimonio"
            value={formatCurrency(totalPatrimonio)}
            color="green.600"
          />
        </Box>
      </VStack>
    </Container>
  );
}

/**
 * Componente auxiliar: Fila de importe del balance
 */
interface BalanceRowProps {
  label: string;
  value: number;
}

function BalanceRow({ label, value }: BalanceRowProps) {
  return (
    <HStack
      justify="space-between"
      mb={3}
      p={2}
      border="1px"
      borderColor="gray.200"
      borderRadius="md"
    >
      <Text fontWeight="bold" fontSize="sm">
        {label}
      </Text>
      <Text fontWeight="bold">{formatCurrency(value)}</Text>
    </HStack>
  );
}

/**
 * Componente auxiliar: Grid de 3 columnas
 */
function Grid3Col({ label, value, color }: any) {
  return (
    <HStack justify="space-between" py={2}>
      <Text fontSize="sm">{label}</Text>
      <Text fontWeight="bold" color={color}>
        {value}
      </Text>
    </HStack>
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
