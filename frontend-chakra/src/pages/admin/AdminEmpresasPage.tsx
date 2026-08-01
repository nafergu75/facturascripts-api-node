/**
 * Admin — Empresas de plataforma (Chakra). Fase 5 ADR-002.
 * Listado + alta de empresa (cada empresa = una instancia FS aislada:
 * fsBaseUrl + fsApiKey cifrada). Exige admin global; 403 amable si no lo eres.
 */

import React, { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import { EmpresaAdmin, crearEmpresa, listarEmpresas } from '../../api/adminApi';

const ALTA_VACIA = { nombre: '', codigo: '', fsBaseUrl: '', fsApiKey: '' };

export function AdminEmpresasPage(): React.ReactElement {
  const toast = useToast();
  const [empresas, setEmpresas] = useState<EmpresaAdmin[]>([]);
  const [sinPermiso, setSinPermiso] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [alta, setAlta] = useState(false);
  const [nueva, setNueva] = useState(ALTA_VACIA);

  const manejarError = (e: unknown, fb: string): void => {
    if ((e as { statusCode?: number })?.statusCode === 403) { setSinPermiso(true); return; }
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = async (): Promise<void> => {
    setCargando(true);
    try {
      setEmpresas(await listarEmpresas());
      setSinPermiso(false);
    } catch (e) {
      manejarError(e, 'No se pudieron cargar las empresas');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { void cargar(); }, []);

  const crear = async (): Promise<void> => {
    if (!nueva.nombre.trim() || !nueva.fsBaseUrl.trim() || !nueva.fsApiKey.trim()) {
      toast({ status: 'warning', title: 'Nombre, fsBaseUrl y fsApiKey son obligatorios.' });
      return;
    }
    try {
      await crearEmpresa({ nombre: nueva.nombre.trim(), codigo: nueva.codigo.trim() || undefined, fsBaseUrl: nueva.fsBaseUrl.trim(), fsApiKey: nueva.fsApiKey.trim() });
      toast({ status: 'success', title: 'Empresa creada.' });
      setAlta(false);
      setNueva(ALTA_VACIA);
      await cargar();
    } catch (e) {
      manejarError(e, 'No se pudo crear la empresa');
    }
  };

  if (sinPermiso) {
    return (
      <Container maxW="3xl" py={10}>
        <Heading size="lg" mb={4}>Empresas</Heading>
        <Box bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={6} textAlign="center">
          <Text fontWeight="semibold" color="orange.700">🔒 Sección de administrador global</Text>
          <Text fontSize="sm" color="orange.800" mt={1}>Tu usuario no tiene permisos de administración de plataforma.</Text>
        </Box>
      </Container>
    );
  }

  return (
    <Container maxW="5xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Empresas</Heading>
        <Button colorScheme="blue" onClick={() => setAlta((v) => !v)}>{alta ? 'Cancelar' : '+ Nueva empresa'}</Button>
      </Flex>

      {alta && (
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
          <Text fontSize="xs" color="gray.500" mb={2}>Cada empresa es una instancia FacturaScripts aislada. La API Key se guarda cifrada.</Text>
          <HStack spacing={3} wrap="wrap">
            <Input maxW="200px" placeholder="Nombre *" value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} />
            <Input maxW="120px" placeholder="Código" value={nueva.codigo} onChange={(e) => setNueva({ ...nueva, codigo: e.target.value })} />
            <Input maxW="240px" placeholder="fsBaseUrl *" value={nueva.fsBaseUrl} onChange={(e) => setNueva({ ...nueva, fsBaseUrl: e.target.value })} />
            <Input maxW="220px" type="password" placeholder="fsApiKey *" value={nueva.fsApiKey} onChange={(e) => setNueva({ ...nueva, fsApiKey: e.target.value })} />
            <Button colorScheme="blue" onClick={() => void crear()}>Guardar</Button>
          </HStack>
        </Box>
      )}

      {cargando ? (
        <Text color="gray.500" py={6} textAlign="center">Cargando…</Text>
      ) : empresas.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>No hay empresas.</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Código</Th><Th>Nombre</Th><Th>fsBaseUrl</Th><Th>Estado</Th></Tr>
            </Thead>
            <Tbody>
              {empresas.map((e) => (
                <Tr key={e.id}>
                  <Td fontWeight="bold">{e.codigo || <Box as="span" color="gray.300">—</Box>}</Td>
                  <Td>{e.nombre}</Td>
                  <Td><Text fontSize="xs" color="gray.500">{e.fsBaseUrl}</Text></Td>
                  <Td><Badge colorScheme={e.activa ? 'green' : 'gray'}>{e.activa ? 'Activa' : 'Inactiva'}</Badge></Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
