/**
 * Página: Lector de Facturas
 * Ruta: /lector
 *
 * Modo real (API disponible): sube XML/PDF/imagen, lista documentos pendientes
 * reales y permite verificar/rechazar contra el backend real de income-reader.
 *
 * Modo demo (API caída, forzado por dev-toggle, o forzado por ?demo=1 en la URL):
 * todo el flujo —subida, "lectura OCR", edición, creación de factura— se simula
 * en el navegador. Ninguna acción de demo llama a la API real. La lógica de
 * detección y simulación vive en demoMode.ts; este archivo solo la consume.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Button,
  Container,
  Divider,
  Grid,
  GridItem,
  Heading,
  HStack,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalOverlay,
  NumberInput,
  NumberInputField,
  Spinner,
  Switch,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tooltip,
  Tr,
  useDisclosure,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { QuestionOutlineIcon } from '@chakra-ui/icons';
import { useCompanyId } from '../../hooks/useCompanyId';
import { HelpTooltip } from '../../components/help/HelpTooltip';
import { getHelpSnippet } from '../help/helpData';
import {
  AsientoPreview,
  DemoMode,
  FacturaLeidaDemo,
  demoFacturasIniciales,
  generarAsientoPreview,
  isDemoEnabled,
  repetirSimulacion,
  resolveDemoModeFromUrl,
  simulateOcrResult,
} from './demoMode';
import {
  checkLectorHealth,
  getDocumentDetail,
  IncomeReaderDocument,
  listPendingDocuments,
  ParsedInvoiceData,
  rejectDocument,
  uploadDocument,
  verifyDocument,
} from '../../api/incomeReaderApi';

type ApiHealthStatus = 'CHECKING' | 'OK' | 'DOWN';

const fmtCurrency = (n: number): string => n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

function Ayuda({ texto }: { texto: string }) {
  return (
    <Tooltip label={texto} hasArrow placement="top" fontSize="xs">
      <IconButton
        aria-label="Ayuda"
        icon={<QuestionOutlineIcon />}
        size="xs"
        variant="ghost"
        color="gray.400"
      />
    </Tooltip>
  );
}

export function LectorPage(): React.ReactElement {
  const companyId = useCompanyId();
  const toast = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [apiHealthStatus, setApiHealthStatus] = useState<ApiHealthStatus>('CHECKING');
  // Override de modo: null = sin override (AUTO). Se siembra una vez desde la URL
  // (?demo=1 / ?demo=0); el toggle de dev puede cambiarlo despues en runtime.
  const [modeOverride, setModeOverride] = useState<DemoMode | null>(() => resolveDemoModeFromUrl());
  const effectiveMode: DemoMode = modeOverride ?? 'AUTO';
  const isDemo = isDemoEnabled(effectiveMode, apiHealthStatus);

  // --- Estado modo real ---
  const [documentos, setDocumentos] = useState<IncomeReaderDocument[]>([]);
  const [loadingLista, setLoadingLista] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<IncomeReaderDocument | null>(null);
  const [loadingDetalle, setLoadingDetalle] = useState(false);
  const [accionando, setAccionando] = useState(false);

  // --- Estado modo demo ---
  const [historialDemo, setHistorialDemo] = useState<FacturaLeidaDemo[]>(demoFacturasIniciales);
  const [selectedDemoId, setSelectedDemoId] = useState<string | null>(null);
  const selectedDemo = historialDemo.find((f) => f.id === selectedDemoId) ?? null;
  const intentoRef = useRef(0);

  const [subiendo, setSubiendo] = useState(false);
  const confirmModal = useDisclosure();
  const [confirmTipo, setConfirmTipo] = useState<'ingreso' | 'gasto' | null>(null);
  const asientoPreview: AsientoPreview | null = useMemo(
    () => (selectedDemo && confirmTipo ? generarAsientoPreview(selectedDemo, confirmTipo) : null),
    [selectedDemo, confirmTipo],
  );

  const cargarPendientes = useCallback(async () => {
    if (!companyId) return;
    setLoadingLista(true);
    try {
      const res = await listPendingDocuments(companyId);
      setDocumentos(res.documents);
    } catch {
      setDocumentos([]);
    } finally {
      setLoadingLista(false);
    }
  }, [companyId]);

  // Health-check al montar: decide AUTO. Si el modo esta FORZADO a demo, no hacemos
  // NINGUNA llamada al backend desde /lector (ni siquiera el ping de salud).
  useEffect(() => {
    if (effectiveMode === 'FORCED') {
      setApiHealthStatus('DOWN');
      return;
    }
    let cancelado = false;
    checkLectorHealth(companyId).then((ok) => {
      if (cancelado) return;
      setApiHealthStatus(ok ? 'OK' : 'DOWN');
    });
    return () => {
      cancelado = true;
    };
  }, [companyId, effectiveMode]);

  useEffect(() => {
    if (!isDemo && apiHealthStatus === 'OK') {
      cargarPendientes();
    }
  }, [isDemo, apiHealthStatus, cargarPendientes]);

  // --- Acciones modo real (sin cambios de comportamiento) ---
  async function handleSelectDoc(id: string) {
    setSelectedDemoId(null);
    setLoadingDetalle(true);
    try {
      const res = await getDocumentDetail(companyId, id);
      setSelectedDoc(res.document);
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message || 'No se pudo cargar el documento', status: 'error', duration: 4000 });
    } finally {
      setLoadingDetalle(false);
    }
  }

  async function handleVerify() {
    if (!selectedDoc) return;
    setAccionando(true);
    try {
      await verifyDocument(companyId, selectedDoc.id);
      toast({ title: 'Factura creada', description: 'Se ha creado la factura de ingreso en contabilidad.', status: 'success', duration: 4000 });
      setSelectedDoc(null);
      cargarPendientes();
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message || 'No se pudo verificar el documento', status: 'error', duration: 5000 });
    } finally {
      setAccionando(false);
    }
  }

  async function handleReject() {
    if (!selectedDoc) return;
    setAccionando(true);
    try {
      await rejectDocument(companyId, selectedDoc.id);
      toast({ title: 'Documento rechazado', status: 'info', duration: 3000 });
      setSelectedDoc(null);
      cargarPendientes();
    } catch (err: any) {
      toast({ title: 'Error', description: err?.message || 'No se pudo rechazar el documento', status: 'error', duration: 5000 });
    } finally {
      setAccionando(false);
    }
  }

  // --- Subida: bifurca por modo, sin tocar el flujo real existente ---
  async function handleUpload(file: File) {
    if (isDemo) {
      const leida = simulateOcrResult(file, intentoRef.current++);
      setHistorialDemo((prev) => [leida, ...prev]);
      setSelectedDemoId(leida.id);
      setSelectedDoc(null);
      toast({
        title: 'Lectura demo completada',
        description: `Patrón detectado: ${leida.patronLabel}`,
        status: 'success',
        duration: 4000,
      });
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setSubiendo(true);
    try {
      await uploadDocument(companyId, file);
      toast({ title: 'Archivo subido', description: 'Procesando… aparecerá en la lista cuando esté listo.', status: 'success', duration: 4000 });
      setTimeout(cargarPendientes, 2500);
    } catch (err: any) {
      toast({ title: 'Error al subir', description: err?.message || 'No se pudo subir el archivo', status: 'error', duration: 5000 });
    } finally {
      setSubiendo(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  // --- Acciones modo demo ---
  function handleSelectDemo(id: string) {
    setSelectedDemoId(id);
    setSelectedDoc(null);
  }

  function actualizarCampoDemo(id: string, patch: Partial<FacturaLeidaDemo>) {
    setHistorialDemo((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        // Si el patch trae su propio estado (p.ej. al confirmar creación), respetarlo.
        // Si no, es una edición de campo: pasa a EDITADA salvo que ya estuviera CREADA.
        const estado = patch.estado ?? (f.estado === 'CREADA' ? f.estado : 'EDITADA');
        return { ...f, ...patch, estado };
      }),
    );
  }

  function handleRepetir(id: string) {
    const factura = historialDemo.find((f) => f.id === id);
    if (!factura) return;
    const nueva = repetirSimulacion(factura, intentoRef.current++);
    setHistorialDemo((prev) => prev.map((f) => (f.id === id ? { ...nueva, id: f.id } : f)));
    toast({ title: 'Simulación repetida', description: `Nuevo patrón: ${nueva.patronLabel}`, status: 'info', duration: 3000 });
  }

  function handleEliminarDemo(id: string) {
    setHistorialDemo((prev) => prev.filter((f) => f.id !== id));
    if (selectedDemoId === id) setSelectedDemoId(null);
  }

  function handleAbrirConfirmacion(tipo: 'ingreso' | 'gasto') {
    setConfirmTipo(tipo);
    confirmModal.onOpen();
  }

  function handleConfirmarCreacion() {
    if (!selectedDemo || !confirmTipo) return;
    actualizarCampoDemo(selectedDemo.id, { estado: 'CREADA', creadaComo: confirmTipo });
    confirmModal.onClose();
    toast({
      title: 'Factura simulada creada',
      description: `En una empresa real, ahora se crearía la factura de ${confirmTipo} y se lanzaría el motor contable. En esta demo, solo estás viendo el resultado.`,
      status: 'success',
      duration: 6000,
      isClosable: true,
    });
  }

  return (
    <Container maxW="6xl" py={8}>
      <VStack align="stretch" spacing={6}>
        {import.meta.env.DEV && (
          <HStack justify="flex-end" spacing={2} opacity={0.7}>
            <Text fontSize="xs" color="gray.500">Forzar modo demo (solo dev)</Text>
            <Switch
              size="sm"
              isChecked={effectiveMode === 'FORCED'}
              onChange={(e) => setModeOverride(e.target.checked ? 'FORCED' : null)}
            />
          </HStack>
        )}

        <Box>
          <HStack spacing={2}>
            <Heading size="lg">Lector de facturas</Heading>
            <Ayuda texto="El lector extrae automáticamente número, fecha, NIF y totales de una factura subida (PDF, imagen o XML), para que solo tengas que revisarlos antes de crear la factura en contabilidad." />
          </HStack>
          <Text color="gray.600" mt={1}>
            {isDemo
              ? 'Estás en modo demo: los cambios no se guardarán en la empresa real. Puedes subir archivos, editar los datos leídos y simular la creación de facturas libremente.'
              : 'Sube una factura (PDF, imagen o XML); el sistema extrae los datos automáticamente y los revisas antes de crear la factura.'}
          </Text>
        </Box>

        <Alert status={apiHealthStatus === 'OK' ? 'success' : apiHealthStatus === 'DOWN' ? 'warning' : 'info'} borderRadius="md">
          <AlertIcon />
          {effectiveMode === 'FORCED' && 'Modo demo forzado: no se realiza ninguna llamada a la API del lector.'}
          {effectiveMode !== 'FORCED' && apiHealthStatus === 'CHECKING' && 'Comprobando la API del lector…'}
          {effectiveMode !== 'FORCED' && apiHealthStatus === 'OK' && 'API del lector: OK'}
          {effectiveMode !== 'FORCED' && apiHealthStatus === 'DOWN' && 'API del lector no disponible, mostrando demo guiada.'}
        </Alert>

        {/* Subida: disponible en ambos modos, bifurca internamente */}
        <Box borderWidth="1px" borderStyle="dashed" borderRadius="md" p={4} textAlign="center">
          <Text fontSize="sm" color="gray.600" mb={2}>
            {isDemo ? 'Sube un archivo (real o de prueba) para simular su lectura' : 'Sube una factura (PDF, imagen o XML)'}
          </Text>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xml,image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleUpload(file);
            }}
          />
          <HelpTooltip label={getHelpSnippet(isDemo ? 'lector-demo-vs-real' : 'lector-flujo-basico')}>
            <Button size="sm" isLoading={subiendo} onClick={() => fileInputRef.current?.click()}>
              Elegir archivo
            </Button>
          </HelpTooltip>
          {isDemo && (
            <Text fontSize="xs" color="gray.500" mt={2}>
              Pista: nombra el archivo con "retencion", "varios" o déjalo genérico para ver distintos patrones de lectura.
            </Text>
          )}
        </Box>

        <Grid templateColumns={{ base: '1fr', md: '1fr 1.3fr' }} gap={6}>
          <GridItem>
            {isDemo ? (
              <DemoHistorial
                historial={historialDemo}
                selectedId={selectedDemoId}
                onSelect={handleSelectDemo}
                onRepetir={handleRepetir}
                onEliminar={handleEliminarDemo}
              />
            ) : (
              <Box>
                <HStack justify="space-between" mb={2}>
                  <Heading size="sm">Pendientes de revisar</Heading>
                  <Button size="xs" variant="ghost" onClick={cargarPendientes} isLoading={loadingLista}>
                    Actualizar
                  </Button>
                </HStack>
                <VStack align="stretch" spacing={2}>
                  {loadingLista && <Spinner size="sm" />}
                  {!loadingLista && documentos.length === 0 && (
                    <Text fontSize="sm" color="gray.500">No hay documentos pendientes de revisar.</Text>
                  )}
                  {documentos.map((d) => (
                    <DocListItem key={d.id} doc={d} selected={selectedDoc?.id === d.id} onClick={() => handleSelectDoc(d.id)} />
                  ))}
                </VStack>
              </Box>
            )}
          </GridItem>

          <GridItem>
            <Box borderWidth="1px" borderRadius="md" p={4} bg="white" minH="200px">
              {!selectedDemo && !selectedDoc && !loadingDetalle && (
                <Text color="gray.500" fontSize="sm">Selecciona un documento de la lista (o sube uno) para ver el detalle.</Text>
              )}

              {loadingDetalle && <Spinner size="sm" />}

              {selectedDemo && (
                <DemoDetail
                  factura={selectedDemo}
                  onCambiarCampo={(patch) => actualizarCampoDemo(selectedDemo.id, patch)}
                  onAbrirConfirmacion={handleAbrirConfirmacion}
                />
              )}

              {selectedDoc && (
                <RealDetail doc={selectedDoc} accionando={accionando} onVerify={handleVerify} onReject={handleReject} />
              )}
            </Box>
          </GridItem>
        </Grid>
      </VStack>

      {/* Modal de confirmación: previsualiza el asiento contable antes de "crear" */}
      <Modal isOpen={confirmModal.isOpen} onClose={confirmModal.onClose} size="lg">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>
            Confirmar creación de factura de {confirmTipo === 'ingreso' ? 'ingreso' : 'gasto'} (simulada)
          </ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            <VStack align="stretch" spacing={4}>
              <Alert status="info" fontSize="sm" borderRadius="md">
                <AlertIcon />
                En una empresa real, ahora se crearía la factura y se lanzaría el motor contable. En esta demo, solo estás viendo el resultado.
              </Alert>
              {asientoPreview && (
                <Table size="sm">
                  <Thead>
                    <Tr>
                      <Th>Cuenta</Th>
                      <Th>Nombre</Th>
                      <Th isNumeric>Debe</Th>
                      <Th isNumeric>Haber</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {asientoPreview.lineas.map((l, i) => (
                      <Tr key={i}>
                        <Td>{l.cuenta}</Td>
                        <Td>{l.nombreCuenta}</Td>
                        <Td isNumeric>{l.debe > 0 ? fmtCurrency(l.debe) : '—'}</Td>
                        <Td isNumeric>{l.haber > 0 ? fmtCurrency(l.haber) : '—'}</Td>
                      </Tr>
                    ))}
                    <Tr fontWeight="bold">
                      <Td colSpan={2}>Total</Td>
                      <Td isNumeric>{fmtCurrency(asientoPreview.totalDebe)}</Td>
                      <Td isNumeric>{fmtCurrency(asientoPreview.totalHaber)}</Td>
                    </Tr>
                  </Tbody>
                </Table>
              )}
            </VStack>
          </ModalBody>
          <ModalFooter>
            <HStack spacing={2}>
              <Button variant="ghost" onClick={confirmModal.onClose}>Cancelar</Button>
              <Button colorScheme="green" onClick={handleConfirmarCreacion}>Confirmar</Button>
            </HStack>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Container>
  );
}

