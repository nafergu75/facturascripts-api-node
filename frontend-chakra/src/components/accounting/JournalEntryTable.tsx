/**
 * Componente: Tabla de Asientos
 * Muestra lista de asientos en formato tabla con acciones
 */

import React from 'react';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Badge,
  Button,
  HStack,
  Box
} from '@chakra-ui/react';
import { JournalEntry } from '../../api/types';
import { formatCurrency, formatDate, getEstadoLabel, getEstadoColor, getOrigenLabel } from '../../utils/formatters';

interface JournalEntryTableProps {
  entries: JournalEntry[];
  loading?: boolean;
  onSelectEntry?: (entryId: string) => void;
  onViewDetail?: (entryId: string) => void;
}

export function JournalEntryTable({
  entries,
  loading = false,
  onSelectEntry,
  onViewDetail
}: JournalEntryTableProps) {
  if (loading) {
    return <Box textAlign="center" py={6}>Cargando asientos...</Box>;
  }

  if (entries.length === 0) {
    return <Box textAlign="center" py={6}>No hay asientos para mostrar</Box>;
  }

  return (
    <Table variant="striped" colorScheme="gray" size="sm">
      <Thead>
        <Tr>
          <Th>Nº Asiento</Th>
          <Th>Fecha</Th>
          <Th>Estado</Th>
          <Th>Origen</Th>
          <Th isNumeric>Total</Th>
          <Th>Acciones</Th>
        </Tr>
      </Thead>
      <Tbody>
        {entries.map((entry) => (
          <Tr key={entry.id} cursor="pointer">
            <Td fontWeight="bold">{entry.numeroAsiento}</Td>
            <Td>{formatDate(entry.fecha ?? entry.fechaAsiento ?? '')}</Td>
            <Td>
              <Badge colorScheme={getEstadoColor(entry.estado)}>
                {getEstadoLabel(entry.estado)}
              </Badge>
            </Td>
            <Td>{getOrigenLabel(entry.origen)}</Td>
            <Td isNumeric>{formatCurrency(entry.totalDebe)}</Td>
            <Td>
              <HStack spacing={2}>
                <Button
                  size="sm"
                  colorScheme="blue"
                  variant="outline"
                  onClick={() => onViewDetail?.(entry.id)}
                >
                  Ver
                </Button>
              </HStack>
            </Td>
          </Tr>
        ))}
      </Tbody>
    </Table>
  );
}
