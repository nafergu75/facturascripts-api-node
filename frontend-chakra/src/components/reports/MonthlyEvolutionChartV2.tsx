/**
 * Componente: Gráfico de Evolución Mensual Avanzado
 * Usa Recharts para visualización interactiva
 *
 * Características:
 * - Línea/Barras de ingresos vs gastos
 * - Tooltips interactivos
 * - Leyenda con toggle
 * - Soporte para comparativa período-a-período
 */

import React, { useState } from 'react';
import {
  Box,
  VStack,
  HStack,
  Text,
  Checkbox,
  Button,
  Spinner,
  Alert,
  AlertIcon
} from '@chakra-ui/react';
import {
  LineChart,
  BarChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer
} from 'recharts';
import { MonthlyEvolutionItem } from '../../api/types';
import { formatCurrency } from '../../utils/formatters';

interface MonthlyEvolutionChartV2Props {
  data: MonthlyEvolutionItem[];
  comparisonData?: MonthlyEvolutionItem[]; // Para comparativa año anterior
  loading?: boolean;
  error?: string | null;
  onExport?: () => void;
}

type ChartType = 'line' | 'bar';

export function MonthlyEvolutionChartV2({
  data,
  comparisonData,
  loading = false,
  error = null,
  onExport
}: MonthlyEvolutionChartV2Props) {
  const [chartType, setChartType] = useState<ChartType>('line');
  const [showIngresos, setShowIngresos] = useState(true);
  const [showGastos, setShowGastos] = useState(true);
  const [showComparison, setShowComparison] = useState(!!comparisonData);

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

  // Preparar datos para comparativa
  const chartData = showComparison && comparisonData
    ? data.map((item, idx) => ({
        mes: item.mes,
        ingresosActual: item.ingresos,
        gastosActual: item.gastos,
        ingresosAnterior: comparisonData[idx]?.ingresos ?? 0,
        gastosAnterior: comparisonData[idx]?.gastos ?? 0
      }))
    : data.map(item => ({
        mes: item.mes,
        ingresos: item.ingresos,
        gastos: item.gastos
      }));

  // Componente personalizado de tooltip
  const CustomTooltip = (props: any) => {
    const { active, payload } = props;
    if (active && payload && payload.length) {
      return (
        <Box bg="white" p={2} border="1px" borderColor="gray.300" borderRadius="md">
          {payload.map((entry: any, idx: number) => (
            <Text key={idx} fontSize="sm" color={entry.color}>
              {entry.name}: {formatCurrency(entry.value)}
            </Text>
          ))}
        </Box>
      );
    }
    return null;
  };

  return (
    <VStack align="stretch" spacing={4}>
      {/* Controles */}
      <HStack spacing={4} flexWrap="wrap">
        {/* Tipo de gráfico */}
        <HStack spacing={2}>
          <Button
            size="sm"
            variant={chartType === 'line' ? 'solid' : 'outline'}
            colorScheme="blue"
            onClick={() => setChartType('line')}
          >
            Línea
          </Button>
          <Button
            size="sm"
            variant={chartType === 'bar' ? 'solid' : 'outline'}
            colorScheme="blue"
            onClick={() => setChartType('bar')}
          >
            Barras
          </Button>
        </HStack>

        {/* Checkboxes de series */}
        <HStack spacing={3}>
          <Checkbox
            isChecked={showIngresos}
            onChange={(e) => setShowIngresos(e.target.checked)}
            colorScheme="green"
          >
            <Text fontSize="sm">Ingresos</Text>
          </Checkbox>
          <Checkbox
            isChecked={showGastos}
            onChange={(e) => setShowGastos(e.target.checked)}
            colorScheme="red"
          >
            <Text fontSize="sm">Gastos</Text>
          </Checkbox>
        </HStack>

        {/* Comparativa */}
        {comparisonData && (
          <Checkbox
            isChecked={showComparison}
            onChange={(e) => setShowComparison(e.target.checked)}
            colorScheme="blue"
          >
            <Text fontSize="sm">Comparar año anterior</Text>
          </Checkbox>
        )}

        {/* Exportar */}
        {onExport && (
          <Button size="sm" colorScheme="green" variant="outline" onClick={onExport}>
            📥 Exportar CSV
          </Button>
        )}
      </HStack>

      {/* Gráfico */}
      <Box h="400px" w="100%">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === 'line' ? (
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="mes"
                tickFormatter={(mes) => mes.split('-')[1] || mes}
              />
              <YAxis
                tickFormatter={(value) => `€${(value / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />

              {showIngresos && !showComparison && (
                <Line
                  type="monotone"
                  dataKey="ingresos"
                  stroke="#22863a"
                  name="Ingresos"
                  strokeWidth={2}
                />
              )}
              {showGastos && !showComparison && (
                <Line
                  type="monotone"
                  dataKey="gastos"
                  stroke="#cb2431"
                  name="Gastos"
                  strokeWidth={2}
                />
              )}

              {/* Comparativa */}
              {showComparison && showIngresos && (
                <>
                  <Line
                    type="monotone"
                    dataKey="ingresosActual"
                    stroke="#22863a"
                    name="Ingresos 2026"
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="ingresosAnterior"
                    stroke="#7fb06d"
                    name="Ingresos 2025"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                  />
                </>
              )}
              {showComparison && showGastos && (
                <>
                  <Line
                    type="monotone"
                    dataKey="gastosActual"
                    stroke="#cb2431"
                    name="Gastos 2026"
                    strokeWidth={2}
                  />
                  <Line
                    type="monotone"
                    dataKey="gastosAnterior"
                    stroke="#f5a9a9"
                    name="Gastos 2025"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                  />
                </>
              )}
            </LineChart>
          ) : (
            <BarChart data={chartData} margin={{ top: 5, right: 30, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="mes"
                tickFormatter={(mes) => mes.split('-')[1] || mes}
              />
              <YAxis
                tickFormatter={(value) => `€${(value / 1000).toFixed(0)}k`}
              />
              <Tooltip content={<CustomTooltip />} />
              <Legend />

              {showIngresos && !showComparison && (
                <Bar dataKey="ingresos" fill="#22863a" name="Ingresos" />
              )}
              {showGastos && !showComparison && (
                <Bar dataKey="gastos" fill="#cb2431" name="Gastos" />
              )}

              {/* Comparativa */}
              {showComparison && showIngresos && (
                <>
                  <Bar dataKey="ingresosActual" fill="#22863a" name="Ingresos 2026" />
                  <Bar dataKey="ingresosAnterior" fill="#7fb06d" name="Ingresos 2025" />
                </>
              )}
              {showComparison && showGastos && (
                <>
                  <Bar dataKey="gastosActual" fill="#cb2431" name="Gastos 2026" />
                  <Bar dataKey="gastosAnterior" fill="#f5a9a9" name="Gastos 2025" />
                </>
              )}
            </BarChart>
          )}
        </ResponsiveContainer>
      </Box>
    </VStack>
  );
}
