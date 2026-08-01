/**
 * Página: Mayor por Cuenta (Ledger)
 * Ruta: /companies/:companyId/reports/ledger
 *
 * Muestra historial de movimientos de una cuenta con saldos acumulados
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
  Divider,
  Grid,
  GridItem
} from '@chakra-ui/react';
import { DownloadIcon } from '@chakra-ui/icons';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getLedger } from '../../api/reportsApi';
import { LedgerResponse } from '../../api/types';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { exportLedgerToCsv } from '../../utils/exporters';

export function LedgerPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [ledger, setLedger] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [accountCode, setAccountCode] = useState('');
  const [from, setFrom] = useState(getDefaultFromDate());
  const [to, setTo] = useState(getDefaultToDate());

  /**
   * Cargar mayor
   */
  async function loadLedger() {
    if (!accountCode.trim()) {
      toast({
        title: 'Error',
        description: 'Debes ingresar un código de cuenta',
        status: 'warning',
        duration: 3000,
        isClosable: true
      });
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await getLedger(companyId, accountCode, from, to);
      setLedger(result);
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

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Mayor por Cuenta</Heading>
          <Button colorScheme="blue" onClick={loadLedger} isLoading={loading}>
            Cargar
          </Button>
        </HStack>

        {/* Filtros */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Filtros
          </Heading>

          <HStack spacing={4} mb={4} flexWrap="wrap">
            {/* Código de cuenta */}
            <FormControl w="150px">
              <FormLabel fontSize="sm">Código de Cuenta</FormLabel>
              <Input
                placeholder="Ej: 430, 700"
                value={accountCode}
                onChange={(e) => setAccountCode(e.target.value)}
                disabled={loading}
              />
            </FormControl>

            {/* Desde */}
            <FormControl w="150px">
              <FormLabel fontSize="sm">Desde</FormLabel>
              <Input
                size="sm"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                disabled={loading}
              />
            </FormControl>

            {/* Hasta */}
            <FormControl w="150px">
              <FormLabel fontSize="sm">Hasta</FormLabel>
              <Input
                size="sm"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={loading}
              />
            </FormControl>
          </HStack>

          <HStack mt={4}>
            <Button
              size="sm"
              colorScheme="blue"
              onClick={loadLedger}
              isLoading={loading}
            >
              Buscar
            </Button>
            <Button
              size="sm"
              leftIcon={<DownloadIcon />}
              variant="outline"
              isDisabled={loading || !ledger}
              onClick={() => ledger && exportLedgerToCsv(ledger)}
            >
              Exportar CSV
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

        {/* Loading */}
        {loading && (
          <Box textAlign="center" py={8}>
            <Spinner size="lg" />
          </Box>
        )}

        {/* Resultado */}
        {ledger && (
          <>
            {/* Encabezado de cuenta */}
            <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
              <Heading size="sm" mb={3}>
                Cuenta {ledger.cuenta}
              </Heading>

              <Grid templateColumns="repeat(2, 1fr)" gap={4}>
                <GridItem>
                  <Text fontSize="sm" color="gray.600">
                    Movimientos
                  </Text>
                  <Text fontWeight="bold" fontSize="lg">
                    {ledger.movimientos.length}
                  </Text>
                </GridItem>

                <GridItem>
                  <Text fontSize="sm" color="gray.600">
                    Saldo Final
                  </Text>
                  <Text
                    fontWeight="bold"
                    fontSize="lg"
                    color={ledger.saldoFinal >= 0 ? 'green.600' : 'red.600'}
                  >
                    {formatCurrency(ledger.saldoFinal)}
                  </Text>
                </GridItem>
              </Grid>
            </Box>

            {/* Tabla de movimientos */}
            <Box bg="white" p={4} borderRadius="md" boxShadow="sm" overflowX="auto">
              {ledger.movimientos.length === 0 ? (
                <Text textAlign="center" color="gray.500">
                  No hay movimientos para este período
                </Text>
              ) : (
                <Table size="sm" variant="striped" colorScheme="gray">
                  <Thead>
                    <Tr>
                      <Th>Fecha</Th>
                      <Th>Referencia</Th>
                      <Th isNumeric>Debe</Th>
                      <Th isNumeric>Haber</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {ledger.movimientos.map((entry, i) => (
                      <Tr key={i}>
                        <Td fontSize="sm">{formatDate(entry.fecha)}</Td>
                        <Td fontSize="sm">{entry.referencia}</Td>
                        <Td isNumeric color={entry.debe > 0 ? 'green.600' : 'gray.400'}>
                          {entry.debe > 0 ? formatCurrency(entry.debe) : '-'}
                        </Td>
                        <Td isNumeric color={entry.haber > 0 ? 'red.600' : 'gray.400'}>
                          {entry.haber > 0 ? formatCurrency(entry.haber) : '-'}
                        </Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </Box>
          </>
        )}

        {!ledger && !loading && !error && (
          <Alert status="info" borderRadius="md">
            <AlertIcon />
            Ingresa un código de cuenta y haz click en "Cargar" para ver el mayor
          </Alert>
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
    return 'No tienes permisos para ver el mayor.';
  }
  if (error.statusCode === 404) {
    return 'Cuenta no encontrada o sin movimientos.';
  }
  return error.message || 'Error desconocido.';
}
