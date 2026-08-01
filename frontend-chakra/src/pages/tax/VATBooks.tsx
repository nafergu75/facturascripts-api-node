/**
 * Página: Libros de IVA (Emitidas y Recibidas)
 * Ruta: /companies/:companyId/tax/vat-books
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
  Tabs,
  TabList,
  TabPanels,
  Tab,
  TabPanel,
  Select,
  FormControl,
  FormLabel,
  Text
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getVatBooksIssued, getVatBooksReceived } from '../../api/taxApi';
import { VatBooksResponse } from '../../api/types';
import { formatCurrency, formatDate } from '../../utils/formatters';

type TaxPeriod = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export function VATBooksPage() {
  const companyId = useCompanyId();
  const toast = useToast();

  // Estado
  const [issuedBooks, setIssuedBooks] = useState<VatBooksResponse | null>(null);
  const [receivedBooks, setReceivedBooks] = useState<VatBooksResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState<TaxPeriod>('Q1');

  // Cargar libros al montar o cambiar filtros
  useEffect(() => {
    loadVatBooks();
  }, [companyId, year, quarter]);

  /**
   * Cargar libros de IVA
   */
  async function loadVatBooks() {
    setLoading(true);
    setError(null);

    try {
      const period = `${quarter}-${year}`;

      const [issued, received] = await Promise.all([
        getVatBooksIssued(companyId, period),
        getVatBooksReceived(companyId, period)
      ]);

      setIssuedBooks(issued);
      setReceivedBooks(received);
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

  if (loading && !issuedBooks) {
    return (
      <Container maxW="6xl" py={6} textAlign="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Encabezado */}
        <HStack justify="space-between">
          <Heading size="lg">Libros de IVA</Heading>
          <Button colorScheme="blue" onClick={loadVatBooks}>
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
              onClick={loadVatBooks}
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

        {/* Tabs de libros */}
        {issuedBooks && receivedBooks && (
          <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
            <Tabs isFitted variant="enclosed">
              <TabList mb="1em">
                <Tab>Facturas Emitidas (IVA Repercutido)</Tab>
                <Tab>Facturas Recibidas (IVA Soportado)</Tab>
              </TabList>

              <TabPanels>
                {/* TAB 1: Facturas Emitidas */}
                <TabPanel>
                  <VatBookTable book={issuedBooks} />
                </TabPanel>

                {/* TAB 2: Facturas Recibidas */}
                <TabPanel>
                  <VatBookTable book={receivedBooks} />
                </TabPanel>
              </TabPanels>
            </Tabs>
          </Box>
        )}
      </VStack>
    </Container>
  );
}

/**
 * Componente auxiliar: Tabla de Libro de IVA
 */
interface VatBookTableProps {
  book: VatBooksResponse;
}

function VatBookTable({ book }: VatBookTableProps) {
  if (book.facturas.length === 0) {
    return (
      <Box textAlign="center" py={6}>
        <Text color="gray.500">No hay facturas para este período</Text>
      </Box>
    );
  }

  return (
    <VStack align="stretch" spacing={4}>
      <Table size="sm" variant="striped" colorScheme="gray">
        <Thead>
          <Tr>
            <Th>Fecha</Th>
            <Th>Nº Factura</Th>
            <Th>NIF</Th>
            <Th>Nombre</Th>
            <Th isNumeric>Base Imponible</Th>
            <Th isNumeric>Tipo IVA</Th>
            <Th isNumeric>Cuota IVA</Th>
          </Tr>
        </Thead>
        <Tbody>
          {book.facturas.map((factura, i) => (
            <Tr key={i}>
              <Td>{formatDate(factura.fecha)}</Td>
              <Td fontWeight="bold" fontSize="sm">
                {factura.numero}
              </Td>
              <Td fontSize="sm">{factura.nif || 'N/A'}</Td>
              <Td fontSize="sm">{factura.nombre || 'N/A'}</Td>
              <Td isNumeric>{formatCurrency(factura.base)}</Td>
              <Td isNumeric>{factura.tipoIva}%</Td>
              <Td isNumeric color="green.600" fontWeight="bold">
                {formatCurrency(factura.cuota)}
              </Td>
            </Tr>
          ))}
        </Tbody>
      </Table>

      {/* Resumen */}
      <Box bg="gray.50" p={3} borderRadius="md">
        <HStack justify="space-between" mb={2}>
          <Text fontWeight="bold">Total Base Imponible</Text>
          <Text fontWeight="bold">
            {formatCurrency(book.totalBases)}
          </Text>
        </HStack>
        <HStack justify="space-between">
          <Text fontWeight="bold">Total Cuotas IVA</Text>
          <Text fontWeight="bold" color="green.600">
            {formatCurrency(book.totalCuotas)}
          </Text>
        </HStack>
      </Box>
    </VStack>
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
    return 'No tienes permisos para ver libros de IVA.';
  }
  if (error.statusCode === 404) {
    return 'No hay datos para este período.';
  }
  return error.message || 'Error desconocido.';
}