function DemoHistorial({
  historial,
  selectedId,
  onSelect,
  onRepetir,
  onEliminar,
}: {
  historial: FacturaLeidaDemo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRepetir: (id: string) => void;
  onEliminar: (id: string) => void;
}) {
  const estadoLabel: Record<FacturaLeidaDemo['estado'], string> = {
    LEIDA: 'Leída',
    EDITADA: 'Editada',
    CREADA: 'Creada',
  };
  const estadoColor: Record<FacturaLeidaDemo['estado'], string> = {
    LEIDA: 'gray',
    EDITADA: 'blue',
    CREADA: 'green',
  };

  return (
    <Box>
      <HStack spacing={2} mb={2}>
        <Heading size="sm">Facturas leídas (demo)</Heading>
        <Ayuda texto="Esta lista vive solo en tu navegador mientras no recargues la página. No se guarda nada en la base de datos." />
      </HStack>
      {historial.length === 0 && <Text fontSize="sm" color="gray.500">Sube un archivo para empezar.</Text>}
      <VStack align="stretch" spacing={2}>
        {historial.map((f) => (
          <Box
            key={f.id}
            borderWidth="1px"
            borderRadius="md"
            p={3}
            cursor="pointer"
            bg={selectedId === f.id ? 'blue.50' : 'white'}
            borderColor={selectedId === f.id ? 'blue.300' : 'gray.200'}
            onClick={() => onSelect(f.id)}
          >
            <HStack justify="space-between">
              <Text fontSize="sm" fontWeight="semibold" noOfLines={1}>{f.nombreEmisor}</Text>
              <Badge colorScheme={estadoColor[f.estado]}>
                {estadoLabel[f.estado]}{f.creadaComo ? ` · ${f.creadaComo}` : ''}
              </Badge>
            </HStack>
            <Text fontSize="xs" color="gray.500" noOfLines={1}>{f.nombreArchivo} — {f.patronLabel}</Text>
            <HStack justify="space-between" mt={2}>
              <Text fontSize="sm">{fmtCurrency(f.totalFactura)}</Text>
              <HStack spacing={1}>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRepetir(f.id);
                  }}
                >
                  Repetir
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  colorScheme="red"
                  onClick={(e) => {
                    e.stopPropagation();
                    onEliminar(f.id);
                  }}
                >
                  Eliminar
                </Button>
              </HStack>
            </HStack>
          </Box>
        ))}
      </VStack>
    </Box>
  );
}

