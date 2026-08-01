import React from 'react';
import { Button, Menu, MenuButton, MenuList, MenuItem, Text, HStack, useToast } from '@chakra-ui/react';
import { DownloadIcon, ChevronDownIcon } from '@chakra-ui/icons';
import { HelpTooltip } from '../help/HelpTooltip';
import { getHelpSnippet } from '../../pages/help/helpData';

interface ExportButtonsProps {
  onCsv: () => void;
  onExcel: () => void;
  onPdf: () => void;
  isDisabled?: boolean;
}

export function ExportButtons({ onCsv, onExcel, onPdf, isDisabled }: ExportButtonsProps) {
  const toast = useToast();

  function safe(fn: () => void) {
    try {
      fn();
    } catch (err) {
      toast({
        title: 'Error al exportar',
        description: err instanceof Error ? err.message : 'No se pudo generar el archivo.',
        status: 'error',
        duration: 6000,
        isClosable: true,
      });
    }
  }

  return (
    <Menu>
      <HelpTooltip label={getHelpSnippet('informes-exportar')}>
        <MenuButton
          as={Button}
          leftIcon={<DownloadIcon />}
          rightIcon={<ChevronDownIcon />}
          variant="outline"
          size="sm"
          isDisabled={isDisabled}
          aria-label="Exportar informe"
          aria-haspopup="menu"
        >
          Exportar
        </MenuButton>
      </HelpTooltip>
      <MenuList minW="180px" fontSize="sm">
        <HelpTooltip label="Descarga este informe en formato CSV (texto separado por comas, se abre en Excel)." placement="right">
          <MenuItem onClick={() => safe(onCsv)} aria-label="Exportar a CSV (valores separados por coma)">
            <HStack spacing={2} w="100%">
              <Text flex={1}>CSV</Text>
              <Text fontSize="xs" color="gray.400">.csv</Text>
            </HStack>
          </MenuItem>
        </HelpTooltip>
        <HelpTooltip label="Descarga este informe como hoja de cálculo Excel (.xlsx) nativa." placement="right">
          <MenuItem onClick={() => safe(onExcel)} aria-label="Exportar a Excel">
            <HStack spacing={2} w="100%">
              <Text flex={1}>Excel</Text>
              <Text fontSize="xs" color="gray.400">.xlsx</Text>
            </HStack>
          </MenuItem>
        </HelpTooltip>
        <HelpTooltip label="Abre el diálogo de impresión del navegador para guardar este informe como PDF." placement="right">
          <MenuItem onClick={() => safe(onPdf)} aria-label="Abrir diálogo de impresión para guardar como PDF">
            <HStack spacing={2} w="100%">
              <Text flex={1}>PDF</Text>
              <Text fontSize="xs" color="gray.400">imprimir</Text>
            </HStack>
          </MenuItem>
        </HelpTooltip>
      </MenuList>
    </Menu>
  );
}
