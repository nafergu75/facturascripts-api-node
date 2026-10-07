import React from 'react';
import { Box, Container, Heading } from '@chakra-ui/react';
import { CarmenChat } from '../components/chatbot/CarmenChat';

/**
 * Página /chat: la misma conversación con Carmen que el widget flotante, a
 * pantalla completa. Antes simulaba la respuesta («API no conectada aún»).
 */
export function ChatPage(): React.ReactElement {
  return (
    <Container maxW="2xl" py={6}>
      <Heading as="h1" size="lg" mb={4}>
        Carmen, asistente contable
      </Heading>
      <Box h="70vh" borderWidth={1} borderColor="gray.200" borderRadius="lg" overflow="hidden">
        <CarmenChat />
      </Box>
    </Container>
  );
}
