/**
 * Admin — Usuarios de plataforma (Chakra). Fase 5 ADR-002.
 * Listado + alta de usuario (+ admin global opcional) + asignación a empresa
 * con un rol. Exige admin global; 403 amable si no lo eres.
 */

import React, { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Select,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import {
  EmpresaAdmin,
  UsuarioAdmin,
  asignarUsuarioEmpresa,
  crearUsuario,
  listarEmpresas,
  listarUsuarios,
} from '../../api/adminApi';

const ROLES = ['admin', 'contable', 'ventas', 'solo_lectura'];
const ALTA_VACIA = { email: '', password: '', esAdminGlobal: false };

export function AdminUsuariosPage(): React.ReactElement {
  const toast = useToast();
  const [usuarios, setUsuarios] = useState<UsuarioAdmin[]>([]);
  const [empresas, setEmpresas] = useState<EmpresaAdmin[]>([]);
  const [sinPermiso, setSinPermiso] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [alta, setAlta] = useState(false);
  const [nuevo, setNuevo] = useState(ALTA_VACIA);

  // Asignación a empresa por usuario expandido.
  const [asignarId, setAsignarId] = useState<string | null>(null);
  const [empresaSel, setEmpresaSel] = useState('');
  const [rolSel, setRolSel] = useState('contable');

  const manejarError = (e: unknown, fb: string): void => {
    if ((e as { statusCode?: number })?.statusCode === 403) { setSinPermiso(true); return; }
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = async (): Promise<void> => {
    setCargando(true);
    try {
      const [us, es] = await Promise.all([listarUsuarios(), listarEmpresas()]);
      setUsuarios(us);
      setEmpresas(es);
      if (es.length > 0) setEmpresaSel((prev) => prev || es[0].id);
      setSinPermiso(false);
    } catch (e) {
      manejarError(e, 'No se pudieron cargar los usuarios');
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { void cargar(); }, []);

  const crear = async (): Promise<void> => {
    if (!nuevo.email.trim() || !nuevo.password.trim()) {
      toast({ status: 'warning', title: 'Email y contraseña son obligatorios.' });
      return;
    }
    try {
      await crearUsuario({ email: nuevo.email.trim(), password: nuevo.password, esAdminGlobal: nuevo.esAdminGlobal });
      toast({ status: 'success', title: 'Usuario creado.' });
      setAlta(false);
      setNuevo(ALTA_VACIA);
      await cargar();
    } catch (e) {
      manejarError(e, 'No se pudo crear el usuario');
    }
  };

  const asignar = async (userId: string): Promise<void> => {
    if (!empresaSel) { toast({ status: 'warning', title: 'Elige una empresa.' }); return; }
    try {
      await asignarUsuarioEmpresa(userId, empresaSel, rolSel);
      const emp = empresas.find((e) => e.id === empresaSel);
      toast({ status: 'success', title: `Asignado a ${emp?.nombre ?? empresaSel} como ${rolSel}.` });
      setAsignarId(null);
    } catch (e) {
      manejarError(e, 'No se pudo asignar a la empresa');
    }
  };

  if (sinPermiso) {
    return (
      <Container maxW="3xl" py={10}>
        <Heading size="lg" mb={4}>Usuarios</Heading>
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
        <Heading size="lg">Usuarios</Heading>
        <Button colorScheme="blue" onClick={() => setAlta((v) => !v)}>{alta ? 'Cancelar' : '+ Nuevo usuario'}</Button>
      </Flex>

      {alta && (
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
          <HStack spacing={3} wrap="wrap">
            <Input maxW="240px" placeholder="Email *" type="email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
            <Input maxW="180px" placeholder="Contraseña *" type="password" value={nuevo.password} onChange={(e) => setNuevo({ ...nuevo, password: e.target.value })} />
            <Checkbox isChecked={nuevo.esAdminGlobal} onChange={(e) => setNuevo({ ...nuevo, esAdminGlobal: e.target.checked })}>Admin global</Checkbox>
            <Button colorScheme="blue" onClick={() => void crear()}>Guardar</Button>
          </HStack>
        </Box>
      )}

      {cargando ? (
        <Text color="gray.500" py={6} textAlign="center">Cargando…</Text>
      ) : usuarios.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>No hay usuarios.</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Email</Th><Th isNumeric>Empresas</Th><Th>Estado</Th><Th /></Tr>
            </Thead>
            <Tbody>
              {usuarios.map((u) => (
                <React.Fragment key={u.id}>
                  <Tr bg={asignarId === u.id ? 'blue.50' : undefined}>
                    <Td fontWeight="semibold">{u.email}</Td>
                    <Td isNumeric>{u.empresas.length}</Td>
                    <Td><Badge colorScheme={u.activo ? 'green' : 'gray'}>{u.activo ? 'Activo' : 'Inactivo'}</Badge></Td>
                    <Td><Button size="xs" variant="outline" onClick={() => setAsignarId((p) => (p === u.id ? null : u.id))}>Asignar a empresa</Button></Td>
                  </Tr>
                  {asignarId === u.id && (
                    <Tr>
                      <Td colSpan={4} bg="gray.50">
                        <HStack spacing={3} py={2} wrap="wrap">
                          <Select size="sm" maxW="260px" value={empresaSel} onChange={(e) => setEmpresaSel(e.target.value)}>
                            {empresas.map((e) => <option key={e.id} value={e.id}>{e.nombre}{e.codigo ? ` (${e.codigo})` : ''}</option>)}
                          </Select>
                          <Select size="sm" maxW="160px" value={rolSel} onChange={(e) => setRolSel(e.target.value)}>
                            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                          </Select>
                          <Button size="sm" colorScheme="blue" onClick={() => void asignar(u.id)}>Asignar</Button>
                        </HStack>
                      </Td>
                    </Tr>
                  )}
                </React.Fragment>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
