/**
 * Alta de factura de ingreso (Chakra) — Fase 2 Slice B.
 * Sobre el módulo canónico Prisma /invoices (sin FacturaScripts).
 *
 * Cliente: existente (de facturas previas -> customer.id, no duplica) o nuevo
 * (nombre+NIF -> customer.nuevo). Líneas dinámicas con totales en vivo que
 * replican el cálculo del backend (base = cant×precio×(1-dto%); total =
 * base + IVA − retención).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Button,
  Container,
  Divider,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  Select,
  SimpleGrid,
  Stat,
  StatLabel,
  StatNumber,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Text,
  useToast,
} from '@chakra-ui/react';
import { useCompanyId } from '../../hooks/useCompanyId';
import { CrearFacturaBody, crearFactura, listarFacturas } from '../../api/invoicesApi';

const NUEVO = '__nuevo__';
const IVAS = [21, 10, 4, 0];
const IRPFS = [0, 7, 15, 19];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const eur = (n: number): string => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

interface LineaForm {
  descripcion: string;
  cantidad: string;
  precioUnitario: string;
  descuentoPorcentaje: string;
  tipoIva: string;
  tipoRetencion: string;
}

const LINEA_VACIA: LineaForm = { descripcion: '', cantidad: '1', precioUnitario: '', descuentoPorcentaje: '0', tipoIva: '21', tipoRetencion: '0' };

const hoy = (): string => new Date().toISOString().slice(0, 10);

export function NuevaFacturaPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();
  const navigate = useNavigate();

  const [clientes, setClientes] = useState<Array<{ id: string; nombre: string }>>([]);
  const [clienteSel, setClienteSel] = useState<string>(NUEVO);
  const [nuevoNombre, setNuevoNombre] = useState('');
  const [nuevoNif, setNuevoNif] = useState('');
  const [nuevoEmail, setNuevoEmail] = useState('');

  const [serie, setSerie] = useState(String(new Date().getFullYear()));
  const [fechaEmision, setFechaEmision] = useState(hoy());
  const [fechaVencimiento, setFechaVencimiento] = useState('');
  const [observaciones, setObservaciones] = useState('');

  const [lineas, setLineas] = useState<LineaForm[]>([{ ...LINEA_VACIA }]);
  const [guardando, setGuardando] = useState(false);

  // Clientes existentes a partir de las facturas previas (sin endpoint extra).
  useEffect(() => {
    if (!companyId) return;
    listarFacturas(companyId, { take: 100 })
      .then((r) => {
        const map = new Map<string, string>();
        r.items.forEach((f) => { if (f.customerId) map.set(f.customerId, f.customerNombre ?? f.customerId); });
        const arr = [...map.entries()].map(([id, nombre]) => ({ id, nombre }));
        setClientes(arr);
        if (arr.length > 0) setClienteSel(arr[0].id);
      })
      .catch(() => undefined);
  }, [companyId]);

  const totales = useMemo(() => {
    let base = 0;
    let iva = 0;
    let ret = 0;
    for (const l of lineas) {
      const cant = Number(l.cantidad) || 0;
      const precio = Number(l.precioUnitario) || 0;
      const dto = Number(l.descuentoPorcentaje) || 0;
      const baseLine = round2(cant * precio * (1 - dto / 100));
      base = round2(base + baseLine);
      iva = round2(iva + baseLine * (Number(l.tipoIva) || 0) / 100);
      ret = round2(ret + baseLine * (Number(l.tipoRetencion) || 0) / 100);
    }
    return { base, iva: round2(iva), ret: round2(ret), total: round2(base + iva - ret) };
  }, [lineas]);

  const setLinea = (i: number, campo: keyof LineaForm, valor: string): void => {
    setLineas((prev) => prev.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));
  };
  const addLinea = (): void => setLineas((prev) => [...prev, { ...LINEA_VACIA }]);
  const quitarLinea = (i: number): void => setLineas((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const guardar = async (): Promise<void> => {
    const lineasValidas = lineas.filter((l) => l.descripcion.trim() && Number(l.precioUnitario) > 0);
    if (lineasValidas.length === 0) {
      toast({ status: 'warning', title: 'Añade al menos una línea con descripción y precio.' });
      return;
    }
    let customer: CrearFacturaBody['customer'];
    if (clienteSel === NUEVO) {
      if (!nuevoNombre.trim() || !nuevoNif.trim()) {
        toast({ status: 'warning', title: 'Para un cliente nuevo, indica nombre y NIF.' });
        return;
      }
      customer = { nuevo: { nombreFiscal: nuevoNombre.trim(), nifCif: nuevoNif.trim(), email: nuevoEmail.trim() || undefined } };
    } else {
      customer = { id: clienteSel };
    }

    const body: CrearFacturaBody = {
      customer,
      serie: serie.trim() || String(new Date().getFullYear()),
      fechaEmision,
      fechaVencimiento: fechaVencimiento || undefined,
      observaciones: observaciones.trim() || undefined,
      lineas: lineasValidas.map((l) => ({
        descripcion: l.descripcion.trim(),
        cantidad: Number(l.cantidad) || 1,
        precioUnitario: Number(l.precioUnitario) || 0,
        descuentoPorcentaje: Number(l.descuentoPorcentaje) || 0,
        tipoIva: Number(l.tipoIva) || 0,
        tipoRetencion: Number(l.tipoRetencion) || 0,
      })),
    };

    setGuardando(true);
    try {
      const f = await crearFactura(companyId, body);
      toast({ status: 'success', title: `Factura ${f.numeroCompleto ?? ''} creada.`.trim() });
      navigate('/sales/facturas');
    } catch (e) {
      toast({ status: 'error', title: e instanceof Error ? e.message : (e as { message?: string })?.message || 'No se pudo crear la factura' });
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Container maxW="6xl" py={8}>
      <Flex justify="space-between" align="center" mb={6}>
        <Heading size="lg">Nueva factura de ingreso</Heading>
        <Button variant="ghost" onClick={() => navigate('/sales/facturas')}>← Volver</Button>
      </Flex>

      {/* Cliente */}
      <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
        <Text fontWeight="semibold" mb={3}>Cliente</Text>
        <Select maxW="360px" mb={3} value={clienteSel} onChange={(e) => setClienteSel(e.target.value)}>
          <option value={NUEVO}>➕ Nuevo cliente…</option>
          {clientes.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </Select>
        {clienteSel === NUEVO && (
          <HStack spacing={3} wrap="wrap">
            <Input maxW="240px" placeholder="Nombre / razón social *" value={nuevoNombre} onChange={(e) => setNuevoNombre(e.target.value)} />
            <Input maxW="160px" placeholder="NIF *" value={nuevoNif} onChange={(e) => setNuevoNif(e.target.value)} />
            <Input maxW="220px" placeholder="Email" value={nuevoEmail} onChange={(e) => setNuevoEmail(e.target.value)} />
          </HStack>
        )}
      </Box>

      {/* Datos de cabecera */}
      <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4}>
        <SimpleGrid columns={[1, 2, 4]} spacing={4}>
          <Box>
            <Text fontSize="xs" color="gray.500">Serie</Text>
            <Input value={serie} onChange={(e) => setSerie(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Fecha emisión</Text>
            <Input type="date" value={fechaEmision} onChange={(e) => setFechaEmision(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Vencimiento (opcional)</Text>
            <Input type="date" value={fechaVencimiento} onChange={(e) => setFechaVencimiento(e.target.value)} />
          </Box>
          <Box>
            <Text fontSize="xs" color="gray.500">Observaciones</Text>
            <Input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} />
          </Box>
        </SimpleGrid>
      </Box>

      {/* Líneas */}
      <Box bg="white" borderWidth="1px" borderRadius="md" p={4} mb={4} overflowX="auto">
        <Flex justify="space-between" align="center" mb={3}>
          <Text fontWeight="semibold">Líneas</Text>
          <Button size="sm" onClick={addLinea}>+ Añadir línea</Button>
        </Flex>
        <Table size="sm">
          <Thead>
            <Tr>
              <Th>Descripción</Th>
              <Th isNumeric>Cantidad</Th>
              <Th isNumeric>Precio</Th>
              <Th isNumeric>Dto %</Th>
              <Th isNumeric>IVA %</Th>
              <Th isNumeric>IRPF %</Th>
              <Th />
            </Tr>
          </Thead>
          <Tbody>
            {lineas.map((l, i) => (
              <Tr key={i}>
                <Td minW="220px"><Input size="sm" value={l.descripcion} onChange={(e) => setLinea(i, 'descripcion', e.target.value)} /></Td>
                <Td><Input size="sm" type="number" w="80px" value={l.cantidad} onChange={(e) => setLinea(i, 'cantidad', e.target.value)} /></Td>
                <Td><Input size="sm" type="number" w="100px" value={l.precioUnitario} onChange={(e) => setLinea(i, 'precioUnitario', e.target.value)} /></Td>
                <Td><Input size="sm" type="number" w="80px" value={l.descuentoPorcentaje} onChange={(e) => setLinea(i, 'descuentoPorcentaje', e.target.value)} /></Td>
                <Td>
                  <Select size="sm" w="90px" value={l.tipoIva} onChange={(e) => setLinea(i, 'tipoIva', e.target.value)}>
                    {IVAS.map((v) => <option key={v} value={v}>{v}%</option>)}
                  </Select>
                </Td>
                <Td>
                  <Select size="sm" w="90px" value={l.tipoRetencion} onChange={(e) => setLinea(i, 'tipoRetencion', e.target.value)}>
                    {IRPFS.map((v) => <option key={v} value={v}>{v}%</option>)}
                  </Select>
                </Td>
                <Td>
                  <IconButton aria-label="Quitar línea" size="xs" variant="ghost" colorScheme="red" icon={<span>✕</span>} isDisabled={lineas.length === 1} onClick={() => quitarLinea(i)} />
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Box>

      {/* Totales + guardar */}
      <Box bg="white" borderWidth="1px" borderRadius="md" p={4}>
        <SimpleGrid columns={[2, 4]} spacing={4} mb={4}>
          <Stat><StatLabel>Base</StatLabel><StatNumber fontSize="lg">{eur(totales.base)}</StatNumber></Stat>
          <Stat><StatLabel>IVA</StatLabel><StatNumber fontSize="lg">{eur(totales.iva)}</StatNumber></Stat>
          <Stat><StatLabel>Retención</StatLabel><StatNumber fontSize="lg" color="red.500">−{eur(totales.ret)}</StatNumber></Stat>
          <Stat><StatLabel>Total</StatLabel><StatNumber fontSize="lg" color="blue.600">{eur(totales.total)}</StatNumber></Stat>
        </SimpleGrid>
        <Divider mb={4} />
        <Flex justify="flex-end">
          <Button colorScheme="blue" isLoading={guardando} onClick={() => void guardar()}>Crear factura</Button>
        </Flex>
      </Box>
    </Container>
  );
}
