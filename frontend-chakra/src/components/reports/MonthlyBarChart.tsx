import React from 'react';
import { Box, Text } from '@chakra-ui/react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LineChart,
  Line,
} from 'recharts';
import { formatCurrency } from '../../utils/formatters';

const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function monthLabel(year: number, month: number): string {
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

function euroFormatter(v: any): string {
  return formatCurrency(Number(v));
}

export interface BarConfig {
  dataKey: string;
  name: string;
  color: string;
}

export interface ChartDataPoint {
  label: string;
  [key: string]: number | string;
}

interface ChartWrapperProps {
  /** Descripción accesible del gráfico (aria-label) */
  title: string;
  height: number;
  children: React.ReactNode;
}

function ChartWrapper({ title, height, children }: ChartWrapperProps) {
  return (
    <Box>
      {/* Título visible pequeño sobre el gráfico */}
      <Text fontSize="xs" color="gray.500" mb={1}>{title}</Text>
      {/*
        role="img" + aria-label: el lector de pantalla anuncia el gráfico como imagen.
        El interior (SVG de Recharts) se oculta con aria-hidden para evitar ruido.
        Los datos están disponibles en la tabla que aparece debajo.
      */}
      <Box
        role="img"
        aria-label={`${title}. Los datos están disponibles en la tabla a continuación.`}
      >
        <Box aria-hidden="true" w="100%" h={`${height}px`}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

interface MonthlyBarChartProps {
  /** Título descriptivo del gráfico */
  title: string;
  data: ChartDataPoint[];
  bars: BarConfig[];
  height?: number;
}

export function MonthlyBarChart({ title, data, bars, height = 260 }: MonthlyBarChartProps) {
  if (data.length === 0) return null;

  return (
    <ChartWrapper title={title} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
          <Tooltip formatter={euroFormatter} />
          {bars.length > 1 && <Legend />}
          {bars.map(b => (
            <Bar key={b.dataKey} dataKey={b.dataKey} name={b.name} fill={b.color} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}

interface MonthlyLineChartProps {
  title: string;
  data: ChartDataPoint[];
  lines: BarConfig[];
  height?: number;
}

export function MonthlyLineChart({ title, data, lines, height = 260 }: MonthlyLineChartProps) {
  if (data.length === 0) return null;

  return (
    <ChartWrapper title={title} height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 16, left: 8, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
          <Tooltip formatter={euroFormatter} />
          {lines.length > 1 && <Legend />}
          {lines.map(l => (
            <Line
              key={l.dataKey}
              dataKey={l.dataKey}
              name={l.name}
              stroke={l.color}
              dot={false}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartWrapper>
  );
}
