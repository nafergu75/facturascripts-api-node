/**
 * Tesorería — Conciliación bancaria (Chakra). Fase 3 ADR-002.
 * Lista los movimientos PENDIENTES (Prisma /bancos) y permite conciliar cada uno:
 *  - contra una factura de ingreso pendiente (cobro contabilizado), o
 *  - contra una cuenta contable (555 partidas pendientes por defecto).
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
import { MovimientoBancario, conciliarConCuenta, conciliarConFactura, listarTodosMovimientos } from '../../api/bancosApi';
import { FacturaIngreso, listarFacturas } from '../../api/invoicesApi';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function ConciliacionPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [movs, setMovs] = useState<MovimientoBancario[]>([]);
  const [facturas, setFacturas] = useState<FacturaIngreso[]>([]);
  const [cargando, setCargando] = useState(false);
  const [expandido, setExpandido] = useState<string | null>(null);

  // Estado del panel de conciliación por movimiento expandido.
  const [facturaSel, setFacturaSel] = useState('');
  const [subcuenta, setSubcuenta] = useState('555');
  const [concepto, setConcepto] = useState('');
  const [enviando, setEnviando] = useState(false);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const [todos, facts] = await Promise.all([
        listarTodosMovimientos(companyId),
        listarFacturas(companyId, { estado: 'PENDING', take: 100 }),
      ]);
      setMovs(todos.filter((m) => !m.conciliado));
      setFacturas(facts.items);
    } catch (e) {
      err(e, 'No se pudieron cargar los datos de conciliación');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const abrir = (movId: string): void => {
    setExpandido((prev) => (prev === movId ? null : movId));
    setFacturaSel('');
    setSubcuenta('555');
    setConcepto('');
  };

  const conciliarFactura = async (movId: string): Promise<void> => {
    if (!facturaSel) {
      toast({ status: 'warning', title: 'Elige una factura.' });
      return;
    }
    setEnviando(true);
    try {
      await conciliarConFactura(companyId, movId, facturaSel);
      toast({ status: 'success', title: 'Movimiento conciliado con la factura.' });
      setExpandido(null);
      await cargar();
    } catch (e) {
      err(e, 'No se pudo conciliar con la factura');
    } finally {
      setEnviando(false);
    }
  };

  const conciliarCuenta = async (movId: string): Promise<void> => {
    if (!subcuenta.trim()) {
      toast({ status: 'warning', title: 'Indica la subcuenta contable.' });
      return;
    }
    setEnviando(true);
    try {
      await conciliarConCuenta(companyId, movId, subcuenta.trim(), concepto.trim() || undefined);
      toast({ status: 'success', title: `Movimiento conciliado contra ${subcuenta.trim()}.` });
      setExpandido(null);
      await cargar();
    } catch (e) {
      err(e, 'No se pudo conciliar contra la cuenta');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Container maxW="7xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Conciliación bancaria</Heading>
        <Text fontSize="sm" color="gray.500">{movs.length} movimiento(s) pendiente(s)</Text>
      </Flex>

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : movs.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>No hay movimientos pendientes de conciliar. 🎉</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Fecha</Th><Th>Concepto</Th><Th isNumeric>Importe</Th><Th /></Tr>
            </Thead>
            <Tbody>
              {movs.map((m) => (
                <React.Fragment key={m.id}>
                  <Tr bg={expandido === m.id ? 'blue.50' : undefined}>
                    <Td>{String(m.fecha).slice(0, 10)}</Td>
                    <Td>{m.concepto}</Td>
                    <Td isNumeric color={m.importe < 0 ? 'red.500' : 'green.600'} fontWeight="semibold">{eur(m.importe)}</Td>
                    <Td><Button size="xs" colorScheme="blue" variant={expandido === m.id ? 'solid' : 'outline'} onClick={() => abrir(m.id)}>Conciliar</Button></Td>
                  </Tr>
                  {expandido === m.id && (
                    <Tr>
                      <Td colSpan={4} bg="gray.50">
                        <HStack align="flex-start" spacing={8} wrap="wrap" py={2}>
                          <Box>
                            <Text fontSize="sm" fontWeight="semibold" mb={2}>Conciliar con factura</Text>
                            <HStack>
                              <Select size="sm" maxW="320px" placeholder="Elige factura pendiente…" value={facturaSel} onChange={(e) => setFacturaSel(e.target.value)}>
                                {facturas.map((f) => (
                                  <option key={f.id} value={f.id}>{f.numeroCompleto} · {f.customerNombre ?? ''} · {eur(f.totalFactura)}</option>
                                ))}
                              </Select>
                              <Button size="sm" colorScheme="green" isLoading={enviando} onClick={() => void conciliarFactura(m.id)}>Conciliar</Button>
                            </HStack>
                            {facturas.length === 0 && <Text fontSize="xs" color="gray.400" mt={1}>No hay facturas pendientes.</Text>}
                          </Box>

                          <Box>
                            <Text fontSize="sm" fontWeight="semibold" mb={2}>Conciliar contra cuenta contable</Text>
                            <HStack>
                              <Input size="sm" w="120px" placeholder="Subcuenta" value={subcuenta} onChange={(e) => setSubcuenta(e.target.value)} />
                              <Input size="sm" w="200px" placeholder="Concepto (opcional)" value={concepto} onChange={(e) => setConcepto(e.target.value)} />
                              <Button size="sm" colorScheme="blue" isLoading={enviando} onClick={() => void conciliarCuenta(m.id)}>A cuenta</Button>
                            </HStack>
                            <Text fontSize="xs" color="gray.400" mt={1}>Por defecto 555 (partidas pendientes de aplicación).</Text>
                          </Box>
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
