/**
 * Página: Listado de Asientos Contables
 * Ruta: /companies/:companyId/accounting/journal-entries
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Heading,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  Select,
  Input,
  Container,
  useToast,
  Spinner,
  Alert,
  AlertIcon
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getJournalEntries } from '../../api/accountingApi';
import { JournalEntry, JournalEntryFilters, APIErrorResponse } from '../../api/types';
import { JournalEntryTable } from '../../components/accounting/JournalEntryTable';
import { formatDate } from '../../utils/formatters';

export function JournalEntryListPage() {
  const companyId = useCompanyId();
  const navigate = useNavigate();
  const toast = useToast();

  // Estado
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filtros
  const [filters, setFilters] = useState<JournalEntryFilters>({
    estado: undefined,
    origen: undefined,
    from: getDefaultFromDate(),
    to: getDefaultToDate()
  });

  // Cargar asientos al montar o cambiar filtros
  useEffect(() => {
    loadEntries();
  }, [companyId, filters]);

  /**
   * Obtener asientos del API
   */
  async function loadEntries() {
    setLoading(true);
    setError(null);

    try {
      const result = await getJournalEntries(companyId, filters);
      setEntries(result);
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

  /**
   * Navegar a detalle de asiento
   */
  function handleViewDetail(journalEntryId: string) {
    navigate(`/accounting/journal-entries/${journalEntryId}`);
  }

  /**
   * Cambiar filtro
   */
  function handleFilterChange(key: keyof JournalEntryFilters, value: any) {
    setFilters((prev) => ({
      ...prev,
      [key]: value || undefined
    }));
  }

  return (
    <Container maxW="6xl" py={6}>
      {/* Encabezado */}
      <VStack align="stretch" spacing={6}>
        <HStack justify="space-between">
          <Heading size="lg">Asientos Contables</Heading>
          <Button colorScheme="blue" onClick={() => loadEntries()}>
            Actualizar
          </Button>
        </HStack>

        {/* Filtros */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Filtros
          </Heading>

          <HStack spacing={4} mb={4} flexWrap="wrap">
            {/* Estado */}
            <FormControl w="200px">
              <FormLabel fontSize="sm">Estado</FormLabel>
              <Select
                size="sm"
                placeholder="Todos"
                value={filters.estado || ''}
                onChange={(e) =>
                  handleFilterChange(
                    'estado',
                    e.target.value as any
                  )
                }
              >
                <option value="DRAFT">Borrador</option>
                <option value="PENDING_REVIEW">Pendiente de Revisión</option>
                <option value="POSTED">Contabilizado</option>
                <option value="REVERSED">Reversado</option>
              </Select>
            </FormControl>

            {/* Origen */}
            <FormControl w="200px">
              <FormLabel fontSize="sm">Origen</FormLabel>
              <Select
                size="sm"
                placeholder="Todos"
                value={filters.origen || ''}
                onChange={(e) =>
                  handleFilterChange('origen', e.target.value)
                }
              >
                <option value="INCOME_INVOICE">Factura Ingreso</option>
                <option value="EXPENSE_INVOICE">Factura Gasto</option>
                <option value="MANUAL">Manual</option>
              </Select>
            </FormControl>

            {/* Desde */}
            <FormControl w="150px">
              <FormLabel fontSize="sm">Desde</FormLabel>
              <Input
                size="sm"
                type="date"
                value={filters.from}
                onChange={(e) =>
                  handleFilterChange('from', e.target.value)
                }
              />
            </FormControl>

            {/* Hasta */}
            <FormControl w="150px">
              <FormLabel fontSize="sm">Hasta</FormLabel>
              <Input
                size="sm"
                type="date"
                value={filters.to}
                onChange={(e) =>
                  handleFilterChange('to', e.target.value)
                }
              />
            </FormControl>
          </HStack>

          <Button size="sm" colorScheme="blue" onClick={() => loadEntries()}>
            Buscar
          </Button>
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

        {/* Tabla de asientos */}
        {!loading && (
          <Box bg="white" p={4} borderRadius="md" boxShadow="sm" overflowX="auto">
            <JournalEntryTable
              entries={entries}
              loading={loading}
              onViewDetail={handleViewDetail}
            />
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
  return formatDate(now.toISOString()).split('/').reverse().join('-');
}

/**
 * Manejar error de API
 */
function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada. Por favor, inicia sesión de nuevo.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos para ver estos asientos.';
  }
  if (error.statusCode === 404) {
    return 'No se encontraron asientos.';
  }
  return error.message || 'Error desconocido al cargar asientos.';
}
