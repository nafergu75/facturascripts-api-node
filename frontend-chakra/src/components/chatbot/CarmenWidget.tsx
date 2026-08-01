/**
 * Widget flotante de Carmen: boton fijo abajo-derecha que abre un Drawer lateral
 * con el panel de chat. Se monta una vez en AppShell -> disponible en todas las
 * paginas autenticadas.
 */

import React from 'react';
import {
  Drawer,
  DrawerBody,
  DrawerCloseButton,
  DrawerContent,
  DrawerOverlay,
  IconButton,
  useDisclosure,
} from '@chakra-ui/react';
import { ChatIcon } from '@chakra-ui/icons';
import { CarmenChat } from './CarmenChat';

export function CarmenWidget(): React.ReactElement {
  const { isOpen, onOpen, onClose } = useDisclosure();

  return (
    <>
      <IconButton
        aria-label="Abrir asistente Carmen"
        icon={<ChatIcon />}
        colorScheme="blue"
        size="lg"
        isRound
        boxShadow="lg"
        position="fixed"
        bottom={6}
        right={6}
        zIndex={1400}
        onClick={onOpen}
      />

      <Drawer isOpen={isOpen} placement="right" onClose={onClose} size="md">
        <DrawerOverlay />
        <DrawerContent>
          <DrawerCloseButton zIndex={1} />
          <DrawerBody p={0}>
            <CarmenChat />
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}
