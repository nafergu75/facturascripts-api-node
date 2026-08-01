/**
 * Tesorería — Extractos bancarios (Chakra). Fase 3 ADR-002 (Prisma /extractos).
 * Extracto con saldo acumulado por cuenta + totales + descarga CSV + revisión
 * frente a la contabilidad (saldo extracto vs saldo contable 57x).
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
  Select,
  SimpleGrid,
  Spinner,
  Stat,
  StatLabel,
  StatNumber,
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
import { CuentaBancaria, listarCuentas } from '../../api/bancosApi';
import {
  ExtractoBancario,
  RevisionExtractoContable,
  descargarExtractoCsv,
  getExtracto,
  getRevision,
} from '../../api/extractosApi';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

export function ExtractosPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [cuentas, setCuentas] = useState<CuentaBancaria[]>([]);
  const [cuentaId, setCuentaId] = useState('');
  const [saldoInicial, setSaldoInicial] = useState('0');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');

  const [extracto, setExtracto] = useState<ExtractoBancario | null>(null);
  const [revision, setRevision] = useState<RevisionExtractoContable | null>(null);
  const [cargando, setCargando] = useState(false);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  useEffect(() => {
    if (!companyId) return;
    listarCuentas(companyId)
      .then((cs) => {
        setCuentas(cs);
        if (cs.length > 0) setCuentaId((prev) => prev || cs[0].id);
      })
      .catch((e) => err(e, 'No se pudieron cargar las cuentas'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const filtros = useCallback(
    () => ({ desde: desde || undefined, hasta: hasta || undefined, saldoInicial: Number(saldoInicial) || 0 }),
    [desde, hasta, saldoInicial],
  );

  const generar = useCallback(async () => {
    if (!companyId || !cuentaId) return;
    setCargando(true);
    setRevision(null);
    try {
      const ext = await getExtracto(companyId, cuentaId, filtros());
      setExtracto(ext);
    } catch (e) {
      err(e, 'No se pudo generar el extracto');
      setExtracto(null);
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, cuentaId, filtros]);

  // Genera el extracto al elegir cuenta (la primera vez) o al cambiarla.
  useEffect(() => { if (cuentaId) void generar(); }, [cuentaId, generar]);

  const descargar = async (): Promise<void> => {
    try {
      await descargarExtractoCsv(companyId, cuentaId, filtros());
    } catch (e) {
      err(e, 'No se pudo descargar el CSV');
    }
  };

  const revisar = async (): Promise<void> => {
    if (!cuentaId) return;
    const ejercicio = Number((hasta || desde || new Date().toISOString()).slice(0, 4)) || new Date().getFullYear();
    try {
      setRevision(await getRevision(companyId, cuentaId, { ejercicio, desde: desde || undefined, hasta: hasta || undefined }));
    } catch (e) {
      err(e, 'No se pudo revisar contra contabilidad');
    }
  };

  return (
    <Container maxW="7xl" py={8}>
      <Heading size="lg" mb={6}>Extractos bancarios</Heading>

      <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
        <SimpleGrid columns={[1, 2, 4]} spacing={4} alignItems="end">
          <Box>
            <Text fontSize="xs" color="gray.500">Cuenta</Text>
            <Select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} placeholder={cuentas.length ? undefined : 'Sin cuentas'}>
              {cuentas.map((c) => <option key={c.id} value={c.id}>{c.iban} · {c.subcuentaCodigo}</option>)}
            </Select>
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Saldo inicial</Text>
            <Input type="number" value={saldoInicial} onChange={(e) => setSaldoInicial(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Desde</Text>
            <Input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Hasta</Text>
            <Input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
          </Box>
        </SimpleGrid>
        <HStack mt={4} spacing={3}>
          <Button colorScheme="blue" onClick={() => void generar()} isDisabled={!cuentaId}>Generar extracto</Button>
          <Button variant="outline" onClick={() => void descargar()} isDisabled={!extracto}>Descargar CSV</Button>
          <Button variant="outline" colorScheme="purple" onClick={() => void revisar()} isDisabled={!cuentaId}>Revisión contable</Button>
        </HStack>
      </Box>

      {revision && (
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
          <Flex justify="space-between" align="center" mb={3}>
            <Heading size="sm">Revisión vs contabilidad (subcuenta {revision.subcuentaCodigo})</Heading>
            <Badge colorScheme={revision.cuadra ? 'green' : 'red'}>{revision.cuadra ? 'Cuadra' : 'Descuadre'}</Badge>
          </Flex>
          <SimpleGrid columns={[2, 4]} spacing={4}>
            <Stat><StatLabel>Saldo extracto</StatLabel><StatNumber fontSize="md">{eur(revision.saldoExtracto)}</StatNumber></Stat>
            <Stat><StatLabel>Saldo contable</StatLabel><StatNumber fontSize="md">{eur(revision.saldoContable)}</StatNumber></Stat>
            <Stat><StatLabel>Diferencia</StatLabel><StatNumber fontSize="md" color={revision.cuadra ? 'green.600' : 'red.500'}>{eur(revision.diferencia)}</StatNumber></Stat>
            <Stat><StatLabel>Sin conciliar</StatLabel><StatNumber fontSize="md">{revision.movimientosSinConciliar}</StatNumber></Stat>
          </SimpleGrid>
        </Box>
      )}

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : !extracto ? (
        <Box textAlign="center" color="gray.400" py={10}>Elige una cuenta y genera el extracto.</Box>
      ) : (
        <>
          <SimpleGrid columns={[2, 4]} spacing={4} mb={4}>
            <Stat><StatLabel>Saldo inicial</StatLabel><StatNumber fontSize="md">{eur(extracto.saldoInicial)}</StatNumber></Stat>
            <Stat><StatLabel>Total cargos</StatLabel><StatNumber fontSize="md" color="red.500">{eur(extracto.totalCargos)}</StatNumber></Stat>
            <Stat><StatLabel>Total abonos</StatLabel><StatNumber fontSize="md" color="green.600">{eur(extracto.totalAbonos)}</StatNumber></Stat>
            <Stat><StatLabel>Saldo final</StatLabel><StatNumber fontSize="md" color="blue.600">{eur(extracto.saldoFinal)}</StatNumber></Stat>
          </SimpleGrid>

          {extracto.lineas.length === 0 ? (
            <Box textAlign="center" color="gray.400" py={8}>Sin movimientos en el rango.</Box>
          ) : (
            <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
              <Table size="sm">
                <Thead>
                  <Tr><Th>Fecha</Th><Th>Concepto</Th><Th isNumeric>Cargo</Th><Th isNumeric>Abono</Th><Th isNumeric>Saldo</Th><Th>Concil.</Th></Tr>
                </Thead>
                <Tbody>
                  {extracto.lineas.map((l, i) => (
                    <Tr key={i}>
                      <Td>{String(l.fecha).slice(0, 10)}</Td>
                      <Td>{l.concepto}</Td>
                      <Td isNumeric color="red.500">{l.cargo ? eur(l.cargo) : ''}</Td>
                      <Td isNumeric color="green.600">{l.abono ? eur(l.abono) : ''}</Td>
                      <Td isNumeric fontWeight="semibold">{eur(l.saldoAcumulado)}</Td>
                      <Td><Badge colorScheme={l.conciliado ? 'green' : 'orange'}>{l.conciliado ? 'Sí' : 'No'}</Badge></Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </Box>
          )}
        </>
      )}
    </Container>
  );
}
