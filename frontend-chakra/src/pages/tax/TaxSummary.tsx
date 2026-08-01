/**
 * Página: Resumen de IVA (Modelo 303 Simplificado)
 * Ruta: /companies/:companyId/tax/summary
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
  Select,
  FormControl,
  FormLabel,
  Text,
  Divider,
  Grid,
  GridItem
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getVatSummary, getRetentionSummary } from '../../api/taxApi';
import { VatSummaryResponse, RetentionSummaryResponse, APIErrorResponse } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';

type TaxPeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export function TaxSummaryPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [vatSummary, setVatSummary] = useState<VatSummaryResponse | null>(null);
  const [retentionSummary, setRetentionSummary] = useState<RetentionSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState<TaxPeriod>('Q1');

  // Cargar resumen al montar o cambiar filtros
  useEffect(() => {
    loadSummary();
  }, [companyId, year, quarter]);

  /**
   * Cargar resumen de IVA y retenciones
   */
  async function loadSummary() {
    setLoading(true);
    setError(null);

    try {
      const period = `${quarter}-${year}`;

      const [vat, retention] = await Promise.all([
        getVatSummary(companyId, period),
        getRetentionSummary(companyId, year)
      ]);

      setVatSummary(vat);
      setRetentionSummary(retention);
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

  if (loading && !vatSummary) {
    return (
      <Container maxW="6xl" py={6} textAlign="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  if (error || !vatSummary) {
    return (
      <Container maxW="6xl" py={6}>
        <Alert status="error">
          <AlertIcon />
          {error || 'No se pudo cargar el resumen de IVA'}
        </Alert>
      </Container>
    );
  }

  const deuda = vatSummary.cuotaAIngresar;
  const esDeuda = deuda < 0; // Negativo = devolver
  const esAIngresar = deuda > 0; // Positivo = ingresar

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Resumen IVA (Modelo 303)</Heading>
          <Button colorScheme="blue" onClick={loadSummary}>
            Actualizar
          </Button>
        </HStack>

        {/* Filtros */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Período
          </Heading>

          <HStack spacing={4}>
            {/* Año */}
            <FormControl w="120px">
              <FormLabel fontSize="sm">Año</FormLabel>
              <Select
                size="sm"
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

            {/* Trimestre */}
            <FormControl w="140px">
              <FormLabel fontSize="sm">Trimestre</FormLabel>
              <Select
                size="sm"
                value={quarter}
                onChange={(e) => setQuarter(e.target.value as TaxPeriod)}
              >
                <option value="Q1">Q1 (Ene-Mar)</option>
                <option value="Q2">Q2 (Abr-Jun)</option>
                <option value="Q3">Q3 (Jul-Sep)</option>
                <option value="Q4">Q4 (Oct-Dic)</option>
              </Select>
            </FormControl>

            <Button
              size="sm"
              colorScheme="blue"
              alignSelf="flex-end"
              onClick={loadSummary}
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

        {/* RESUMEN IVA */}
        <Box bg="white" p={6} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={6}>
            Resumen IVA - {quarter} {year}
          </Heading>

          {/* Dos columnas: Emitidas vs Recibidas */}
          <Grid templateColumns="repeat(2, 1fr)" gap={6} mb={6}>
            {/* Emitidas */}
            <Box border="1px" borderColor="blue.200" p={4} borderRadius="md">
              <Heading size="xs" mb={4} color="blue.600">
                IVA REPERCUTIDO
                <br />
                (Facturas Emitidas)
              </Heading>

              <VStack spacing={2} align="start">
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Base Imponible</Text>
                  <Text fontWeight="bold">
                    {formatCurrency(vatSummary.emitidas.totalBases)}
                  </Text>
                </HStack>
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Cuota IVA</Text>
                  <Text fontWeight="bold" color="blue.600">
                    {formatCurrency(vatSummary.emitidas.totalCuotas)}
                  </Text>
                </HStack>
              </VStack>
            </Box>

            {/* Recibidas */}
            <Box border="1px" borderColor="orange.200" p={4} borderRadius="md">
              <Heading size="xs" mb={4} color="orange.600">
                IVA SOPORTADO
                <br />
                (Facturas Recibidas)
              </Heading>

              <VStack spacing={2} align="start">
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Base Imponible</Text>
                  <Text fontWeight="bold">
                    {formatCurrency(vatSummary.recibidas.totalBases)}
                  </Text>
                </HStack>
                <HStack justify="space-between" w="100%">
                  <Text fontSize="sm">Cuota IVA (Deducible)</Text>
                  <Text fontWeight="bold" color="orange.600">
                    {formatCurrency(vatSummary.recibidas.totalCuotas)}
                  </Text>
                </HStack>
              </VStack>
            </Box>
          </Grid>

          <Divider my={4} />

          {/* Resultado */}
          <Box
            p={4}
            borderRadius="md"
            bg={esAIngresar ? 'red.50' : esDeuda ? 'green.50' : 'gray.50'}
            border="2px"
            borderColor={esAIngresar ? 'red.200' : esDeuda ? 'green.200' : 'gray.200'}
          >
            <HStack justify="space-between" mb={2}>
              <Text fontWeight="bold" fontSize="lg">
                CUOTA A INGRESAR / DEVOLVER
              </Text>
              <Text
                fontSize="2xl"
                fontWeight="bold"
                color={esAIngresar ? 'red.600' : esDeuda ? 'green.600' : 'gray.600'}
              >
                {esAIngresar ? '+' : ''}
                {formatCurrency(Math.abs(deuda))}
              </Text>
            </HStack>

            <Text fontSize="sm" color="gray.600">
              {esAIngresar
                ? '📊 IVA a INGRESAR a Hacienda'
                : esDeuda
                  ? '📊 IVA a DEVOLVER por Hacienda'
                  : '📊 Sin deuda IVA (saldo nulo)'}
            </Text>
          </Box>
        </Box>

        {/* RETENCIONES (Modelo 190) */}
        {retentionSummary && retentionSummary.retenciones.length > 0 && (
          <Box bg="white" p={6} borderRadius="md" boxShadow="sm">
            <Heading size="sm" mb={4}>
              Retenciones - Modelo 190 ({year})
            </Heading>

            <Table size="sm" variant="striped" colorScheme="gray">
              <Thead>
                <Tr>
                  <Th>Tipo Retención</Th>
                  <Th>NIF Tercero</Th>
                  <Th>Nombre</Th>
                  <Th isNumeric>Base</Th>
                  <Th isNumeric>%</Th>
                  <Th isNumeric>Cuota</Th>
                </Tr>
              </Thead>
              <Tbody>
                {retentionSummary.retenciones.map((ret, i) => (
                  <Tr key={i}>
                    <Td fontSize="sm">{ret.tipo}</Td>
                    <Td fontSize="sm">{ret.nif}</Td>
                    <Td fontSize="sm">{ret.nombre}</Td>
                    <Td isNumeric>{formatCurrency(ret.base)}</Td>
                    <Td isNumeric>{ret.porcentaje}%</Td>
                    <Td isNumeric fontWeight="bold">
                      {formatCurrency(ret.cuota)}
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>

            <Box mt={4} p={3} bg="gray.50" borderRadius="md">
              <HStack justify="space-between">
                <Text fontWeight="bold">Total Retenciones</Text>
                <Text fontWeight="bold">
                  {formatCurrency(retentionSummary.totalRetenciones)}
                </Text>
              </HStack>
            </Box>
          </Box>
        )}

        {/* Info */}
        <Alert status="info" borderRadius="md">
          <AlertIcon />
          <VStack align="start" spacing={1}>
            <Text fontWeight="bold">ℹ️ Información importante:</Text>
            <Text fontSize="sm">
              Este resumen es una simplificación del Modelo 303. Para declaraciones
              oficiales, consulta con tu asesor fiscal.
            </Text>
          </VStack>
        </Alert>
      </VStack>
    </Container>
  );
}

/**
 * Manejar error de API
 */
function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos para ver resumen de IVA.';
  }
  if (error.statusCode === 404) {
    return 'No hay datos para este período.';
  }
  return error.message || 'Error desconocido.';
}
