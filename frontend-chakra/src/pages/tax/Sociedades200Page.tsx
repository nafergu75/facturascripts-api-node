/**
 * Impuestos — Modelo 200 / Impuesto de Sociedades (Chakra). Fase 4 ADR-002.
 * Liquidación (resultado contable → base imponible → cuota) + descarga del
 * fichero TXT (BOE). Datos desde Prisma (asientos del ejercicio).
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
  Tr,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { DatosModelo200, descargarFicheroModelo200, getModelo200 } from '../../api/sociedades200Api';

const eur = (n: number): string => Number(n ?? 0).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });
const ANYO = new Date().getFullYear();

export function Sociedades200Page(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();
  const [ejercicio, setEjercicio] = useState(ANYO);
  const [datos, setDatos] = useState<DatosModelo200 | null>(null);
  const [nif, setNif] = useState('');
  const [cargando, setCargando] = useState(false);

  const err = (e: unknown, fb: string): void => {
    toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || fb });
  };

  const cargar = useCallback(async () => {
    if (!companyId) return;
    setCargando(true);
    try {
      const d = await getModelo200(companyId, ejercicio);
      setDatos(d);
      setNif((prev) => prev || d.nif || '');
    } catch (e) {
      err(e, 'No se pudo calcular el Modelo 200');
      setDatos(null);
    } finally {
      setCargando(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, ejercicio]);

  useEffect(() => { void cargar(); }, [cargar]);

  const descargar = async (): Promise<void> => {
    try {
      await descargarFicheroModelo200(companyId, ejercicio, nif);
    } catch (e) {
      err(e, 'No se pudo descargar el TXT');
    }
  };

  const filas: Array<[string, number, boolean?]> = datos
    ? [
        ['Resultado contable antes de impuestos', datos.resultadoContableAntesImpuestos],
        ['Base imponible previa', datos.baseImponiblePrevia],
        ['Bases negativas compensables (BINs)', -datos.basesNegativasCompensables],
        ['Base imponible', datos.baseImponibleFinal, true],
        [`Cuota íntegra (tipo ${datos.tipoGravamen}%)`, datos.cuotaIntegra],
        ['Deducciones y bonificaciones', -datos.deduccionesBonificaciones],
        ['Pagos fraccionados y retenciones', -datos.pagosFraccionadosRetenciones],
        ['Cuota líquida', datos.cuotaLiquida],
        ['A ingresar / (a devolver)', datos.cuotaADepositarODevolver, true],
      ]
    : [];

  return (
    <Container maxW="4xl" py={8}>
      <Flex justify="space-between" align="center" mb={6} wrap="wrap" gap={3}>
        <Heading size="lg">Modelo 200 · Impuesto de Sociedades</Heading>
        <HStack spacing={3}>
          <Select w="110px" value={ejercicio} onChange={(e) => setEjercicio(Number(e.target.value))}>
            {[ANYO, ANYO - 1, ANYO - 2].map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
          <Input w="160px" placeholder="NIF" value={nif} onChange={(e) => setNif(e.target.value)} />
          <Button colorScheme="blue" variant="outline" onClick={() => void descargar()} isDisabled={!datos}>Descargar TXT</Button>
        </HStack>
      </Flex>

      {cargando ? (
        <HStack color="gray.500" py={8} justify="center"><Spinner size="sm" /><Box>Calculando…</Box></HStack>
      ) : !datos ? (
        <Box textAlign="center" color="gray.400" py={10}>Sin datos para el ejercicio.</Box>
      ) : (
        <>
          <Text color="gray.500" mb={4}>{datos.razonSocial || '(sin razón social)'} · {datos.nif || '(sin NIF)'} · Ejercicio {datos.ejercicio}</Text>
          <Box bg="white" borderWidth="1px" borderRadius="md" overflowX="auto" mb={4}>
            <Table size="sm">
              <Tbody>
                {filas.map(([label, valor, destacar], i) => (
                  <Tr key={i} bg={destacar ? 'blue.50' : undefined}>
                    <Td fontWeight={destacar ? 'bold' : 'normal'}>{label}</Td>
                    <Td isNumeric fontWeight={destacar ? 'bold' : 'normal'} color={valor < 0 ? 'red.500' : undefined}>{eur(valor)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>

          {datos.advertencias?.length > 0 && (
            <Box bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={4}>
              <Text fontWeight="semibold" color="orange.700" mb={2}>⚠️ Revisar antes de presentar</Text>
              {datos.advertencias.map((a, i) => <Text key={i} fontSize="sm" color="orange.800">• {a}</Text>)}
            </Box>
          )}
        </>
      )}
    </Container>
  );
}
