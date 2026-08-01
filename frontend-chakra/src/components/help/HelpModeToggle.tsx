import React from 'react';
import { HStack, Switch, Text, useToast } from '@chakra-ui/react';
import { useHelpMode } from '../../context/HelpModeContext';

/** Control global visible en la cabecera: activa/desactiva los HelpTooltip de toda la app. */
export function HelpModeToggle(): React.ReactElement {
  const { helpModeEnabled, setHelpModeEnabled } = useHelpMode();
  const toast = useToast();

  function handleChange(checked: boolean): void {
    setHelpModeEnabled(checked);
    if (checked) {
      toast({
        title: 'Modo ayuda activado',
        description: 'Pasa el ratón por encima de los botones (o navega con Tab) para ver explicaciones breves.',
        status: 'info',
        duration: 4000,
        isClosable: true,
      });
    }
  }

  return (
    <HStack spacing={2}>
      <Text fontSize="sm" color="gray.600">Modo ayuda</Text>
      <Switch
        size="sm"
        colorScheme="blue"
        isChecked={helpModeEnabled}
        onChange={(e) => handleChange(e.target.checked)}
        aria-label="Activar o desactivar el modo ayuda"
      />
    </HStack>
  );
}
