import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Container,
  FormControl,
  FormLabel,
  Heading,
  Input,
  Alert,
  AlertIcon,
  VStack,
  Text,
} from '@chakra-ui/react';
import { httpPost } from '../utils/http';
import { APIErrorResponse } from '../api/types';

interface LoginResponse {
  token: string;
  empresas: { companyId: string; codigo: string | null; nombre: string }[];
  empresaSeleccionada?: string;
}

export function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // En localhost, usa dev-login sin credenciales
      const endpoint = isLocalhost ? '/auth/dev-login' : '/auth/login';
      const payload = isLocalhost ? {} : { email, password };

      const result = await httpPost<LoginResponse>(endpoint, payload);

      localStorage.setItem('jwt_token', result.token);
      localStorage.setItem('company_id', '1');

      navigate('/');
    } catch (err) {
      const apiError = err as APIErrorResponse;
      setError(apiError.message || 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container maxW="sm" py={20}>
      <VStack spacing={6} align="stretch">
        <Heading size="lg" textAlign="center">Conta API</Heading>
        <Text color="gray.500" textAlign="center">Segunda piel (Chakra UI)</Text>

        {error && (
          <Alert status="error" borderRadius="md">
            <AlertIcon />
            {error}
          </Alert>
        )}

        <Box as="form" onSubmit={handleSubmit}>
          <VStack spacing={4} align="stretch">
            <FormControl isRequired>
              <FormLabel>Email</FormLabel>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            </FormControl>

            <FormControl isRequired>
              <FormLabel>Contraseña</FormLabel>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </FormControl>

            <Button type="submit" colorScheme="blue" isLoading={loading}>
              Entrar
            </Button>
          </VStack>
        </Box>
      </VStack>
    </Container>
  );
}
