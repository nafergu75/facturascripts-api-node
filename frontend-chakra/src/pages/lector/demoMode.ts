/**
 * Modo demo de /lector: tipos, deteccion de modo y simulacion de OCR.
 * Modulo puramente de frontend — nada de aqui llama a ningun endpoint real.
 */

export type DemoMode = 'OFF' | 'AUTO' | 'FORCED';
export type ApiHealthStatus = 'CHECKING' | 'OK' | 'DOWN';

export interface LineaFacturaLeidaDemo {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  baseImponible: number;
  tipoIva: number;
  tipoRetencion: number;
}

export interface FacturaLeidaDemo {
  id: string;
  nombreArchivo: string;
  patronUsado: 'EMITIDA_SIN_RETENCION' | 'RECIBIDA_CON_RETENCION' | 'VARIOS_CONCEPTOS';
  patronLabel: string;
  tipoDetectado: 'venta' | 'compra';
  numeroFactura: string;
  nombreEmisor: string;
  nifEmisor: string;
  fechaFactura: string;
  lineas: LineaFacturaLeidaDemo[];
  baseImponible: number;
  totalIva: number;
  totalRetencion: number;
  totalFactura: number;
  avisoLectura: string;
  estado: 'LEIDA' | 'EDITADA' | 'CREADA';
  creadaComo?: 'ingreso' | 'gasto';
  leidaEn: string;
}

export interface LineaAsientoPreview {
  cuenta: string;
  nombreCuenta: string;
  debe: number;
  haber: number;
}

export interface AsientoPreview {
  lineas: LineaAsientoPreview[];
  totalDebe: number;
  totalHaber: number;
}

/**
 * Decide si el modo demo esta activo.
 *   FORCED -> siempre demo, ignora la API.
 *   OFF    -> nunca demo, usa la API real aunque este caida (mostrara error normal).
 *   AUTO   -> demo solo si la API no responde (apiHealth === 'DOWN').
 */
export function isDemoEnabled(mode: DemoMode, apiHealth: ApiHealthStatus): boolean {
  if (mode === 'FORCED') return true;
  if (mode === 'OFF') return false;
  return apiHealth === 'DOWN';
}

/**
 * Lee el override de modo desde la URL: ?demo=1 fuerza demo, ?demo=0 fuerza real.
 * Sin el parametro, devuelve null (sin override -> se usa AUTO).
 * Funciona en cualquier entorno (incluida produccion) para poder compartir un
 * enlace de demo publica sin depender de flags de build.
 */
