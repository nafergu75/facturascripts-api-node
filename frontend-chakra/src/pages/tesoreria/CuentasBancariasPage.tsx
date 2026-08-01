/**
 * Tesorería — Cuentas bancarias (Chakra). Fase 3 de la migración ADR-002.
 * Módulo Prisma /bancos (sin FacturaScripts): cuentas + movimientos + importación
 * de extracto CSV.
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
  Textarea,
  Th,
  Thead,
  Tr,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import {
  CuentaBancaria,
  MovimientoBancario,
  crearCuenta,
  importarCsv,
  listarCuentas,
  listarMovimientos,
} from '../../api/bancosApi';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
// OJO: el parser del backend separa por ';' Y ',', así que los importes deben ir
// con punto decimal (1500.00), no coma. TODO backend: soportar coma decimal.
const CSV_EJEMPLO = '2026-06-01;1500.00;Cobro cliente;REF123\n2026-06-03;-89.90;Pago suministro';

export function CuentasBancariasPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [cuentas, setCuentas] = useState<CuentaBancaria[]>([]);
  const [cargandoCuentas, setCargandoCuentas] = useState(false);
  const [seleccionada, setSeleccionada] = useState<string | null>(null);

  const [alta, setAlta] = useState(false);
  const [nueva, setNueva] = useState({ iban: '', bancoNombre: '', subcuentaCodigo: '' });

  const [movs, setMovs] = useState<MovimientoBancario[]>([]);
  const [cargandoMovs, setCargandoMovs] = useState(false);
  const [csv, setCsv] = useState('');
  const [importando, setImportando] = useState(false);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargarCuentas = useCallback(async () => {
    if (!companyId) return;
    setCargandoCuentas(true);
    try {
      const data = await listarCuentas(companyId);
      setCuentas(data);
      if (data.length > 0 && !seleccionada) setSeleccionada(data[0].id);
    } catch (e) {
      err(e, 'No se pudieron cargar las cuentas');
    } finally {
      setCargandoCuentas(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const cargarMovs = useCallback(async () => {
    if (!companyId || !seleccionada) {
      setMovs([]);
      return;
    }
    setCargandoMovs(true);
    try {
      setMovs(await listarMovimientos(companyId, seleccionada));
    } catch (e) {
      err(e, 'No se pudieron cargar los movimientos');
    } finally {
      setCargandoMovs(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, seleccionada]);

  useEffect(() => { void cargarCuentas(); }, [cargarCuentas]);
  useEffect(() => { void cargarMovs(); }, [cargarMovs]);

  const crear = async (): Promise<void> => {
    if (!nueva.iban.trim() || !nueva.subcuentaCodigo.trim()) {
      toast({ status: 'warning', title: 'IBAN y subcuenta (572xxx) son obligatorios.' });
      return;
    }
    try {
      const c = await crearCuenta(companyId, { iban: nueva.iban.trim(), subcuentaCodigo: nueva.subcuentaCodigo.trim(), bancoNombre: nueva.bancoNombre.trim() || undefined });
      toast({ status: 'success', title: 'Cuenta creada.' });
      setAlta(false);
      setNueva({ iban: '', bancoNombre: '', subcuentaCodigo: '' });
      await cargarCuentas();
      setSeleccionada(c.id);
    } catch (e) {
      err(e, 'No se pudo crear la cuenta');
    }
  };

  const importar = async (): Promise<void> => {
    if (!seleccionada || !csv.trim()) return;
    setImportando(true);
    try {
      const r = await importarCsv(companyId, seleccionada, csv);
      toast({ status: 'success', title: `${r.importados} movimiento(s) importado(s).` });
      setCsv('');
      await cargarMovs();
    } catch (e) {
      err(e, 'No se pudo importar el CSV');
    } finally {
      setImportando(false);
    }
  };

  const cuentaSel = cuentas.find((c) => c.id === seleccionada);

  return (
    <Container maxW="7xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Cuentas bancarias</Heading>
        <Button colorScheme="blue" onClick={() => setAlta((v) => !v)}>{alta ? 'Cancelar' : '+ Nueva cuenta'}</Button>
      </Flex>

      {alta && (
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
          <HStack spacing={3} wrap="wrap">
            <Input maxW="280px" placeholder="IBAN *" value={nueva.iban} onChange={(e) => setNueva({ ...nueva, iban: e.target.value })} />
            <Input maxW="200px" placeholder="Banco (opcional)" value={nueva.bancoNombre} onChange={(e) => setNueva({ ...nueva, bancoNombre: e.target.value })} />
            <Input maxW="160px" placeholder="Subcuenta 572xxx *" value={nueva.subcuentaCodigo} onChange={(e) => setNueva({ ...nueva, subcuentaCodigo: e.target.value })} />
            <Button colorScheme="blue" onClick={() => void crear()}>Guardar</Button>
          </HStack>
        </Box>
      )}

      {cargandoCuentas ? (
        <HStack color="gray.500" py={6} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : cuentas.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>Aún no hay cuentas bancarias. Crea una con su subcuenta 572xxx.</Box>
      ) : (
        <>
          <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto" mb={6}>
            <Table size="sm">
              <Thead>
                <Tr><Th>IBAN</Th><Th>Banco</Th><Th>Subcuenta</Th><Th>Estado</Th><Th /></Tr>
              </Thead>
              <Tbody>
                {cuentas.map((c) => (
                  <Tr key={c.id} bg={c.id === seleccionada ? 'blue.50' : undefined}>
                    <Td fontWeight="semibold">{c.iban}</Td>
                    <Td>{c.bancoNombre || <Box as="span" color="gray.300">—</Box>}</Td>
                    <Td>{c.subcuentaCodigo}</Td>
                    <Td><Badge colorScheme={c.activa ? 'green' : 'gray'}>{c.activa ? 'Activa' : 'Inactiva'}</Badge></Td>
                    <Td><Button size="xs" variant={c.id === seleccionada ? 'solid' : 'outline'} colorScheme="blue" onClick={() => setSeleccionada(c.id)}>Ver movimientos</Button></Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>

          {cuentaSel && (
            <Box bg="white" borderWidth="1px" borderRadius="md" p={4}>
              <Heading size="sm" mb={3}>Movimientos · {cuentaSel.iban}</Heading>

              <Box mb={4}>
                <Text fontSize="xs" color="gray.500" mb={1}>Importar extracto CSV (fecha;importe;concepto;referencia)</Text>
                <Textarea rows={3} fontFamily="mono" fontSize="sm" placeholder={CSV_EJEMPLO} value={csv} onChange={(e) => setCsv(e.target.value)} />
                <Button mt={2} size="sm" colorScheme="blue" isLoading={importando} isDisabled={!csv.trim()} onClick={() => void importar()}>Importar movimientos</Button>
              </Box>

              {cargandoMovs ? (
                <HStack color="gray.500" py={4}><Spinner size="sm" /><Box>Cargando movimientos…</Box></HStack>
              ) : movs.length === 0 ? (
                <Box textAlign="center" color="gray.400" py={6}>Sin movimientos. Importa un extracto CSV.</Box>
              ) : (
                <Box overflowX="auto">
                  <Table size="sm">
                    <Thead>
                      <Tr><Th>Fecha</Th><Th>Concepto</Th><Th isNumeric>Importe</Th><Th>Conciliado</Th></Tr>
                    </Thead>
                    <Tbody>
                      {movs.map((m) => (
                        <Tr key={m.id}>
                          <Td>{String(m.fecha).slice(0, 10)}</Td>
                          <Td>{m.concepto}</Td>
                          <Td isNumeric color={m.importe < 0 ? 'red.500' : 'green.600'} fontWeight="semibold">{eur(m.importe)}</Td>
                          <Td><Badge colorScheme={m.conciliado ? 'green' : 'orange'}>{m.conciliado ? 'Sí' : 'Pendiente'}</Badge></Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                </Box>
              )}
            </Box>
          )}
        </>
      )}
    </Container>
  );
}
