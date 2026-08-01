/**
 * Componente: Gráfico de Evolución Mensual
 * Muestra barras de ingresos vs gastos por mes
 *
 * Nota: Este es un gráfico simple con HTML/CSS.
 * Si se necesita más funcionalidad, se puede reemplazar con Recharts o Chart.js
 */

import React from 'react';
import {
  Box,
  HStack,
  VStack,
  Text,
  Spinner,
  Alert,
  AlertIcon
} from '@chakra-ui/react';
import { MonthlyEvolutionItem } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';

interface MonthlyEvolutionChartProps {
  data: MonthlyEvolutionItem[];
  loading?: boolean;
  error?: string | null;
}

export function MonthlyEvolutionChart({
  data,
  loading = false,
  error = null
}: MonthlyEvolutionChartProps) {
  if (loading) {
    return (
      <Box textAlign="center" py={6}>
        <Spinner size="lg" />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert status="error" borderRadius="md">
        <AlertIcon />
        {error}
      </Alert>
    );
  }

  if (data.length === 0) {
    return (
      <Box textAlign="center" py={6}>
        <Text color="gray.500">No hay datos para mostrar</Text>
      </Box>
    );
  }

  // Encontrar el máximo valor para escalar
  const maxValue = Math.max(
    ...data.map(item => Math.max(item.ingresos, item.gastos))
  );

  const scale = maxValue > 0 ? 300 / maxValue : 1; // 300px máximo

  return (
    <VStack align="stretch" spacing={4}>
      {/* Leyenda */}
      <HStack spacing={6} fontSize="sm">
        <HStack spacing={2}>
          <Box w="3" h="3" bg="green.500" borderRadius="2px" />
          <Text>Ingresos</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="3" h="3" bg="red.500" borderRadius="2px" />
          <Text>Gastos</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="3" h="3" bg="blue.500" borderRadius="2px" />
          <Text>Beneficio</Text>
        </HStack>
      </HStack>

      {/* Gráfico de barras */}
      <Box overflowX="auto" pb={4}>
        <HStack align="flex-end" spacing={2} minW="600px" h="300px">
          {data.map((item) => {
            const ingresoHeight = item.ingresos * scale;
            const gastoHeight = item.gastos * scale;

            return (
              <VStack key={item.mes} spacing={0} align="center" flex={1}>
                {/* Barras */}
                <HStack align="flex-end" spacing={1} h="280px" justify="center">
                  {/* Ingresos */}
                  <Box
                    w="8"
                    h={`${ingresoHeight}px`}
                    bg="green.400"
                    borderRadius="2px"
                    title={`Ingresos: ${formatCurrency(item.ingresos)}`}
                  />

                  {/* Gastos */}
                  <Box
                    w="8"
                    h={`${gastoHeight}px`}
                    bg="red.400"
                    borderRadius="2px"
                    title={`Gastos: ${formatCurrency(item.gastos)}`}
                  />
                </HStack>

                {/* Etiqueta mes */}
                <Text fontSize="xs" fontWeight="bold" mt={2}>
                  {formatMesEtiqueta(item.mes)}
                </Text>
              </VStack>
            );
          })}
        </HStack>
      </Box>

      {/* Tabla de datos */}
      <Box fontSize="xs" overflowX="auto">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <th style={{ textAlign: 'left', padding: '8px' }}>Mes</th>
              <th style={{ textAlign: 'right', padding: '8px' }}>Ingresos</th>
              <th style={{ textAlign: 'right', padding: '8px' }}>Gastos</th>
              <th style={{ textAlign: 'right', padding: '8px' }}>Beneficio</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={item.mes} style={{ borderBottom: '1px solid #f7fafc' }}>
                <td style={{ padding: '8px', fontWeight: 'bold' }}>
                  {formatMesEtiqueta(item.mes)}
                </td>
                <td style={{ textAlign: 'right', padding: '8px', color: '#22863a' }}>
                  {formatCurrency(item.ingresos)}
                </td>
                <td style={{ textAlign: 'right', padding: '8px', color: '#cb2431' }}>
                  {formatCurrency(item.gastos)}
                </td>
                <td
                  style={{
                    textAlign: 'right',
                    padding: '8px',
                    fontWeight: 'bold',
                    color: item.beneficio >= 0 ? '#22863a' : '#cb2431'
                  }}
                >
                  {formatCurrency(item.beneficio)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    </VStack>
  );
}

/**
 * Formatear mes a etiqueta (ej: "2026-01" → "Ene")
 */
function formatMesEtiqueta(mes: string): string {
  const [, monthStr] = mes.split('-');
  const monthNum = parseInt(monthStr, 10);
  const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return months[monthNum - 1] || mes;
}
