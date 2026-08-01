/**
 * Página genérica de Clientes / Proveedores (operativa) — Chakra.
 * Parametrizada por `tipo`: clientes y proveedores son espejos. Listado +
 * búsqueda en vivo + alta rápida (con teléfono) + edición en línea.
 *
 * Es el PRIMER paso de la migración del front vanilla a Chakra (ADR-002) y
 * establece el molde CRUD reutilizable para el resto de páginas operativas.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Spinner,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import {
  Contacto,
  TipoContacto,
  actualizarContacto,
  buscarContactos,
  crearContacto,
  listarContactos,
} from '../../api/salesApi';

interface Props {
  tipo: TipoContacto;
  titulo: string;
  singular: string;
}

const ALTA_VACIA = { nombre: '', cifnif: '', email: '', telefono: '' };

export function ContactosPage({ tipo, titulo, singular }: Props): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [q, setQ] = useState('');
  const [items, setItems] = useState<Contacto[]>([]);
  const [cargando, setCargando] = useState(false);

  const [alta, setAlta] = useState(false);
  const [nuevo, setNuevo] = useState(ALTA_VACIA);

  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ nombre: '', email: '', telefono: '' });

  const error = useCallback(
    (e: unknown, fallback: string) =>
      toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fallback }),
    [toast],
  );

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const data = q.trim()
        ? await buscarContactos(companyId, tipo, q.trim(), 50)
        : await listarContactos(companyId, tipo);
      setItems(data);
    } catch (e) {
      error(e, 'No se pudo cargar el listado');
      setItems([]);
    } finally {
      setCargando(false);
    }
  }, [companyId, tipo, q, error]);

  // Recarga al cambiar la búsqueda (debounce ligero) o el tipo/empresa.
  useEffect(() => {
    const t = setTimeout(() => void cargar(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [cargar, q]);

  const crear = async (): Promise<void> => {
    if (!nuevo.nombre.trim() || !nuevo.cifnif.trim()) {
      toast({ status: 'warning', title: 'Nombre y NIF son obligatorios.' });
      return;
    }
    try {
      await crearContacto(companyId, tipo, nuevo);
      toast({ status: 'success', title: `${singular} creado.` });
      setAlta(false);
      setNuevo(ALTA_VACIA);
      await cargar();
    } catch (e) {
      error(e, `Error al crear el ${singular.toLowerCase()}`);
    }
  };

  const abrirEdicion = (c: Contacto): void => {
    setEditId(c.codigo);
    setEdit({ nombre: c.nombre, email: c.email, telefono: c.telefono });
  };

  const guardarEdicion = async (): Promise<void> => {
    if (!editId) return;
    try {
      await actualizarContacto(companyId, tipo, editId, edit);
      toast({ status: 'success', title: 'Cambios guardados.' });
      setEditId(null);
      await cargar();
    } catch (e) {
      error(e, 'Error al actualizar');
    }
  };

  return (
    <Container maxW="6xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">{titulo}</Heading>
        <Button colorScheme="blue" onClick={() => setAlta((v) => !v)}>
          {alta ? 'Cancelar' : `+ Nuevo ${singular.toLowerCase()}`}
        </Button>
      </Flex>

      {alta && (
        <Box borderWidth="1px" borderRadius="md" p={4} mb={4} bg="white">
          <HStack spacing={3} wrap="wrap">
            <Input maxW="220px" placeholder="Nombre / razón social *" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} />
            <Input maxW="160px" placeholder="NIF *" value={nuevo.cifnif} onChange={(e) => setNuevo({ ...nuevo, cifnif: e.target.value })} />
            <Input maxW="220px" placeholder="Email" value={nuevo.email} onChange={(e) => setNuevo({ ...nuevo, email: e.target.value })} />
            <Input maxW="160px" placeholder="Teléfono" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} />
            <Button colorScheme="blue" onClick={() => void crear()}>Guardar</Button>
          </HStack>
        </Box>
      )}

      <Input
        maxW="360px"
        mb={4}
        placeholder="🔍 Buscar por nombre, NIF o email…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : items.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>
          {q ? `Sin resultados para "${q}".` : `Aún no hay ${titulo.toLowerCase()}.`}
        </Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>Código</Th>
                <Th>Nombre</Th>
                <Th>NIF</Th>
                <Th>Email</Th>
                <Th>Teléfono</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {items.map((c) => {
                const enEdicion = editId === c.codigo && c.codigo !== '';
                return (
                  <Tr key={c.codigo || c.nif}>
                    <Td fontWeight="bold">{c.codigo}</Td>
                    {enEdicion ? (
                      <>
                        <Td><Input size="sm" value={edit.nombre} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></Td>
                        <Td>{c.nif}</Td>
                        <Td><Input size="sm" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Td>
                        <Td><Input size="sm" value={edit.telefono} onChange={(e) => setEdit({ ...edit, telefono: e.target.value })} /></Td>
                        <Td whiteSpace="nowrap">
                          <Button size="xs" colorScheme="blue" mr={2} onClick={() => void guardarEdicion()}>Guardar</Button>
                          <Button size="xs" variant="ghost" onClick={() => setEditId(null)}>Cancelar</Button>
                        </Td>
                      </>
                    ) : (
                      <>
                        <Td>{c.nombre}</Td>
                        <Td>{c.nif}</Td>
                        <Td>{c.email}</Td>
                        <Td>{c.telefono || <Box as="span" color="gray.300">—</Box>}</Td>
                        <Td><Button size="xs" variant="outline" onClick={() => abrirEdicion(c)} isDisabled={!c.codigo}>Editar</Button></Td>
                      </>
                    )}
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
