/**
 * Productos — catálogo (Chakra). Fase 3 ADR-002.
 * Listado + búsqueda por referencia + alta rápida (recurso FS productos).
 * Necesita FacturaScripts levantado.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Badge,
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
  Text,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { Producto, crearProducto, listarProductos } from '../../api/productosApi';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const ALTA_VACIA = { referencia: '', descripcion: '', precio: '' };

export function ProductosPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [q, setQ] = useState('');
  const [items, setItems] = useState<Producto[]>([]);
  const [cargando, setCargando] = useState(false);
  const [alta, setAlta] = useState(false);
  const [nuevo, setNuevo] = useState(ALTA_VACIA);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const r = await listarProductos(companyId, q.trim() || undefined);
      setItems(r.items ?? []);
    } catch (e) {
      err(e, 'No se pudieron cargar los productos');
      setItems([]);
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, q]);

  useEffect(() => {
    const t = setTimeout(() => void cargar(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [cargar, q]);

  const crear = async (): Promise<void> => {
    if (!nuevo.referencia.trim()) {
      toast({ status: 'warning', title: 'La referencia es obligatoria.' });
      return;
    }
    try {
      await crearProducto(companyId, {
        referencia: nuevo.referencia.trim(),
        descripcion: nuevo.descripcion.trim() || undefined,
        precio: nuevo.precio ? Number(nuevo.precio) : undefined,
      });
      toast({ status: 'success', title: 'Producto creado.' });
      setAlta(false);
      setNuevo(ALTA_VACIA);
      await cargar();
    } catch (e) {
      err(e, 'No se pudo crear el producto');
    }
  };

  return (
    <Container maxW="6xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Productos</Heading>
        <Button colorScheme="blue" onClick={() => setAlta((v) => !v)}>{alta ? 'Cancelar' : '+ Nuevo producto'}</Button>
      </Flex>

      {alta && (
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
          <HStack spacing={3} wrap="wrap">
            <Input maxW="180px" placeholder="Referencia *" value={nuevo.referencia} onChange={(e) => setNuevo({ ...nuevo, referencia: e.target.value })} />
            <Input maxW="260px" placeholder="Descripción" value={nuevo.descripcion} onChange={(e) => setNuevo({ ...nuevo, descripcion: e.target.value })} />
            <Input maxW="120px" type="number" placeholder="Precio" value={nuevo.precio} onChange={(e) => setNuevo({ ...nuevo, precio: e.target.value })} />
            <Button colorScheme="blue" onClick={() => void crear()}>Guardar</Button>
          </HStack>
        </Box>
      )}

      <Input maxW="320px" mb={4} placeholder="🔍 Buscar por referencia…" value={q} onChange={(e) => setQ(e.target.value)} />

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : items.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>{q ? `Sin resultados para "${q}".` : 'Aún no hay productos.'}</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Referencia</Th><Th>Descripción</Th><Th isNumeric>Precio</Th><Th isNumeric>Stock</Th><Th>Estado</Th></Tr>
            </Thead>
            <Tbody>
              {items.map((p, i) => (
                <Tr key={p.idproducto ?? p.referencia ?? i}>
                  <Td fontWeight="bold">{p.referencia}</Td>
                  <Td>{p.descripcion ?? ''}</Td>
                  <Td isNumeric>{eur(Number(p.precio ?? 0))}</Td>
                  <Td isNumeric>{Number(p.stockfis ?? 0)}</Td>
                  <Td>{p.bloqueado ? <Badge colorScheme="red">Bloqueado</Badge> : <Badge colorScheme="green">Activo</Badge>}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
