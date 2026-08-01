/**
 * Contabilidad — Cierre de ejercicio (Chakra). Fase 4 ADR-002.
 * Rejilla de 12 meses (estado por periodo, clic alterna abierto→bloqueado→
 * cerrado) + cierre de ejercicio (crea los asientos de regularización/cierre/
 * apertura en Prisma; exige periodos no-abiertos y cuadre de bancos).
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
  Select,
  SimpleGrid,
  Spinner,
  Text,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { EstadoPeriodo, PeriodoContable, cambiarEstadoPeriodo, cerrarEjercicio, listarPeriodos } from '../../api/cierresApi';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const COLOR: Record<EstadoPeriodo, string> = { abierto: 'gray', bloqueado: 'orange', cerrado: 'green' };
const SIGUIENTE: Record<EstadoPeriodo, EstadoPeriodo> = { abierto: 'bloqueado', bloqueado: 'cerrado', cerrado: 'abierto' };
const ANYO = new Date().getFullYear();

export function CierresPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();
  const [ejercicio, setEjercicio] = useState(ANYO);
  const [periodos, setPeriodos] = useState<PeriodoContable[]>([]);
  const [cargando, setCargando] = useState(false);
  const [cerrando, setCerrando] = useState(false);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      setPeriodos(await listarPeriodos(companyId, ejercicio));
    } catch (e) {
      err(e, 'No se pudieron cargar los periodos');
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, ejercicio]);

  useEffect(() => { void cargar(); }, [cargar]);

  const alternar = async (p: PeriodoContable): Promise<void> => {
    const nuevo = SIGUIENTE[p.estado];
    // Optimista
    setPeriodos((prev) => prev.map((x) => (x.mes === p.mes ? { ...x, estado: nuevo } : x)));
    try {
      await cambiarEstadoPeriodo(companyId, ejercicio, p.mes, nuevo);
    } catch (e) {
      err(e, 'No se pudo cambiar el estado');
      void cargar(); // revertir desde el servidor
    }
  };

  const cerrar = async (): Promise<void> => {
    if (!window.confirm(`¿Cerrar el ejercicio ${ejercicio}? Se crearán los asientos de regularización, cierre y apertura. Requiere los periodos no-abiertos y el cuadre de bancos.`)) return;
    setCerrando(true);
    try {
      const r = await cerrarEjercicio(companyId, ejercicio);
      toast({ status: 'success', title: `Ejercicio ${ejercicio} cerrado. Resultado: ${r.resultadoEjercicio.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' })}`, duration: 8000 });
      await cargar();
    } catch (e) {
      err(e, 'No se pudo cerrar el ejercicio');
    } finally {
      setCerrando(false);
    }
  };

  const algunAbierto = periodos.some((p) => p.estado === 'abierto');

  return (
    <Container maxW="4xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Cierre de ejercicio</Heading>
        <Select w="120px" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))}>
          {[ANYO + 1, ANYO, ANYO - 1, ANYO - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </Flex>

      <Text fontSize="sm" color="gray.500" mb={3}>
        Clica un mes para alternar su estado: <Badge colorScheme="gray">abierto</Badge> → <Badge colorScheme="orange">bloqueado</Badge> → <Badge colorScheme="green">cerrado</Badge>.
      </Text>

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Cargando…</Box></HStack>
      ) : (
        <SimpleGrid columns={[2, 3, 4]} spacing={3} mb={6}>
          {periodos.map((p) => (
            <Box
              key={p.mes}
              as="button"
              onClick={() => void alternar(p)}
              borderWidth="1px"
              borderRadius="md"
              p={4}
              textAlign="center"
              _hover={{ shadow: 'md' }}
              bg="white"
            >
              <Text fontWeight="bold" mb={1}>{MESES[p.mes - 1]}</Text>
              <Badge colorScheme={COLOR[p.estado]}>{p.estado}</Badge>
            </Box>
          ))}
        </SimpleGrid>
      )}

      <Box borderTopWidth="1px" pt={4}>
        {algunAbierto && (
          <Text fontSize="sm" color="orange.500" mb={2}>
            ⚠️ Hay meses aún abiertos. El cierre exige todos los periodos bloqueados o cerrados.
          </Text>
        )}
        <Button colorScheme="red" isLoading={cerrando} onClick={() => void cerrar()} isDisabled={periodos.length === 0}>
          Cerrar ejercicio {ejercicio}
        </Button>
      </Box>
    </Container>
  );
}
