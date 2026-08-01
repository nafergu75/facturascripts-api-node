/**
 * Componente: Gráfico de Análisis por Cliente
 * Usa Recharts BarChart horizontal para mostrar top clientes
 */

import React, { useState } from 'react';
import {
  Box,
  VStack,
  HStack,
  Button,
  Spinner,
  Alert,
  AlertIcon,
  Text
} from '@chakra-ui/react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { CustomerAnalysisItem } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';

interface CustomerAnalysisChartProps {
  items: CustomerAnalysisItem[];
  loading?: boolean;
  error?: string | null;
  topN?: number; // Mostrar top N clientes
  onExport?: () => void;
}

export function CustomerAnalysisChart({
  items,
  loading = false,
  error = null,
  topN = 10,
  onExport
}: CustomerAnalysisChartProps) {
  const [showAll, setShowAll] = useState(false);

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

  if (items.length === 0) {
    return (
      <Box textAlign="center" py={6}>
        <Text color="gray.500">No hay datos para mostrar</Text>
      </Box>
    );
  }

  // Preparar datos: ordenar por facturación descendente
  const sortedItems = [...items].sort((a, b) => b.totalFacturado - a.totalFacturado);
  const displayedItems = showAll ? sortedItems : sortedItems.slice(0, topN);

  const totalGeneral = items.reduce((sum, item) => sum + item.totalFacturado, 0);

  // Mapear a formato para Recharts (invertir para barras horizontales)
  const chartData = displayedItems.map(item => ({
    name: item.nombre,
    ingresos: item.totalFacturado,
    porcentaje: totalGeneral > 0 ? (item.totalFacturado / totalGeneral) * 100 : 0
  }));

  // Tooltip personalizado
  const CustomTooltip = (props: any) => {
    const { active, payload } = props;
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <Box bg="white" p={2} border="1px" borderColor="gray.300" borderRadius="md">
          <Text fontSize="sm" fontWeight="bold">{data.name}</Text>
          <Text fontSize="sm">{formatCurrency(data.ingresos)}</Text>
          <Text fontSize="xs" color="gray.600">{data.porcentaje.toFixed(1)}% del total</Text>
        </Box>
      );
    }
    return null;
  };

  return (
    <VStack align="stretch" spacing={4}>
      {/* Controles */}
      <HStack spacing={4}>
        {sortedItems.length > topN && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? `Ver solo top ${topN}` : `Ver todos (${sortedItems.length})`}
          </Button>
        )}

        {onExport && (
          <Button
            size="sm"
            colorScheme="green"
            variant="outline"
            onClick={onExport}
          >
            📥 Exportar CSV
          </Button>
        )}
      </HStack>

      {/* Gráfico */}
      <Box h={displayedItems.length * 50 + 100} w="100%">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 5, right: 30, left: 150, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              type="number"
              tickFormatter={(value) => `€${(value / 1000).toFixed(0)}k`}
            />
            <YAxis dataKey="name" type="category" width={140} />
            <Tooltip content={<CustomTooltip />} />
            <Bar
              dataKey="ingresos"
              fill="#22863a"
              name="Ingresos"
              radius={[0, 8, 8, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </Box>

      {/* Resumen */}
      <Text fontSize="xs" color="gray.600" mt={2}>
        Mostrando {displayedItems.length} de {sortedItems.length} clientes
      </Text>
    </VStack>
  );
}
