/**
 * Página: Detalle de Asiento Contable
 * Ruta: /companies/:companyId/accounting/journal-entries/:id
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Heading,
  VStack,
  HStack,
  Container,
  useToast,
  Spinner,
  Alert,
  AlertIcon,
  Badge,
  Text,
  Divider,
  Grid,
  GridItem,
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  useDisclosure,
  Textarea
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { getJournalEntryDetail, approveJournalEntry } from '../../api/accountingApi';
import { JournalEntryDetail, APIErrorResponse, JournalEntryLine } from '../../api/types';
import { JournalEntryLinesTable } from '../../components/accounting/JournalEntryLinesTable';
import { LineAdjustmentModal } from '../../components/accounting/LineAdjustmentModal';
import { HelpTooltip } from '../../components/help/HelpTooltip';
import { getHelpSnippet } from '../help/helpData';
import {
  formatDate,
  formatCurrency,
  getEstadoLabel,
  getEstadoColor,
  getOrigenLabel,
  validateBalance
} from '../../utils/formatters';

export function JournalEntryDetailPage() {
  const companyId = useCompanyId();
  const { id: journalEntryId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  // Estado
  const [asiento, setAsiento] = useState<JournalEntryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  // Modal de aprobación
  const { isOpen: isApprovalOpen, onOpen: onApprovalOpen, onClose: onApprovalClose } = useDisclosure();
  const [observaciones, setObservaciones] = useState('');

  // Modal de ajuste de línea
  const { isOpen: isLineAdjustOpen, onOpen: onLineAdjustOpen, onClose: onLineAdjustClose } = useDisclosure();
  const [selectedLine, setSelectedLine] = useState<JournalEntryLine | null>(null);

  if (!journalEntryId) {
    return (
      <Container maxW="6xl" py={6}>
        <Alert status="error">
          <AlertIcon />
          ID de asiento no válido
        </Alert>
      </Container>
    );
  }

  // Cargar detalle al montar
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadDetail(); }, [companyId, journalEntryId]);

  /**
   * Cargar detalle del asiento
   */
  async function loadDetail() {
    setLoading(true);
    setError(null);

    try {
      const result = await getJournalEntryDetail(companyId, journalEntryId!);
      setAsiento(result);
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
   * Aprobar asiento
   */
  async function handleApprove() {
    if (!asiento) return;

    setApproving(true);

    try {
      const updated = await approveJournalEntry(companyId, asiento.id, observaciones);
      setAsiento(updated);
      onApprovalClose();

      toast({
        title: 'Éxito',
        description: 'Asiento aprobado correctamente',
        status: 'success',
        duration: 5000,
        isClosable: true
      });

      // Redirect después de aprobación
      setTimeout(() => {
        navigate(`/accounting/journal-entries`);
      }, 1000);
    } catch (err) {
      const errorMsg = handleAPIError(err);
      toast({
        title: 'Error',
        description: errorMsg,
        status: 'error',
        duration: 5000,
        isClosable: true
      });
    } finally {
      setApproving(false);
    }
  }

  /**
   * Volver a lista
   */
  function handleBack() {
    navigate(`/accounting/journal-entries`);
  }

  /**
   * Abrir modal de ajuste de línea
   */
  function handleEditLine(line: JournalEntryLine) {
    setSelectedLine(line);
    onLineAdjustOpen();
  }

  /**
   * Callback tras ajustar línea (recargar asiento)
   */
  async function handleLineAdjustSuccess() {
    await loadDetail();
  }

  if (loading) {
    return (
      <Container maxW="6xl" py={6} textAlign="center">
        <Spinner size="lg" />
      </Container>
    );
  }

  if (error || !asiento) {
    return (
      <Container maxW="6xl" py={6}>
        <VStack spacing={4}>
          <Alert status="error">
            <AlertIcon />
            {error || 'No se pudo cargar el asiento'}
          </Alert>
          <Button onClick={handleBack}>Volver</Button>
        </VStack>
      </Container>
    );
  }

  const balanced = validateBalance(asiento.totalDebe, asiento.totalHaber);

  return (
    <Container maxW="6xl" py={6}>
      <VStack align="stretch" spacing={6}>
        {/* Botón volver */}
        <Button variant="ghost" size="sm" onClick={handleBack}>
          ← Volver a Asientos
        </Button>

        {/* Encabezado */}
        <HStack justify="space-between" align="start">
          <VStack align="start" spacing={2}>
            <Heading size="lg">{asiento.numeroAsiento}</Heading>
            <HStack spacing={2}>
              <Badge colorScheme={getEstadoColor(asiento.estado)}>
                {getEstadoLabel(asiento.estado)}
              </Badge>
            </HStack>
          </VStack>

          {/* Botones de acción */}
          <HStack spacing={2}>
            {asiento.permitidoAprobar && (
              <HelpTooltip label={getHelpSnippet('contabilidad-draft-posted')}>
                <Button
                  colorScheme="green"
                  onClick={onApprovalOpen}
                  isLoading={approving}
                >
                  Aprobar
                </Button>
              </HelpTooltip>
            )}
            {/* Recalcular: pendiente de implementación. Oculto para evitar crear
                asientos vacíos. Usar "Ajustar línea" mientras tanto. */}
          </HStack>
        </HStack>

        {/* Info general */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Grid templateColumns="repeat(4, 1fr)" gap={4}>
            <GridItem>
              <Text fontSize="sm" color="gray.600">Fecha</Text>
              <Text fontWeight="bold">{formatDate(asiento.fecha ?? asiento.fechaAsiento ?? '')}</Text>
            </GridItem>
            <GridItem>
              <Text fontSize="sm" color="gray.600">Origen</Text>
              <Text fontWeight="bold">{getOrigenLabel(asiento.origen)}</Text>
            </GridItem>
            <GridItem>
              <Text fontSize="sm" color="gray.600">Factura</Text>
              <Text fontWeight="bold">{asiento.facturaId || 'N/A'}</Text>
            </GridItem>
            <GridItem>
              <Text fontSize="sm" color="gray.600">Creado por</Text>
              <Text fontWeight="bold">{asiento.createdBy || 'Sistema'}</Text>
            </GridItem>
          </Grid>
        </Box>

        {/* Advertencias */}
        {!balanced && (
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            <VStack align="start" spacing={0}>
              <Text fontWeight="bold">Asiento Desbalanceado</Text>
              <Text fontSize="sm">
                Debe: {formatCurrency(asiento.totalDebe)} | Haber: {formatCurrency(asiento.totalHaber)}
              </Text>
            </VStack>
          </Alert>
        )}

        {asiento.validaciones.errores.length > 0 && (
          <Alert status="warning" borderRadius="md">
            <AlertIcon />
            <VStack align="start" spacing={0}>
              <Text fontWeight="bold">Errores de Validación</Text>
              {asiento.validaciones.errores.map((err, i) => (
                <Text key={i} fontSize="sm">
                  • {err}
                </Text>
              ))}
            </VStack>
          </Alert>
        )}

        {balanced && asiento.validaciones.errores.length === 0 && (
          <Alert status="success" borderRadius="md">
            <AlertIcon />
            ✅ Asiento validado correctamente
          </Alert>
        )}

        {/* Líneas */}
        <Box bg="white" p={4} borderRadius="md" boxShadow="sm">
          <Heading size="sm" mb={4}>
            Líneas Contables
          </Heading>
          <JournalEntryLinesTable
            lines={asiento.lineas}
            totalDebe={asiento.totalDebe}
            totalHaber={asiento.totalHaber}
            balanced={balanced}
            canEdit={asiento.permitidoAjustar}
            onEditLine={handleEditLine}
          />
        </Box>
      </VStack>

      {/* Modal de Ajuste de Línea */}
      {selectedLine && (
        <LineAdjustmentModal
          isOpen={isLineAdjustOpen}
          onClose={onLineAdjustClose}
          companyId={companyId}
          journalEntryId={journalEntryId}
          line={selectedLine}
          onSuccess={handleLineAdjustSuccess}
        />
      )}

      {/* Modal de Aprobación */}
      <Modal isOpen={isApprovalOpen} onClose={onApprovalClose}>
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>Aprobar Asiento</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack spacing={4}>
              <Text>
                ¿Está seguro de que desea aprobar el asiento{' '}
                <strong>{asiento.numeroAsiento}</strong>?
              </Text>
              <Text fontSize="sm" color="gray.600">
                Este asiento cambiará a estado POSTED y será definitivo.
              </Text>

              <Box w="100%">
                <Text fontSize="sm" fontWeight="bold" mb={2}>
                  Observaciones (opcional)
                </Text>
                <Textarea
                  placeholder="Agregar observaciones..."
                  value={observaciones}
                  onChange={(e) => setObservaciones(e.target.value)}
                  size="sm"
                />
              </Box>
            </VStack>
          </ModalBody>
          <ModalFooter>
            <HStack spacing={2}>
              <Button variant="ghost" onClick={onApprovalClose}>
                Cancelar
              </Button>
              <Button
                colorScheme="green"
                onClick={handleApprove}
                isLoading={approving}
              >
                Aprobar
              </Button>
            </HStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Container>
  );
}

/**
 * Manejar error de API
 */
function handleAPIError(error: any): string {
  if (error.statusCode === 401) {
    return 'Sesión expirada.';
  }
  if (error.statusCode === 403) {
    return 'No tienes permisos para esta acción.';
  }
  if (error.statusCode === 404) {
    return 'Asiento no encontrado.';
  }
  if (error.statusCode === 400) {
    return error.message || 'Datos inválidos.';
  }
  return error.message || 'Error desconocido.';
}
