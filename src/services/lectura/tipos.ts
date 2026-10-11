/**
 * Tipos comunes de los lectores de facturas (Azure, Claude y Facturae).
 *
 * Todos los lectores devuelven una LecturaNormalizada: lo leido, campo a campo,
 * con su confianza y su fuente. Nunca la respuesta bruta del proveedor de OCR.
 * Despues se valida (validaciones.ts) y se adapta a las pantallas de hoy
 * (adaptadores.ts). Ver C:/tmp/conta-specs/ocr-azure.md, seccion 10.
 */

export type Lector = 'VENTA' | 'GASTO';
export type OrigenLectura = 'AZURE' | 'AZURE_CLAUDE' | 'CLAUDE' | 'FACTURAE';
export type FuenteCampo = 'azure' | 'claude' | 'qr' | 'calculado' | 'facturae';
export type NivelValidacion = 'ok' | 'revisar' | 'error';

export type TipoDocumentoLeido = 'factura' | 'simplificada' | 'rectificativa' | 'ticket' | 'recibo' | 'nomina' | 'seguros_sociales' | 'otro';

export interface Campo<T> {
  valor: T | null;
  /** 0-1; null si el lector no la da (Claude, calculado). */
  confianza: number | null;
  fuente: FuenteCampo;
  pagina?: number;
  /** Por que hay que revisarlo aunque se haya leido (calculado, propuesto, contradicho...). */
  motivo?: string;
}

export interface TramoLeido {
  tipoIva: number;
  base: Campo<number>;
  cuota: Campo<number>;
  tipoRecargo: number | null;
  cuotaRecargo: Campo<number> | null;
}

export interface DireccionLeida {
  calle?: string;
  cp?: string;
  municipio?: string;
  provincia?: string;
  pais?: string;
}

export interface LineaLeida {
  descripcion: string | null;
  cantidad: number | null;
  precioUnitario: number | null;
  importe: number | null;
  tipoIva: number | null;
  confianza: number | null;
}

/** Lo que sale de cualquier extractor, antes de validar. Sin datos brutos del proveedor de OCR. */
export interface LecturaNormalizada {
  tipoDocumento: Campo<TipoDocumentoLeido>;
  emisor: { nombre: Campo<string>; nif: Campo<string>; direccion: Campo<DireccionLeida> };
  receptor: { nombre: Campo<string>; nif: Campo<string> };
  numero: Campo<string>;
  fechaEmision: Campo<string>;
  fechaVencimiento: Campo<string>;
  moneda: Campo<string>;
  desglose: TramoLeido[];
  retencion: { tipo: Campo<number>; importe: Campo<number> } | null;
  totales: {
    base: Campo<number>;
    cuotaIva: Campo<number>;
    cuotaRecargo: Campo<number>;
    retencion: Campo<number>;
    totalFactura: Campo<number>;
    totalAPagar: Campo<number>;
  };
  lineas: LineaLeida[];
  iban: Campo<string>;
  rectificativa: { numeroRectificada: Campo<string>; motivo: Campo<string> } | null;
  concepto: Campo<string>;
  qr: ResultadoQr | null;
  paginas: { archivo: number | null; leidas: number | null };
  /** Textos para el usuario: descuentos, varias facturas, paginas sin leer... */
  avisos: string[];
  /** Senales que convierten las validaciones V22 en 'revisar' (importes informativos de Azure). */
  senales?: { descuento?: number; saldoAnterior?: number; variasFacturas?: boolean };
}

export interface DiferenciaQr {
  campo: 'nif' | 'numero' | 'fecha' | 'importe';
  enQr: string;
  leido: string | null;
  nivel: 'revisar' | 'error';
}

export interface ResultadoQr {
  estado: 'SIN_QR' | 'COINCIDE' | 'NO_COINCIDE' | 'ILEGIBLE' | 'AJENO';
  verifactu: boolean | null;
  /** fecha en ISO */
  datos: { nif: string; numserie: string; fecha: string; importe: number } | null;
  diferencias: DiferenciaQr[];
  /** Datos que no se leyeron en la factura y se han tomado del QR (no se han cotejado con nada). */
  completados?: Array<DiferenciaQr['campo']>;
  /** QR del entorno de pruebas de la AEAT (va como NO_COINCIDE con su motivo). */
  pruebas?: boolean;
  /** Texto para el usuario cuando el QR no se puede usar (de pruebas, mal formado). */
  motivo?: string;
}

export interface ArchivoLectura {
  buffer: Buffer;
  nombre: string;
  mime: string;
  hash: string;
}

export interface ContextoLectura {
  companyId: string;
  lector: Lector;
  empresaEspanola: boolean;
  /** Paginas del PDF contadas en local (aproximado); null si no es un PDF. */
  paginasArchivo?: number | null;
}

/** Datos del QR VERI*FACTU tal como vienen en el codigo (sin comparar aun). */
export interface QrInterpretado {
  estado: 'VALIDO' | 'ILEGIBLE' | 'AJENO' | 'PRUEBAS';
  verifactu: boolean | null;
  datos: { nif: string; numserie: string; fecha: string; importe: number } | null;
}

