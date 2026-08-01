/**
 * Modal para ajustar línea de asiento
 * Permite cambiar cuenta y/o montos (debe/haber)
 */

import React, { useState, useEffect } from 'react';
import {
  Modal,
  ModalOverlay,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
  Button,
  VStack,
  HStack,
  FormControl,
  FormLabel,
  Input,
  Text,
  useToast,
  Alert,
  AlertIcon
} from '@chakra-ui/react';
import { JournalEntryLine, AdjustJournalEntryLineRequest } from '../../api/types';
import { adjustJournalEntryLine } from '../../api/accountingApi';
import { formatCurrency } from '../../utils/formatters';

interface LineAdjustmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  companyId: string;
  journalEntryId: string;
  line: JournalEntryLine;
  onSuccess?: () => Promise<void>;
}

export function LineAdjustmentModal({
  isOpen,
  onClose,
  companyId,
  journalEntryId,
  line,
  onSuccess
}: LineAdjustmentModalProps) {
  const toast = useToast();

  // Estado del formulario
  const [accountCode, setAccountCode] = useState(line.accountCode);
  const [debe, setDebe] = useState(line.debe?.toString() ?? '');
  const [haber, setHaber] = useState(line.haber?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resetear formulario cuando se abre el modal
  useEffect(() => {
    if (isOpen) {
      setAccountCode(line.accountCode);
      setDebe(line.debe?.toString() ?? '');
      setHaber(line.haber?.toString() ?? '');
      setError(null);
    }
  }, [isOpen, line]);

  /**
   * Manejar cambio en debe
   */
  function handleDebeChange(value: string) {
    setDebe(value);
    // Auto-limpiar haber si escribimos en debe
    if (value && haber) {
      setHaber('');
    }
  }

  /**
   * Manejar cambio en haber
   */
  function handleHaberChange(value: string) {
    setHaber(value);
    // Auto-limpiar debe si escribimos en haber
    if (value && debe) {
      setDebe('');
    }
  }

  /**
   * Validar entrada antes de guardar
   */
  function validateInput(): string | null {
    // Al menos debe o haber debe tener valor
    if (!debe && !haber) {
      return 'Debes ingresar al menos un valor (Debe o Haber)';
    }

    // No pueden tener ambos
    if (debe && haber) {
      return 'Una línea no puede tener tanto Debe como Haber';
    }

    // Validar que sean números válidos
    if (debe && isNaN(parseFloat(debe))) {
      return 'El valor de Debe debe ser un número válido';
    }

    if (haber && isNaN(parseFloat(haber))) {
      return 'El valor de Haber debe ser un número válido';
    }

    // Validar que sean positivos
    if (debe && parseFloat(debe) < 0) {
      return 'El Debe debe ser un valor positivo';
    }

    if (haber && parseFloat(haber) < 0) {
      return 'El Haber debe ser un valor positivo';
    }

    return null;
  }

  /**
   * Guardar cambios
   */
  async function handleSave() {
    const validationError = validateInput();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const adjustments: AdjustJournalEntryLineRequest = {
        accountCode: accountCode !== line.accountCode ? accountCode : undefined,
        debe: debe ? parseFloat(debe) : undefined,
        haber: haber ? parseFloat(haber) : undefined
      };

      // Hacer el ajuste
      await adjustJournalEntryLine(
        companyId,
        journalEntryId,
        line.id,
        adjustments
      );

      toast({
        title: 'Éxito',
        description: 'Línea ajustada correctamente',
        status: 'success',
        duration: 3000,
        isClosable: true
      });

      // Refrescar asiento padre
      if (onSuccess) {
        await onSuccess();
      }

      onClose();
    } catch (err: any) {
      const errorMsg = err.message || 'Error al ajustar la línea';
      setError(errorMsg);

      toast({
        title: 'Error',
        description: errorMsg,
        status: 'error',
        duration: 5000,
        isClosable: true
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalOverlay />
      <ModalContent>
        <ModalHeader>Ajustar Línea de Asiento</ModalHeader>
        <ModalCloseButton />

        <ModalBody>
          <VStack spacing={5}>
            {/* Info actual */}
            <VStack align="start" w="100%" spacing={2} p={3} bg="gray.50" borderRadius="md">
              <Text fontSize="sm" fontWeight="bold">
                Información Actual
              </Text>
              <Text fontSize="sm">
                <strong>Cuenta:</strong> {line.accountCode} - {line.accountName}
              </Text>
              <Text fontSize="sm">
                <strong>Debe:</strong>{' '}
                {line.debe ? formatCurrency(line.debe) : 'N/A'}
              </Text>
              <Text fontSize="sm">
                <strong>Haber:</strong>{' '}
                {line.haber ? formatCurrency(line.haber) : 'N/A'}
              </Text>
            </VStack>

            {/* Errores */}
            {error && (
              <Alert status="error" borderRadius="md">
                <AlertIcon />
                {error}
              </Alert>
            )}

            {/* Formulario */}
            <VStack spacing={4} w="100%">
              {/* Código de cuenta */}
              <FormControl>
                <FormLabel fontSize="sm">Código de Cuenta</FormLabel>
                <Input
                  placeholder="Ej: 700, 430, 400"
                  value={accountCode}
                  onChange={(e) => setAccountCode(e.target.value)}
                  disabled={saving}
                />
                <Text fontSize="xs" color="gray.600" mt={1}>
                  Dejar en blanco para mantener la cuenta actual
                </Text>
              </FormControl>

              {/* Debe */}
              <FormControl>
                <FormLabel fontSize="sm">Debe (€)</FormLabel>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={debe}
                  onChange={(e) => handleDebeChange(e.target.value)}
                  disabled={saving}
                  step="0.01"
                  min="0"
                />
                <Text fontSize="xs" color="gray.600" mt={1}>
                  O ingresa el valor del Debe
                </Text>
              </FormControl>

              {/* Haber */}
              <FormControl>
                <FormLabel fontSize="sm">Haber (€)</FormLabel>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={haber}
                  onChange={(e) => handleHaberChange(e.target.value)}
                  disabled={saving}
                  step="0.01"
                  min="0"
                />
                <Text fontSize="xs" color="gray.600" mt={1}>
                  O ingresa el valor del Haber (mutuamente excluyente con Debe)
                </Text>
              </FormControl>

              {/* Información de validación */}
              <VStack align="start" w="100%" fontSize="sm" color="gray.600">
                <Text>
                  <strong>⚠️ Nota:</strong> El ajuste deberá mantener el asiento
                  balanceado. El sistema validará automáticamente.
                </Text>
              </VStack>
            </VStack>
          </VStack>
        </ModalBody>

        <ModalFooter>
          <HStack spacing={2}>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button
              colorScheme="blue"
              onClick={handleSave}
              isLoading={saving}
            >
              Guardar Cambios
            </Button>
          </HStack>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
