/**
 * Barra superior compartida por todas las paginas autenticadas: enlace a
 * /ayuda + HelpModeToggle. No se aplica a /login ni a la demo publica de
 * /lector (?demo=1), que son paginas independientes sin sesion.
 */

import React from 'react';
import { Box, Container, HStack, Link, Spacer } from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';
import { HelpModeToggle } from '../help/HelpModeToggle';
import { CarmenWidget } from '../chatbot/CarmenWidget';

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box>
      <Box borderBottomWidth="1px" bg="white" py={2}>
        <Container maxW="6xl">
          <HStack>
            <Spacer />
            <Link as={RouterLink} to="/api-test" fontSize="sm" color="blue.600" fontWeight="medium">
              API test
            </Link>
            <Link as={RouterLink} to="/ayuda" fontSize="sm" color="blue.600" fontWeight="medium">
              Ayuda
            </Link>
            <HelpModeToggle />
          </HStack>
        </Container>
      </Box>
      {children}
      <CarmenWidget />
    </Box>
  );
}
