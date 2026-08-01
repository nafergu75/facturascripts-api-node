import React from 'react';
import {
  Box, HStack, VStack, Button, FormControl, FormLabel, Select, Input,
  Badge, Text, Tooltip,
} from '@chakra-ui/react';
import { FinancialFilterState, FilterMode } from '../../api/types';

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

const MONTH_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => currentYear - 2 + i - 1);

/** Texto legible del periodo actualmente aplicado */
function appliedPeriodLabel(f: FinancialFilterState): string {
  if (f.mode === 'YEAR')  return `Año ${f.year}`;
  if (f.mode === 'MONTH') return `${MONTH_SHORT[f.month - 1]} ${f.year}`;
  return `${f.fromDate} — ${f.toDate}`;
}

interface PeriodFiltersProps {
  /** Filtros pendientes (lo que hay en los controles) */
  filters: FinancialFilterState;
  /** Filtros aplicados actualmente (reflejados en los datos) */
  appliedFilters: FinancialFilterState;
  onChange: (f: FinancialFilterState) => void;
  onApply: () => void;
  isLoading?: boolean;
}

export function PeriodFilters({ filters, appliedFilters, onChange, onApply, isLoading }: PeriodFiltersProps) {
  const isDirty = JSON.stringify(filters) !== JSON.stringify(appliedFilters);
  const setMode = (mode: FilterMode) => onChange({ ...filters, mode });

  return (
    <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
      <VStack align="stretch" spacing={3}>

        {/* Indicador de periodo activo */}
        <HStack spacing={2} aria-live="polite" aria-atomic="true">
          <Text fontSize="xs" color="gray.500">Mostrando:</Text>
          <Badge colorScheme="blue" fontSize="xs" px={2} py={0.5}>
            {appliedPeriodLabel(appliedFilters)}
          </Badge>
          {isDirty && (
            <Badge colorScheme="orange" fontSize="xs" px={2} py={0.5}>
              Cambios pendientes
            </Badge>
          )}
        </HStack>

        {/* Controles de filtro */}
        <HStack spacing={3} flexWrap="wrap" align="flex-end">

          {/* Selector de modo — role="group" para que los lectores de pantalla lo identifiquen */}
          <Box role="group" aria-label="Modo de periodo">
            <Text fontSize="xs" color="gray.500" mb={1} id="period-mode-label">Periodo por</Text>
            <HStack spacing={1}>
              {(['YEAR', 'MONTH', 'RANGE'] as FilterMode[]).map((mode) => {
                const labels: Record<FilterMode, string> = { YEAR: 'Año', MONTH: 'Mes', RANGE: 'Rango' };
                const isActive = filters.mode === mode;
                return (
                  <Button
                    key={mode}
                    size="sm"
                    variant={isActive ? 'solid' : 'outline'}
                    colorScheme={isActive ? 'blue' : 'gray'}
                    aria-pressed={isActive}
                    aria-label={`Filtrar por ${labels[mode].toLowerCase()}`}
                    onClick={() => setMode(mode)}
                  >
                    {labels[mode]}
                  </Button>
                );
              })}
            </HStack>
          </Box>

          {/* Año */}
          {(filters.mode === 'YEAR' || filters.mode === 'MONTH') && (
            <FormControl w="110px">
              <FormLabel fontSize="xs" mb={1}>Año</FormLabel>
              <Select
                size="sm"
                value={filters.year}
                onChange={e => onChange({ ...filters, year: Number(e.target.value) })}
                aria-label="Seleccionar año"
              >
                {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
              </Select>
            </FormControl>
          )}

          {/* Mes */}
          {filters.mode === 'MONTH' && (
            <FormControl w="145px">
              <FormLabel fontSize="xs" mb={1}>Mes</FormLabel>
              <Select
                size="sm"
                value={filters.month}
                onChange={e => onChange({ ...filters, month: Number(e.target.value) })}
                aria-label="Seleccionar mes"
              >
                {MONTH_NAMES.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{name}</option>
                ))}
              </Select>
            </FormControl>
          )}

          {/* Rango de fechas */}
          {filters.mode === 'RANGE' && (
            <>
              <FormControl w="148px">
                <FormLabel fontSize="xs" mb={1}>Desde</FormLabel>
                <Input
                  size="sm"
                  type="date"
                  value={filters.fromDate}
                  onChange={e => onChange({ ...filters, fromDate: e.target.value })}
                  aria-label="Fecha de inicio del rango"
                />
              </FormControl>
              <FormControl w="148px">
                <FormLabel fontSize="xs" mb={1}>Hasta</FormLabel>
                <Input
                  size="sm"
                  type="date"
                  value={filters.toDate}
                  onChange={e => onChange({ ...filters, toDate: e.target.value })}
                  aria-label="Fecha de fin del rango"
                />
              </FormControl>
            </>
          )}

          {/* Botón de aplicar */}
          <Tooltip
            label={isDirty ? 'Hay cambios pendientes de aplicar' : 'Los filtros actuales ya están aplicados'}
            placement="top"
            hasArrow
          >
            <Button
              size="sm"
              colorScheme={isDirty ? 'orange' : 'blue'}
              isLoading={isLoading}
              loadingText="Cargando…"
              onClick={onApply}
              aria-label={isDirty
                ? `Actualizar informe con el periodo seleccionado: ${appliedPeriodLabel(filters)}`
                : 'Actualizar informe'
              }
            >
              {isDirty ? 'Actualizar informe ●' : 'Actualizar informe'}
            </Button>
          </Tooltip>
        </HStack>
      </VStack>
    </Box>
  );
}