function DocListItem({ doc, selected, onClick }: { doc: IncomeReaderDocument; selected: boolean; onClick: () => void }) {
  return (
    <Box
      borderWidth="1px"
      borderRadius="md"
      p={3}
      cursor="pointer"
      bg={selected ? 'blue.50' : 'white'}
      borderColor={selected ? 'blue.300' : 'gray.200'}
      onClick={onClick}
    >
      <HStack justify="space-between">
        <Text fontSize="sm" fontWeight="semibold" noOfLines={1}>{doc.originalFileName}</Text>
        <Badge>{doc.status}</Badge>
      </HStack>
    </Box>
  );
}

function DemoDetail({
  factura,
  onCambiarCampo,
  onAbrirConfirmacion,
}: {
  factura: FacturaLeidaDemo;
  onCambiarCampo: (patch: Partial<FacturaLeidaDemo>) => void;
  onAbrirConfirmacion: (tipo: 'ingreso' | 'gasto') => void;
}) {
  const yaCreada = factura.estado === 'CREADA';

  return (
    <VStack align="stretch" spacing={4}>
      <Alert status="info" borderRadius="md" fontSize="sm">
        <AlertIcon />
        {factura.avisoLectura} Estás en modo demo: los cambios no se guardarán en la empresa real.
      </Alert>

      <HStack spacing={2}>
        <Text fontSize="xs" color="gray.500" fontWeight="semibold">CAMPOS DETECTADOS (editables)</Text>
        <Ayuda texto="Estos son los campos que el lector habría extraído de la factura. Puedes corregirlos antes de crear la factura, igual que en el flujo real." />
      </HStack>

      <Grid templateColumns="repeat(2, 1fr)" gap={3}>
        <EditableField
          label="Número"
          value={factura.numeroFactura}
          onChange={(v) => onCambiarCampo({ numeroFactura: v })}
          isDisabled={yaCreada}
        />
        <EditableField
          label="Fecha"
          value={factura.fechaFactura}
          onChange={(v) => onCambiarCampo({ fechaFactura: v })}
          isDisabled={yaCreada}
        />
        <EditableField
          label="NIF emisor"
          value={factura.nifEmisor}
          onChange={(v) => onCambiarCampo({ nifEmisor: v })}
          isDisabled={yaCreada}
        />
        <EditableField
          label="Emisor"
          value={factura.nombreEmisor}
          onChange={(v) => onCambiarCampo({ nombreEmisor: v })}
          isDisabled={yaCreada}
        />
        <EditableNumberField
          label="Base imponible"
          value={factura.baseImponible}
          onChange={(v) => onCambiarCampo({ baseImponible: v, totalFactura: round2(v + factura.totalIva - factura.totalRetencion) })}
          isDisabled={yaCreada}
        />
        <EditableNumberField
          label="IVA"
          value={factura.totalIva}
          onChange={(v) => onCambiarCampo({ totalIva: v, totalFactura: round2(factura.baseImponible + v - factura.totalRetencion) })}
          isDisabled={yaCreada}
        />
        <EditableNumberField
          label="Retención"
          value={factura.totalRetencion}
          onChange={(v) => onCambiarCampo({ totalRetencion: v, totalFactura: round2(factura.baseImponible + factura.totalIva - v) })}
          isDisabled={yaCreada}
        />
        <Box>
          <Text fontSize="xs" color="gray.500">Total factura</Text>
          <Text fontSize="sm" fontWeight="bold">{fmtCurrency(factura.totalFactura)}</Text>
        </Box>
      </Grid>

      <Divider />

      <HStack spacing={2}>
        <Text fontSize="xs" color="gray.500" fontWeight="semibold">CREAR FACTURA</Text>
        <Ayuda texto="Al confirmar, verás el asiento contable (cuentas del PGC) que se generaría en una empresa real. En esta demo no se contabiliza nada de verdad." />
      </HStack>

      {yaCreada ? (
        <Alert status="success" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Ya simulaste la creación de esta factura como {factura.creadaComo}. Pulsa "Repetir" en el historial para volver a probar.
        </Alert>
      ) : (
        <HStack spacing={2} wrap="wrap">
          <HelpTooltip label="Genera un asiento contable de ejemplo (430/700/477/473) sin guardar nada en la empresa real.">
            <Button size="sm" colorScheme="green" onClick={() => onAbrirConfirmacion('ingreso')}>
              Crear factura de ingreso (simulada)
            </Button>
          </HelpTooltip>
          <HelpTooltip label="Genera un asiento contable de ejemplo (600/472/4751/400) sin guardar nada en la empresa real.">
            <Button size="sm" colorScheme="purple" onClick={() => onAbrirConfirmacion('gasto')}>
              Crear factura de gasto (simulada)
            </Button>
          </HelpTooltip>
        </HStack>
      )}
    </VStack>
  );
}

