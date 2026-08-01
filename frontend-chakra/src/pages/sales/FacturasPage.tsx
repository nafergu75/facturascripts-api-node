/**
 * Facturas de ingreso (Chakra) — listado + filtros + paginación + acciones.
 * Sobre el módulo CANÓNICO Prisma /invoices (NO FacturaScripts), así que no
 * depende de tener FS levantado. Fase 2 de la migración ADR-002.
 *
 * El alta de factura (selector de cliente + líneas) es un slice aparte.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Select,
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
import {
  FacturaIngreso,
  FiltrosFacturas,
  cambiarEstadoFactura,
  crearAbono,
  listarFacturas,
} from '../../api/invoicesApi';

const TAKE = 20;

const eur = (n: number): string =>
  Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

const COLOR_ESTADO: Record<string, string> = { PAID: 'green', PENDING: 'orange', DRAFT: 'gray', CANCELLED: 'red' };

export function FacturasPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [estado, setEstado] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [skip, setSkip] = useState(0);

  const [items, setItems] = useState<FacturaIngreso[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(false);

  const errorToast = (e: unknown, fallback: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fallback });
  };

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const filtros: FiltrosFacturas = { estado: estado || undefined, desde: desde || undefined, hasta: hasta || undefined, skip, take: TAKE };
      const res = await listarFacturas(companyId, filtros);
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      errorToast(e, 'No se pudieron cargar las facturas');
      setItems([]);
      setTotal(0);
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, estado, desde, hasta, skip]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Al cambiar un filtro, volvemos a la primera página.
  useEffect(() => {
    setSkip(0);
  }, [estado, desde, hasta]);

  const marcarPagada = async (f: FacturaIngreso): Promise<void> => {
    try {
      await cambiarEstadoFactura(companyId, f.id, 'PAID');
      toast({ status: 'success', title: `Factura ${f.numeroCompleto} marcada como pagada.` });
      await cargar();
    } catch (e) {
      errorToast(e, 'No se pudo cambiar el estado');
    }
  };

  const abono = async (f: FacturaIngreso): Promise<void> => {
    try {
      const r = await crearAbono(companyId, f.id);
      toast({ status: 'success', title: `Abono creado: ${r.numeroCompleto ?? ''}`.trim() });
      await cargar();
    } catch (e) {
      errorToast(e, 'No se pudo crear el abono');
    }
  };

  const pagina = Math.floor(skip / TAKE) + 1;
  const totalPaginas = Math.max(1, Math.ceil(total / TAKE));

  return (
    <Container maxW="7xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Facturas de ingreso</Heading>
        <HStack spacing={4}>
          <Text fontSize="sm" color="gray.500">{total} factura(s)</Text>
          <Button as={RouterLink} to="/sales/facturas/nueva" colorScheme="blue" size="sm">+ Nueva factura</Button>
        </HStack>
      </Flex>

      <HStack spacing={3} mb={4} wrap="wrap">
        <Select maxW="200px" value={estado} onChange={(e) => setEstado(e.target.value)}>
          <option value="">Todos los estados</option>
          <option value="PENDING">Pendiente</option>
          <option value="PAID">Pagada</option>
          <option value="DRAFT">Borrador</option>
          <option value="CANCELLED">Anulada</option>
        </Select>
        <Box>
          <Text fontSize="xs" color="gray.500">Desde</Text>
          <Input type="date" maxW="170px" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500">Hasta</Text>
          <Input type="date" maxW="170px" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </Box>
      </HStack>

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : items.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>No hay facturas con esos filtros.</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr>
                <Th>Número</Th>
                <Th>Fecha</Th>
                <Th>Cliente</Th>
                <Th isNumeric>Base</Th>
                <Th isNumeric>IVA</Th>
                <Th isNumeric>Total</Th>
                <Th>Estado</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {items.map((f) => (
                <Tr key={f.id}>
                  <Td fontWeight="bold">
                    {f.numeroCompleto}
                    {f.esRectificativa && <Badge ml={2} colorScheme="purple">Abono</Badge>}
                  </Td>
                  <Td>{String(f.fechaEmision).slice(0, 10)}</Td>
                  <Td>{f.customerNombre ?? f.customerId}</Td>
                  <Td isNumeric>{eur(f.baseTotal)}</Td>
                  <Td isNumeric>{eur(f.ivaTotal)}</Td>
                  <Td isNumeric fontWeight="semibold">{eur(f.totalFactura)}</Td>
                  <Td><Badge colorScheme={COLOR_ESTADO[f.estado] ?? 'gray'}>{f.estado}</Badge></Td>
                  <Td whiteSpace="nowrap">
                    {f.estado !== 'PAID' && !f.esRectificativa && (
                      <Button size="xs" colorScheme="green" mr={2} onClick={() => void marcarPagada(f)}>Marcar pagada</Button>
                    )}
                    {!f.esRectificativa && (
                      <Button size="xs" variant="outline" onClick={() => void abono(f)}>Abono</Button>
                    )}
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}

      {total > TAKE && (
        <HStack justify="center" mt={4} spacing={4}>
          <Button size="sm" variant="outline" isDisabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - TAKE))}>← Anterior</Button>
          <Text fontSize="sm" color="gray.600">Página {pagina} de {totalPaginas}</Text>
          <Button size="sm" variant="outline" isDisabled={skip + TAKE >= total} onClick={() => setSkip(skip + TAKE)}>Siguiente →</Button>
        </HStack>
      )}
    </Container>
  );
}
