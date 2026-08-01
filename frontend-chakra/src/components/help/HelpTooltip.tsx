/**
 * Envuelve un control con una explicacion breve que SOLO aparece cuando el
 * modo ayuda esta activado (useHelpMode). Se apoya en Chakra <Tooltip>, que ya
 * cumple las practicas WCAG relevantes (1.4.13 Content on Hover or Focus):
 *  - aparece en hover Y en focus (Chakra adjunta ambos manejadores al hijo),
 *  - usa role="tooltip" + aria-describedby automaticamente sobre el hijo,
 *  - se puede cerrar con Escape,
 *  - closeOnClick=false + closeDelay evita que desaparezca por un movimiento
 *    minimo del raton entre el control y el propio tooltip.
 *
 * Deliberadamente NO usamos el atributo HTML `title`: no es accesible de forma
 * consistente (no es anunciado igual por todos los lectores de pantalla, no
 * funciona con teclado en muchos navegadores, no se puede estilizar).
 */

import React from 'react';
import { Tooltip, TooltipProps } from '@chakra-ui/react';
import { useHelpMode } from '../../context/HelpModeContext';

interface HelpTooltipProps {
  /** Frase breve, en lenguaje simple, explicando que hace el control. */
  label: string;
  children: React.ReactElement;
  placement?: TooltipProps['placement'];
}

export function HelpTooltip({ label, children, placement = 'top' }: HelpTooltipProps): React.ReactElement {
  const { helpModeEnabled } = useHelpMode();

  // Modo ayuda apagado: no se monta ningun Tooltip — cero impacto en el control.
  if (!helpModeEnabled) return children;

  return (
    <Tooltip
      label={label}
      placement={placement}
      hasArrow
      openDelay={150}
      closeDelay={150}
      closeOnClick={false}
      fontSize="sm"
      px={3}
      py={2}
      borderRadius="md"
      maxW="260px"
    >
      {children}
    </Tooltip>
  );
}