/**
 * Aviso del estado de la lectura OCR. Regla: NO decidir "no hay OCR" mirando
 * `confianza` (eso solo mide la calidad). El "hay/no hay OCR" y el "no se pudo
 * leer" los indica `ocrEstado` desde el backend. `confianza` solo gobierna el
 * sub-caso dentro de OK (alta/baja). El `default` da compatibilidad con
 * documentos antiguos guardados sin `ocrEstado`.
 */
function AvisoOcr({ p }: { p: ParsedInvoiceData }): React.ReactElement | null {
  switch (p.ocrEstado) {
    case 'SIN_CLAVE':
      return (
        <Alert status="info" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Lectura automática no configurada. El servidor no tiene activada la lectura automática de facturas (falta la clave del proveedor de OCR). Completa los campos a mano; en cuanto se configure, las próximas facturas se rellenarán solas.
        </Alert>
      );
    case 'FORMATO_NO_SOPORTADO':
      return (
        <Alert status="warning" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Formato no admitido para lectura automática. Solo se leen automáticamente PDF, imágenes (JPG, PNG, GIF, WEBP) y XML Facturae. Sube la factura en uno de esos formatos o completa los campos a mano.
        </Alert>
      );
    case 'NO_LEGIBLE':
      return (
        <Alert status="warning" fontSize="sm" borderRadius="md">
          <AlertIcon />
          No se pudieron extraer los datos de este documento. La lectura automática está activa, pero esta factura no era legible (escaneo de baja calidad, manuscrito o documento atípico). Revisa o completa los campos antes de verificar.
        </Alert>
      );
    case 'OK':
      return (p.confianza ?? 0) < 60 ? (
        <Alert status="warning" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Lectura con baja confianza ({p.confianza ?? 0}%). Revisa los campos antes de verificar: puede haber errores.
        </Alert>
      ) : (
        <Alert status="success" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Datos leídos automáticamente ({p.confianza}% de confianza). Revisa que sean correctos antes de crear la factura.
        </Alert>
      );
    default:
      // Documentos antiguos sin `ocrEstado`: fallback por confianza.
      return (p.confianza ?? 0) === 0 ? (
        <Alert status="warning" fontSize="sm" borderRadius="md">
          <AlertIcon />
          No se detectaron datos. Revisa o complétalos a mano antes de verificar.
        </Alert>
      ) : null;
  }
}

