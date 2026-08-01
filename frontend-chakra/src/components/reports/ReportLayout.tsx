import React from 'react';
import {
  Box, VStack, HStack, Heading, Text, Spinner, Alert, AlertIcon,
  AlertTitle, AlertDescription, Button,
} from '@chakra-ui/react';

export interface ReportLayoutProps {
  /** Identificador único para las asociaciones ARIA (sin espacios) */
  id: string;
  /** Título del informe → renderiza como h2 */
  title: string;
  /** Descripción breve visible bajo el título */
  description?: string;
  loading: boolean;
  error: string | null;
  /** false = mostrar estado "sin datos" */
  hasData: boolean;
  filterBar: React.ReactNode;
  exportButton: React.ReactNode;
  onRetry?: () => void;
  children: React.ReactNode;
}

export function ReportLayout({
  id,
  title,
  description,
  loading,
  error,
  hasData,
  filterBar,
  exportButton,
  onRetry,
  children,
}: ReportLayoutProps) {
  const titleId = `${id}-title`;

  return (
    <Box as="section" aria-labelledby={titleId}>
      <VStack align="stretch" spacing={4}>

        {/* Cabecera: título + botón de exportación */}
        <HStack justify="space-between" align="flex-start" flexWrap="wrap" gap={2}>
          <Box>
            <Heading as="h2" size="md" id={titleId}>{title}</Heading>
            {description && (
              <Text fontSize="xs" color="gray.500" mt={0.5}>{description}</Text>
            )}
          </Box>
          {exportButton}
        </HStack>

        {/* Filtros de periodo */}
        {filterBar}

        {/*
          Región de estado — aria-live="polite" anuncia cambios de forma no intrusiva.
          Los estados de carga, error y sin datos se muestran aquí.
        */}
        <Box aria-live="polite" aria-atomic="true">
          {loading && (
            <HStack spacing={2} py={4} color="gray.600" justify="center">
              <Spinner size="sm" aria-hidden="true" />
              <Text fontSize="sm">Cargando {title.toLowerCase()}…</Text>
            </HStack>
          )}

          {!loading && error && (
            <Alert status="error" borderRadius="md">
              <AlertIcon />
              <Box flex={1}>
                <AlertTitle fontSize="sm">No se ha podido cargar el informe</AlertTitle>
                <AlertDescription fontSize="sm">
                  {error}.{' '}
                  {onRetry && (
                    <Button
                      variant="link"
                      colorScheme="red"
                      size="sm"
                      onClick={onRetry}
                      aria-label={`Reintentar carga de ${title.toLowerCase()}`}
                    >
                      Reintentar
                    </Button>
                  )}
                </AlertDescription>
              </Box>
            </Alert>
          )}

          {!loading && !error && !hasData && (
            <Alert status="info" borderRadius="md">
              <AlertIcon />
              <AlertDescription fontSize="sm">
                Sin datos para el periodo seleccionado. Prueba con otro mes, año o rango de fechas.
              </AlertDescription>
            </Alert>
          )}
        </Box>

        {/* Contenido del informe (sólo cuando hay datos) */}
        {!loading && !error && hasData && children}
      </VStack>
    </Box>
  );
}
