/**
 * Contabilidad — Plan contable (Chakra). Fase 4 ADR-002.
 * Subcuentas de la empresa + alta manual (cuenta base + código + nombre) y
 * alta rápida de gasto (elige cuenta de gasto y se genera el código correlativo).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
  CuentaBase,
  SubcuentaEmpresa,
  crearSubcuenta,
  crearSubcuentaGasto,
  listarCuentasBase,
  listarSubcuentas,
} from '../../api/planContableApi';

export function PlanContablePage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();

  const [cuentasBase, setCuentasBase] = useState<CuentaBase[]>([]);
  const [subcuentas, setSubcuentas] = useState<SubcuentaEmpresa[]>([]);
  const [cargando, setCargando] = useState(false);

  // Alta rápida de gasto
  const [gastoBase, setGastoBase] = useState('');
  const [gastoNombre, setGastoNombre] = useState('');
  // Alta manual
  const [manualBase, setManualBase] = useState('');
  const [manualCodigo, setManualCodigo] = useState('');
  const [manualNombre, setManualNombre] = useState('');

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cuentasGasto = useMemo(() => cuentasBase.filter((c) => c.tipo === 'gasto'), [cuentasBase]);
  const nombreBase = useCallback(
    (cod: string) => cuentasBase.find((c) => c.codigo === cod)?.nombre ?? cod,
    [cuentasBase],
  );

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const [base, subs] = await Promise.all([listarCuentasBase(), listarSubcuentas(companyId)]);
      setCuentasBase(base);
      setSubcuentas(subs);
    } catch (e) {
      err(e, 'No se pudo cargar el plan contable');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => { void cargar(); }, [cargar]);

  const altaGasto = async (): Promise<void> => {
    if (!gastoBase || !gastoNombre.trim()) {
      toast({ status: 'warning', title: 'Elige la cuenta de gasto y pon un nombre.' });
      return;
    }
    try {
      const s = await crearSubcuentaGasto(companyId, { cuentaBaseCodigo: gastoBase, nombre: gastoNombre.trim() });
      toast({ status: 'success', title: `Subcuenta ${s.codigo} creada.` });
      setGastoNombre('');
      await cargar();
    } catch (e) {
      err(e, 'No se pudo crear la subcuenta de gasto');
    }
  };

  const altaManual = async (): Promise<void> => {
    if (!manualBase || !manualCodigo.trim()) {
      toast({ status: 'warning', title: 'Cuenta base y código son obligatorios.' });
      return;
    }
    try {
      const s = await crearSubcuenta(companyId, { codigo: manualCodigo.trim(), nombre: manualNombre.trim(), cuentaBaseCodigo: manualBase });
      toast({ status: 'success', title: `Subcuenta ${s.codigo} creada.` });
      setManualCodigo('');
      setManualNombre('');
      await cargar();
    } catch (e) {
      err(e, 'No se pudo crear la subcuenta');
    }
  };

  return (
    <Container maxW="6xl" py={8}>
      <Heading size="lg" mb={6}>Plan contable</Heading>

      <SimpleGrid columns={[1, 2]} spacing={4} mb={6}>
        <Box bg="white" borderWidth="1px" borderRadius="md" p={4}>
          <Text fontWeight="semibold" mb={3}>⚡ Alta rápida de gasto</Text>
          <Text fontSize="xs" color="gray.500" mb={2}>Elige la cuenta de gasto; el código correlativo se genera solo.</Text>
          <HStack spacing={3} wrap="wrap">
            <Select maxW="280px" placeholder="Cuenta de gasto…" value={gastoBase} onChange={(e) => setGastoBase(e.target.value)}>
              {cuentasGasto.map((c) => <option key={c.codigo} value={c.codigo}>{c.codigo} · {c.nombre}</option>)}
            </Select>
            <Input maxW="200px" placeholder="Nombre (ej. Luz oficina)" value={gastoNombre} onChange={(e) => setGastoNombre(e.target.value)} />
            <Button colorScheme="blue" onClick={() => void altaGasto()}>Crear</Button>
          </HStack>
        </Box>

        <Box bg="white" borderWidth="1px" borderRadius="md" p={4}>
          <Text fontWeight="semibold" mb={3}>Alta manual</Text>
          <Text fontSize="xs" color="gray.500" mb={2}>Cuenta base + código completo de subcuenta + nombre.</Text>
          <HStack spacing={3} wrap="wrap">
            <Select maxW="200px" placeholder="Cuenta base…" value={manualBase} onChange={(e) => setManualBase(e.target.value)}>
              {cuentasBase.map((c) => <option key={c.codigo} value={c.codigo}>{c.codigo} · {c.nombre}</option>)}
            </Select>
            <Input maxW="140px" placeholder="Código" value={manualCodigo} onChange={(e) => setManualCodigo(e.target.value)} />
            <Input maxW="180px" placeholder="Nombre" value={manualNombre} onChange={(e) => setManualNombre(e.target.value)} />
            <Button colorScheme="blue" onClick={() => void altaManual()}>Crear</Button>
          </HStack>
        </Box>
      </SimpleGrid>

      <Heading size="sm" mb={3}>Subcuentas de la empresa ({subcuentas.length})</Heading>
      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : subcuentas.length === 0 ? (
        <Box textAlign="center" color="gray.400" py={10}>Aún no hay subcuentas propias. Crea una con el alta rápida.</Box>
      ) : (
        <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto">
          <Table size="sm">
            <Thead>
              <Tr><Th>Código</Th><Th>Nombre</Th><Th>Cuenta base</Th><Th>Estado</Th></Tr>
            </Thead>
            <Tbody>
              {subcuentas.map((s) => (
                <Tr key={s.id}>
                  <Td fontWeight="bold">{s.codigo}</Td>
                  <Td>{s.nombre}</Td>
                  <Td>{s.cuentaBaseCodigo} · {nombreBase(s.cuentaBaseCodigo)}</Td>
                  <Td><Badge colorScheme={s.activa ? 'green' : 'gray'}>{s.activa ? 'Activa' : 'Inactiva'}</Badge></Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Box>
      )}
    </Container>
  );
}
