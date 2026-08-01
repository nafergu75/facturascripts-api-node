/**
 * Página: Probador de API
 * Ruta: /api-test
 *
 * Mini-cliente HTTP integrado para ejecutar los endpoints reales del backend
 * usando el token de sesión actual. Deliberadamente NO usa el http client
 * compartido (utils/http.ts): ese cliente redirige a /login automáticamente
 * en cualquier 401, lo que aquí sería contraproducente — el objetivo de esta
 * página es precisamente DEJAR VER un 401, no ocultarlo con una redirección.
 */

import React, { useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Container,
  FormControl,
  FormLabel,
  Grid,
  GridItem,
  Heading,
  HStack,
  Input,
  Link,
  Tab,
  TabList,
  Tabs,
  Text,
  Textarea,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { Link as RouterLink } from 'react-router-dom';
import { useCompanyId } from '../../hooks/useCompanyId';
import { apiEndpoints, ApiEndpoint, MODULE_LABEL, METHOD_COLOR } from './endpointsConfig';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';
const MODULES: ApiEndpoint['module'][] = ['lector', 'contabilidad', 'informes', 'seguridad'];
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

interface ResultState {
  status: number | null;
  durationMs: number;
  body: any;
  rawText?: string;
  isNetworkError: boolean;
}

export function ApiTestPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [activeModule, setActiveModule] = useState<ApiEndpoint['module']>('lector');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [path, setPath] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [result, setResult] = useState<ResultState | null>(null);
  const [executing, setExecuting] = useState(false);

  const selected = apiEndpoints.find((e) => e.id === selectedId) ?? null;
  const hasToken = !!localStorage.getItem('jwt_token');

  function buildPath(endpoint: ApiEndpoint): string {
    return endpoint.pathTemplate.replace(':companyId', companyId || ':companyId');
  }

  function handleSelect(endpoint: ApiEndpoint): void {
    setSelectedId(endpoint.id);
    setPath(buildPath(endpoint));
    setBodyText(endpoint.sampleBody ? JSON.stringify(endpoint.sampleBody, null, 2) : '');
    setResult(null);
  }

  function handleCargarEjemplo(): void {
    if (!selected) return;
    setBodyText(selected.sampleBody ? JSON.stringify(selected.sampleBody, null, 2) : '');
  }

  async function handleEjecutar(): Promise<void> {
    if (!selected) return;
    if (selected.requiresAuth && !hasToken) return;

    setExecuting(true);
    setResult(null);
    const token = localStorage.getItem('jwt_token');
    const url = `${API_BASE_URL}${path}`;
    const start = performance.now();

    try {
      const init: RequestInit = {
        method: selected.method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      };
      if (BODY_METHODS.has(selected.method) && bodyText.trim()) {
        init.body = bodyText;
      }

      const res = await fetch(url, init);
      const durationMs = Math.round(performance.now() - start);
      const contentType = res.headers.get('content-type') || '';

      let body: any = null;
      let rawText: string | undefined;
      if (contentType.includes('application/json')) {
        body = await res.json().catch(() => null);
      } else {
        rawText = await res.text().catch(() => '');
      }

      setResult({ status: res.status, durationMs, body, rawText, isNetworkError: false });
    } catch (err: any) {
      const durationMs = Math.round(performance.now() - start);
      setResult({
        status: null,
        durationMs,
        body: null,
        rawText: err?.message || 'No se pudo contactar con el servidor.',
        isNetworkError: true,
      });
    } finally {
      setExecuting(false);
    }
  }

  function handleCopiarRequest(): void {
    if (!selected) return;
    const text = `${selected.method} ${API_BASE_URL}${path}\n\n${bodyText || '(sin body)'}`;
    navigator.clipboard.writeText(text);
    toast({ title: 'Request copiada al portapapeles', status: 'success', duration: 2000 });
  }

  function handleCopiarResponse(): void {
    if (!result) return;
    const text = result.body ? JSON.stringify(result.body, null, 2) : result.rawText ?? '';
    navigator.clipboard.writeText(text);
    toast({ title: 'Respuesta copiada al portapapeles', status: 'success', duration: 2000 });
  }

  return (
    <Container maxW="7xl" py={8}>
      <VStack align="stretch" spacing={6}>
        <Box>
          <Heading size="lg">Probador de API</Heading>
          <Text color="gray.600" mt={1}>
            Ejecuta endpoints reales del backend con tu sesión actual. Las peticiones van directas a{' '}
            <Text as="span" fontFamily="mono" fontSize="sm">{API_BASE_URL}</Text>; nada de esto pasa por el modo demo.
          </Text>
        </Box>

        <Grid templateColumns={{ base: '1fr', lg: '340px 1fr' }} gap={6}>
          <GridItem>
            <Tabs
              index={MODULES.indexOf(activeModule)}
              onChange={(i) => setActiveModule(MODULES[i])}
              size="sm"
              variant="enclosed"
            >
              <TabList flexWrap="wrap">
                {MODULES.map((m) => (
                  <Tab key={m}>{MODULE_LABEL[m]}</Tab>
                ))}
              </TabList>
            </Tabs>

            <VStack align="stretch" spacing={2} mt={3}>
              {apiEndpoints.filter((e) => e.module === activeModule).map((e) => (
                <Box
                  key={e.id}
                  borderWidth="1px"
                  borderRadius="md"
                  p={3}
                  cursor="pointer"
                  bg={selectedId === e.id ? 'blue.50' : 'white'}
                  borderColor={selectedId === e.id ? 'blue.300' : 'gray.200'}
                  onClick={() => handleSelect(e)}
                >
                  <HStack spacing={2}>
                    <Badge colorScheme={METHOD_COLOR[e.method]} fontSize="xs">{e.method}</Badge>
                    <Text fontSize="sm" fontWeight="semibold">{e.name}</Text>
                  </HStack>
                  <Text fontSize="xs" color="gray.500" mt={1} noOfLines={1}>{e.pathTemplate}</Text>
                </Box>
              ))}
            </VStack>
          </GridItem>

          <GridItem>
            {!selected ? (
              <Text color="gray.500" fontSize="sm">Selecciona un endpoint de la lista para ver su detalle.</Text>
            ) : (
              <VStack align="stretch" spacing={4}>
                <Box>
                  <HStack spacing={2} mb={1}>
                    <Badge colorScheme={METHOD_COLOR[selected.method]}>{selected.method}</Badge>
                    <Heading size="md">{selected.name}</Heading>
                  </HStack>
                  <Text fontSize="sm" color="gray.600">{selected.description}</Text>
                </Box>

                {selected.knownLimitation && (
                  <Alert status="info" borderRadius="md" fontSize="sm">
                    <AlertIcon />
                    {selected.knownLimitation}
                  </Alert>
                )}

                {selected.requiresAuth && !hasToken && (
                  <Alert status="warning" borderRadius="md" fontSize="sm">
                    <AlertIcon />
                    Necesitas iniciar sesión para probar este endpoint.
                  </Alert>
                )}

                <FormControl>
                  <FormLabel fontSize="sm">Ruta</FormLabel>
                  <Input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    fontFamily="mono"
                    fontSize="sm"
                  />
                  <Text fontSize="xs" color="gray.500" mt={1}>{API_BASE_URL}{path}</Text>
                </FormControl>

                {BODY_METHODS.has(selected.method) && (
                  <FormControl>
                    <FormLabel fontSize="sm">Body (JSON)</FormLabel>
                    <Textarea
                      value={bodyText}
                      onChange={(e) => setBodyText(e.target.value)}
                      fontFamily="mono"
                      fontSize="sm"
                      rows={6}
                      placeholder="{}"
                    />
                  </FormControl>
                )}

                <HStack spacing={2} wrap="wrap">
                  <Button
                    colorScheme="blue"
                    onClick={handleEjecutar}
                    isLoading={executing}
                    isDisabled={Boolean(selected.requiresAuth) && !hasToken}
                  >
                    Ejecutar
                  </Button>
                  <Button variant="outline" size="md" onClick={handleCargarEjemplo} isDisabled={!selected.sampleBody}>
                    Cargar ejemplo
                  </Button>
                  <Button variant="ghost" size="md" onClick={handleCopiarRequest}>
                    Copiar request
                  </Button>
                  <Button variant="ghost" size="md" onClick={handleCopiarResponse} isDisabled={!result}>
                    Copiar response
                  </Button>
                </HStack>

                {result && <ResultPanel result={result} endpointModule={selected.module} />}
              </VStack>
            )}
          </GridItem>
        </Grid>
      </VStack>
    </Container>
  );
}