function RealDetail({
  doc,
  accionando,
  onVerify,
  onReject,
}: {
  doc: IncomeReaderDocument;
  accionando: boolean;
  onVerify: () => void;
  onReject: () => void;
}) {
  const p = doc.parsedData;
  const listo = doc.status === 'READY_FOR_VERIFICATION';

  return (
    <VStack align="stretch" spacing={4}>
      <HStack justify="space-between">
        <Text fontWeight="semibold" noOfLines={1}>{doc.originalFileName}</Text>
        <Badge>{doc.status}</Badge>
      </HStack>

      {!p && (
        <Alert status="info" fontSize="sm" borderRadius="md">
          <AlertIcon />
          Aún procesando o sin datos extraídos.
        </Alert>
      )}

      {p && (
        <>
          <AvisoOcr p={p} />
          <Grid templateColumns="repeat(2, 1fr)" gap={3}>
            <Field label="Número" value={p.numero || '—'} />
            <Field label="Fecha" value={p.fecha || '—'} />
            <Field label="NIF emisor" value={p.nifEmisor || '—'} />
            <Field label="Emisor" value={p.nombreEmisor || '—'} />
            <Field label="Base imponible" value={p.baseImponible != null ? fmtCurrency(p.baseImponible) : '—'} />
            <Field label="Total" value={p.total != null ? fmtCurrency(p.total) : '—'} />
          </Grid>
        </>
      )}

      <Divider />

      <HStack spacing={2}>
        <Button size="sm" colorScheme="green" isDisabled={!listo} isLoading={accionando} onClick={onVerify}>
          Crear factura de ingreso
        </Button>
        <Button size="sm" variant="outline" colorScheme="red" isLoading={accionando} onClick={onReject}>
          Rechazar
        </Button>
      </HStack>
      {!listo && <Text fontSize="xs" color="gray.500">Solo se puede crear la factura cuando el documento está "READY_FOR_VERIFICATION".</Text>}
    </VStack>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text fontSize="xs" color="gray.500">{label}</Text>
      <Text fontSize="sm" fontWeight="medium">{value}</Text>
    </Box>
  );
}

function EditableField({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  isDisabled?: boolean;
}) {
  return (
    <Box>
      <Text fontSize="xs" color="gray.500">{label}</Text>
      <Input size="sm" value={value} onChange={(e) => onChange(e.target.value)} isDisabled={isDisabled} />
    </Box>
  );
}

function EditableNumberField({
  label,
  value,
  onChange,
  isDisabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  isDisabled?: boolean;
}) {
  return (
    <Box>
      <Text fontSize="xs" color="gray.500">{label}</Text>
      <NumberInput
        size="sm"
        value={value}
        min={0}
        precision={2}
        onChange={(_, num) => onChange(Number.isFinite(num) ? num : 0)}
        isDisabled={isDisabled}
      >
        <NumberInputField />
      </NumberInput>
    </Box>
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
