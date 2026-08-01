/**
 * Componente: Tabla de Líneas de Asiento
 * Muestra las líneas contables (debe/haber) de un asiento
 */

import React from 'react';
import {
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  HStack,
  Button,
  Box,
  Text,
  Divider
} from '@chakra-ui/react';
import { JournalEntryLine } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';

interface JournalEntryLinesTableProps {
  lines: JournalEntryLine[];
  totalDebe: number;
  totalHaber: number;
  balanced: boolean;
  canEdit?: boolean;
  onEditLine?: (line: JournalEntryLine) => void;
}

export function JournalEntryLinesTable({
  lines,
  totalDebe,
  totalHaber,
  balanced,
  canEdit = false,
  onEditLine
}: JournalEntryLinesTableProps) {
  const differencia = Math.abs(totalDebe - totalHaber);

  return (
    <Box>
      <Table size="sm" variant="striped" colorScheme="gray">
        <Thead>
          <Tr>
            <Th>Código</Th>
            <Th>Nombre Cuenta</Th>
            <Th isNumeric>Debe</Th>
            <Th isNumeric>Haber</Th>
            <Th>Descripción</Th>
            {canEdit && <Th>Acciones</Th>}
          </Tr>
        </Thead>
        <Tbody>
          {lines.map((line) => (
            <Tr key={line.id}>
              <Td fontWeight="bold" fontSize="sm">
                {line.accountCode}
              </Td>
              <Td>{line.accountName}</Td>
              <Td isNumeric color={line.debe ? 'green.600' : 'gray.400'}>
                {line.debe ? formatCurrency(line.debe) : '-'}
              </Td>
              <Td isNumeric color={line.haber ? 'red.600' : 'gray.400'}>
                {line.haber ? formatCurrency(line.haber) : '-'}
              </Td>
              <Td fontSize="sm">{line.descripcion || '-'}</Td>
              {canEdit && (
                <Td>
                  <Button
                    size="xs"
                    colorScheme="blue"
                    variant="outline"
                    onClick={() => onEditLine?.(line)}
                  >
                    Editar
                  </Button>
                </Td>
              )}
            </Tr>
          ))}
        </Tbody>
      </Table>

      {/* Totales */}
      <Box mt={4} p={3} bg="gray.50" borderRadius="md">
        <HStack justify="space-between" mb={2}>
          <Text fontWeight="bold">Total Debe:</Text>
          <Text fontSize="lg" fontWeight="bold" color="green.600">
            {formatCurrency(totalDebe)}
          </Text>
        </HStack>
        <HStack justify="space-between" mb={2}>
          <Text fontWeight="bold">Total Haber:</Text>
          <Text fontSize="lg" fontWeight="bold" color="red.600">
            {formatCurrency(totalHaber)}
          </Text>
        </HStack>

        <Divider my={2} />

        {balanced ? (
          <HStack justify="space-between">
            <Text fontWeight="bold" color="green.600">
              ✅ Asiento Balanceado
            </Text>
            <Text fontSize="sm" color="gray.600">
              Diferencia: {formatCurrency(differencia)}
            </Text>
          </HStack>
        ) : (
          <HStack justify="space-between">
            <Text fontWeight="bold" color="red.600">
              ❌ Asiento Desbalanceado
            </Text>
            <Text fontSize="sm" color="red.600">
              Diferencia: {formatCurrency(differencia)}
            </Text>
          </HStack>
        )}
      </Box>
    </Box>
  );
}