export function resolveDemoModeFromUrl(search: string = window.location.search): DemoMode | null {
  const params = new URLSearchParams(search);
  const v = params.get('demo');
  if (v === '1') return 'FORCED';
  if (v === '0') return 'OFF';
  return null;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

type PatronBase = Omit<FacturaLeidaDemo, 'id' | 'nombreArchivo' | 'leidaEn' | 'estado' | 'creadaComo'>;

const PATRONES: Record<FacturaLeidaDemo['patronUsado'], PatronBase> = {
  EMITIDA_SIN_RETENCION: {
    patronUsado: 'EMITIDA_SIN_RETENCION',
    patronLabel: 'Factura emitida nacional con IVA 21% y sin retención',
    tipoDetectado: 'venta',
    numeroFactura: 'INV-2024-0021',
    nombreEmisor: 'Cliente Ejemplo S.L.',
    nifEmisor: 'B12345678',
    fechaFactura: new Date().toISOString().slice(0, 10),
    lineas: [{ descripcion: 'Prestación de servicios', cantidad: 1, precioUnitario: 1500, baseImponible: 1500, tipoIva: 21, tipoRetencion: 0 }],
    baseImponible: 1500,
    totalIva: 315,
    totalRetencion: 0,
    totalFactura: 1815,
    avisoLectura: 'Lectura demo: factura de venta, IVA 21%, sin retención detectada.',
  },
  RECIBIDA_CON_RETENCION: {
    patronUsado: 'RECIBIDA_CON_RETENCION',
    patronLabel: 'Factura recibida con IVA 21% y retención 15%',
    tipoDetectado: 'compra',
    numeroFactura: 'PROV-2024-0087',
    nombreEmisor: 'Asesoría Profesional Asociados S.L.',
    nifEmisor: 'B87654321',
    fechaFactura: new Date().toISOString().slice(0, 10),
    lineas: [{ descripcion: 'Honorarios profesionales', cantidad: 1, precioUnitario: 1000, baseImponible: 1000, tipoIva: 21, tipoRetencion: 15 }],
    baseImponible: 1000,
    totalIva: 210,
    totalRetencion: 150,
    totalFactura: 1060,
    avisoLectura: 'Lectura demo: factura de gasto con retención IRPF del 15% detectada.',
  },
  VARIOS_CONCEPTOS: {
    patronUsado: 'VARIOS_CONCEPTOS',
    patronLabel: 'Factura con varios conceptos (tipos de IVA distintos)',
    tipoDetectado: 'venta',
    numeroFactura: 'INV-2024-0033',
    nombreEmisor: 'Distribuciones Varias del Norte S.A.',
    nifEmisor: 'A11223344',
    fechaFactura: new Date().toISOString().slice(0, 10),
    lineas: [
      { descripcion: 'Servicio de consultoría', cantidad: 1, precioUnitario: 800, baseImponible: 800, tipoIva: 21, tipoRetencion: 0 },
      { descripcion: 'Material entregado', cantidad: 1, precioUnitario: 200, baseImponible: 200, tipoIva: 10, tipoRetencion: 0 },
    ],
    baseImponible: 1000,
    totalIva: 188,
    totalRetencion: 0,
    totalFactura: 1188,
    avisoLectura: 'Lectura demo: factura con varios conceptos detectados, cada uno con su propio tipo de IVA.',
  },
};

/**
 * Elige un patron de OCR simulado a partir del nombre del archivo subido
 * (heuristica simple por palabras clave). Si no reconoce nada en el nombre,
 * cae a un reparto determinista segun cuantas facturas se han leido ya en la
 * sesion, para dar variedad sin que el usuario tenga que nombrar el archivo.
 */
function elegirPatron(file: File, intentoIndex: number): FacturaLeidaDemo['patronUsado'] {
  const n = file.name.toLowerCase();
  if (/(retenc|recibida|gasto|compra|proveedor)/.test(n)) return 'RECIBIDA_CON_RETENCION';
  if (/(varios|conceptos|multi)/.test(n)) return 'VARIOS_CONCEPTOS';
  if (/(emitida|venta|cliente|ingreso)/.test(n)) return 'EMITIDA_SIN_RETENCION';
  const claves = Object.keys(PATRONES) as FacturaLeidaDemo['patronUsado'][];
  return claves[intentoIndex % claves.length];
}

/** Simula la lectura OCR de un archivo subido en modo demo. No hace ninguna llamada de red. */
export function simulateOcrResult(file: File, intentoIndex: number = 0): FacturaLeidaDemo {
  const patron = elegirPatron(file, intentoIndex);
  const base = PATRONES[patron];
  return {
    ...base,
    lineas: base.lineas.map((l) => ({ ...l })),
    id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nombreArchivo: file.name,
    leidaEn: new Date().toISOString(),
    estado: 'LEIDA',
  };
}

/** Re-simula la lectura del mismo archivo eligiendo el siguiente patrón en la rotación. */
export function repetirSimulacion(factura: FacturaLeidaDemo, intentoIndex: number): FacturaLeidaDemo {
  const claves = Object.keys(PATRONES) as FacturaLeidaDemo['patronUsado'][];
  const patron = claves[intentoIndex % claves.length];
  const base = PATRONES[patron];
  return {
    ...base,
    lineas: base.lineas.map((l) => ({ ...l })),
    id: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nombreArchivo: factura.nombreArchivo,
    leidaEn: new Date().toISOString(),
    estado: 'LEIDA',
  };
}

/**
 * Genera la previsualizacion del asiento contable (PGC) que se crearia para
 * esta factura demo, segun se confirme como ingreso o gasto. Mismas cuentas y
 * convenio de signo que el motor contable real (430/700/477/473 para ingreso;
 * 600/472/4751/400 para gasto).
 */
export function generarAsientoPreview(f: FacturaLeidaDemo, tipo: 'ingreso' | 'gasto'): AsientoPreview {
  const lineas: LineaAsientoPreview[] = [];

  if (tipo === 'ingreso') {
    lineas.push({ cuenta: '430', nombreCuenta: 'Clientes', debe: f.totalFactura, haber: 0 });
    lineas.push({ cuenta: '700', nombreCuenta: 'Venta de mercaderías / prestación de servicios', debe: 0, haber: f.baseImponible });
    if (f.totalIva > 0) lineas.push({ cuenta: '477', nombreCuenta: 'HP, IVA repercutido', debe: 0, haber: f.totalIva });
    if (f.totalRetencion > 0) lineas.push({ cuenta: '473', nombreCuenta: 'HP, retenciones y pagos a cuenta', debe: f.totalRetencion, haber: 0 });
  } else {
    lineas.push({ cuenta: '600', nombreCuenta: 'Compras / servicios exteriores', debe: f.baseImponible, haber: 0 });
    if (f.totalIva > 0) lineas.push({ cuenta: '472', nombreCuenta: 'HP, IVA soportado', debe: f.totalIva, haber: 0 });
    if (f.totalRetencion > 0) lineas.push({ cuenta: '4751', nombreCuenta: 'HP, acreedora por retenciones', debe: 0, haber: f.totalRetencion });
    lineas.push({ cuenta: '400', nombreCuenta: 'Proveedores', debe: 0, haber: f.totalFactura });
  }

  const totalDebe = round2(lineas.reduce((s, l) => s + l.debe, 0));
  const totalHaber = round2(lineas.reduce((s, l) => s + l.haber, 0));
  return { lineas, totalDebe, totalHaber };
}

/** Historial inicial precargado al entrar en modo demo (antes de subir nada). */
export const demoFacturasIniciales: FacturaLeidaDemo[] = [
  {
    ...PATRONES.EMITIDA_SIN_RETENCION,
    id: 'demo-seed-1',
    nombreArchivo: 'Factura-INV-2024-001.pdf',
    fechaFactura: '2024-01-15',
    leidaEn: '2024-01-15T09:00:00.000Z',
    estado: 'LEIDA',
  },
  {
    ...PATRONES.RECIBIDA_CON_RETENCION,
    id: 'demo-seed-2',
    nombreArchivo: 'Factura-PROV-B-0045.pdf',
    fechaFactura: '2024-02-03',
    leidaEn: '2024-02-03T09:00:00.000Z',
    estado: 'LEIDA',
  },
  {
    ...PATRONES.VARIOS_CONCEPTOS,
    id: 'demo-seed-3',
    nombreArchivo: 'Factura-Varios-Marzo.pdf',
    fechaFactura: '2024-03-12',
    leidaEn: '2024-03-12T09:00:00.000Z',
    estado: 'LEIDA',
  },
];