function statusBadge(result: ResultState): { colorScheme: string; label: string } {
  if (result.isNetworkError) return { colorScheme: 'gray', label: 'Sin respuesta' };
  const s = result.status ?? 0;
  if (s === 501) return { colorScheme: 'purple', label: '501 No implementado' };
  if (s === 401) return { colorScheme: 'orange', label: '401 No autenticado' };
  if (s === 403) return { colorScheme: 'orange', label: '403 Sin permiso' };
  if (s >= 200 && s < 300) return { colorScheme: 'green', label: `${s} OK` };
  if (s >= 400) return { colorScheme: 'red', label: `${s} Error` };
  return { colorScheme: 'gray', label: String(s) };
}

function ResultPanel({ result, endpointModule }: { result: ResultState; endpointModule: ApiEndpoint['module'] }) {
  const badge = statusBadge(result);

  return (
    <Box borderWidth="1px" borderRadius="md" p={4} bg="white">
      <HStack justify="space-between" mb={3}>
        <Badge colorScheme={badge.colorScheme} fontSize="sm" px={2} py={1}>{badge.label}</Badge>
        <Text fontSize="sm" color="gray.500">{result.durationMs} ms</Text>
      </HStack>

      {result.status === 501 && (
        <Alert status="info" borderRadius="md" fontSize="sm" mb={3}>
          <AlertIcon />
          Funcionalidad todavía no disponible en esta versión (501). No es un error de red ni un bug: es un estado conocido.
        </Alert>
      )}

      {result.status === 401 && (
        <Alert status="warning" borderRadius="md" fontSize="sm" mb={3}>
          <AlertIcon />
          El servidor respondió "no autenticado". Si acabas de iniciar sesión, comprueba que el token no haya expirado (24h).
        </Alert>
      )}

      {result.isNetworkError && (
        <Alert status="warning" borderRadius="md" fontSize="sm" mb={3}>
          <AlertIcon />
          <VStack align="start" spacing={1}>
            <Text>No se pudo contactar con la API: {result.rawText}</Text>
            {endpointModule === 'lector' && (
              <Text>
                Puedes probar el flujo visual sin backend en{' '}
                <Link as={RouterLink} to="/lector?demo=1" textDecoration="underline">
                  /lector (modo demo)
                </Link>.
              </Text>
            )}
          </VStack>
        </Alert>
      )}

      <Box
        as="pre"
        bg="gray.50"
        p={3}
        borderRadius="md"
        fontSize="xs"
        fontFamily="mono"
        overflowX="auto"
        maxH="420px"
        overflowY="auto"
        whiteSpace="pre-wrap"
      >
        {result.body ? JSON.stringify(result.body, null, 2) : result.rawText || '(sin contenido)'}
      </Box>
    </Box>
  );
}