export interface LecturaHecha {
  tipo: 'hecho';
  lectura: LecturaNormalizada;
  /** content de Azure: solo en memoria, para el complemento con Claude. Nunca se guarda. */
  texto: string | null;
  /** QR leido por el complemento de codigos de barras (solo Azure). */
  qr?: QrInterpretado | null;
  /** Confianza calculada por el lector (la heuristica de hoy en Claude). */
  confianzaLector?: number | null;
}

export type ArranqueLectura =
  | { tipo: 'pendiente'; ref: { resultId: string }; reintentarEnMs: number }
  | LecturaHecha
  | { tipo: 'fallo'; codigo: CodigoFallo; reintentable: boolean };

export type ConsultaLectura =
  | { tipo: 'pendiente'; reintentarEnMs: number | null }
  | LecturaHecha
  | { tipo: 'fallo'; codigo: CodigoFallo; reintentable: boolean };

/** Un lector de facturas. Los sincronos (Claude, Facturae) devuelven 'hecho' al arrancar. */
export interface ExtractorFacturas {
  readonly id: 'azure' | 'claude' | 'facturae';
  configurado(): boolean;
  admite(mime: string): boolean;
  iniciar(archivo: ArchivoLectura, ctx: ContextoLectura): Promise<ArranqueLectura>;
  /** Solo los asincronos (Azure): UNA consulta, sin esperar dentro. */
  consultar?(ref: { resultId: string }, ctx: ContextoLectura): Promise<ConsultaLectura>;
  /** Borra lo que el proveedor guarde (Azure: DELETE analyzeResults). Sin lanzar errores. */
  limpiar?(ref: { resultId: string }): Promise<void>;
}

export type CodigoFallo =
  | 'AZURE_ARCHIVO'
  | 'AZURE_PETICION'
  | 'AZURE_CLAVE'
  | 'AZURE_CUOTA'
  | 'AZURE_OCUPADO'
  | 'AZURE_SERVICIO'
  | 'AZURE_TIEMPO'
  | 'AZURE_ANALISIS'
  | 'AZURE_RESULTADO_PERDIDO'
  | 'AZURE_SIN_FACTURA'
  | 'AZURE_RESPUESTA_RARA'
  | 'CLAUDE_SIN_CLAVE'
  | 'CLAUDE_ERROR'
  | 'NO_LEGIBLE';

/** Por que se leyo con Claude en lugar de Azure. */
export type MotivoRespaldo = CodigoFallo | 'AZURE_NO_CONFIGURADO' | 'OCR_LECTOR_CLAUDE' | 'AZURE_FORMATO';

export type CampoId =
  | 'tipoDocumento'
  | 'emisor.nombre'
  | 'emisor.nif'
  | 'receptor.nombre'
  | 'receptor.nif'
  | 'numero'
  | 'fechaEmision'
  | 'fechaVencimiento'
  | 'moneda'
  | `desglose.${number}.base`
  | `desglose.${number}.cuota`
  | `desglose.${number}.recargo`
  | 'retencion.tipo'
  | 'retencion.importe'
  | 'totales.base'
  | 'totales.cuotaIva'
  | 'totales.totalFactura'
  | 'totales.totalAPagar'
  | 'iban'
  | 'rectificativa.numeroRectificada'
  | 'concepto';

export interface EstadoCampo {
  estado: NivelValidacion;
  confianza: number | null;
  fuente: FuenteCampo;
  valorLeido: string | number | null;
  motivos: string[];
  sugerencia?: string;
  /** Solo en desglose.N.*: el tipo de IVA del tramo, para decir "Base del 21 %". */
  tipoIva?: number;
}

export interface ResultadoValidacion {
  codigo: string;
  nivel: NivelValidacion;
  campos: CampoId[];
  mensaje: string;
}

/** Umbrales de confianza de Azure. */
export const UMBRAL_OK = 0.8;
export const UMBRAL_BAJO = 0.5;

/** Campo vacio de una fuente. */
export function campoVacio<T>(fuente: FuenteCampo = 'azure'): Campo<T> {
  return { valor: null, confianza: null, fuente };
}

/** Lectura sin nada leido: base para los extractores y los tests. */
export function lecturaVacia(fuente: FuenteCampo = 'azure'): LecturaNormalizada {
  const v = <T>() => campoVacio<T>(fuente);
  return {
    tipoDocumento: { valor: 'factura', confianza: null, fuente: 'calculado' },
    emisor: { nombre: v(), nif: v(), direccion: v() },
    receptor: { nombre: v(), nif: v() },
    numero: v(),
    fechaEmision: v(),
    fechaVencimiento: v(),
    moneda: v(),
    desglose: [],
    retencion: null,
    totales: {
      base: v(),
      cuotaIva: v(),
      cuotaRecargo: { valor: 0, confianza: null, fuente: 'calculado' },
      retencion: { valor: 0, confianza: null, fuente: 'calculado' },
      totalFactura: v(),
      totalAPagar: v(),
    },
    lineas: [],
    iban: v(),
    rectificativa: null,
    concepto: v(),
    qr: null,
    paginas: { archivo: null, leidas: null },
    avisos: [],
  };
}
