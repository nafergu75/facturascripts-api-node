/**
 * Compras — facturas de gasto (Chakra). Fase 3 ADR-002.
 * Solo lectura (recurso FS facturaproveedores); el alta va por el lector de
 * facturas. Necesita FacturaScripts levantado.
 */

import React, { useEffect, useState } from 'react';
import {
  Box,
  Container,
  Flex,
  HStack,
  Heading,
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
import { Link as RouterLink } from 'react-router-dom';
import { Button } from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { FacturaProveedor, listarCompras } from '../../api/comprasApi';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function ComprasPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();
  const [items, setItems] = useState<FacturaProveedor[]>([]);
  const [total, setTotal] = useState(0);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    setCargando(true);
    listarCompras(companyId, { pageSize: 50 })
      .then((r) => { setItems(r.items ?? []); setTotal(r.total ?? (r.items?.length ?? 0)); })
      .catch((e) => toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || 'No se pudieron cargar las compras' }))
      .finally(() => setCargando(false));
  }, [companyId, toast]);

  return (
    <Container maxW="7xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Compras (facturas de gasto)</Heading>
        <HStack spacing={4}>
          <Text fontSize="sm" color="gray.500">{total} factura(s)</Text>
          <Button as={RouterLink} to="/lector" colorScheme="blue" size="sm">+ Subir al lector</Button>
        </HStack>
      </Flex>

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : items.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>No hay facturas de gasto. Súbelas por el lector de facturas.</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Código</Th><Th>Proveedor</Th><Th>Fecha</Th><Th isNumeric>Base</Th><Th isNumeric>IVA</Th><Th isNumeric>Total</Th></Tr>
            </Thead>
            <Tbody>
              {items.map((f, i) => (
                <Tr key={f.idfactura ?? f.codigo ?? i}>
                  <Td fontWeight="bold">{f.codigo}</Td>
                  <Td>{f.nombre ?? f.codproveedor ?? ''}</Td>
                  <Td>{String(f.fecha ?? '').slice(0, 10)}</Td>
                  <Td isNumeric>{eur(Number(f.neto ?? 0))}</Td>
                  <Td isNumeric>{eur(Number(f.totaliva ?? 0))}</Td>
                  <Td isNumeric fontWeight="semibold">{eur(Number(f.total ?? 0))}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
