import React from 'react';
import { Box, Text, VisuallyHidden, Tooltip } from '@chakra-ui/react';
import { formatCurrency } from '../../utils/formatters';

interface SummaryCardProps {
  label: string;
  value: number;
  /** Descripción adicional que aparece en tooltip (aria-describedby) */
  hint?: string;
  colorScheme?: 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'gray';
  /**
   * true  → positivo = bueno (verde) / negativo = malo (rojo). Ej: resultado, saldo.
   * false → positivo = malo  (rojo) / negativo = bueno (verde). Ej: IVA a pagar, gastos.
   * undefined → usa colorScheme fijo.
   */
  isPositiveGood?: boolean;
}

const BG: Record<string, string> = {
  blue:   'blue.50',
  green:  'green.50',
  red:    'red.50',
  orange: 'orange.50',
  purple: 'purple.50',
  gray:   'gray.50',
};

const FG: Record<string, string> = {
  blue:   'blue.700',
  green:  'green.700',
  red:    'red.700',
  orange: 'orange.700',
  purple: 'purple.700',
  gray:   'gray.700',
};

export function SummaryCard({ label, value, hint, colorScheme = 'blue', isPositiveGood }: SummaryCardProps) {
  let scheme = colorScheme;
  let srSign: string | null = null;

  if (isPositiveGood !== undefined) {
    // Bug fix: respetar la dirección del indicador
    // isPositiveGood=true  → ≥0 es bueno (verde); <0 es malo (rojo)
    // isPositiveGood=false → ≤0 es bueno (verde); >0 es malo (rojo)
    const isGood = isPositiveGood ? value >= 0 : value <= 0;
    scheme = isGood ? 'green' : 'red';
    srSign = isGood ? '(favorable)' : '(desfavorable)';
  }

  const card = (
    <Box flex={1} bg={BG[scheme]} p={4} borderRadius="md" minW="150px" role="group">
      <Text fontSize="xs" color="gray.500" mb={1}>{label}</Text>
      <Text fontSize="xl" fontWeight="bold" color={FG[scheme]}>
        {formatCurrency(value)}
        {/* Texto sólo para lectores de pantalla: indica sentido del valor */}
        {srSign && <VisuallyHidden> {srSign}</VisuallyHidden>}
      </Text>
    </Box>
  );

  if (hint) {
    return (
      <Tooltip label={hint} placement="top" hasArrow>
        {card}
      </Tooltip>
    );
  }

  return card;
}
