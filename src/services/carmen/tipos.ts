/**
 * Tipos de Carmen (asistente). La respuesta (RespuestaCarmen) es el contrato con
 * el frontend: si cambia, hay que cambiar tambien su copia en frontend/web/lib/carmen.ts.
 */
import type { ColumnaInforme, FilaInforme } from '../informesContables.documentos';

/** De donde sale una respuesta. Solo 'ia' ha pasado por el modelo de lenguaje. */
export type OrigenRespuesta = 'datos' | 'faq' | 'ia' | 'aclaracion' | 'sistema';

/** Lo que mandan los botones: se ejecuta tal cual, sin clasificar el texto. */
export type Accion =
  | { tipo: 'intencion'; id: string; huecos?: HuecosEntrada }
  | { tipo: 'faq'; id: string }
  | { tipo: 'tercero'; terceroId: string; rol: 'cliente' | 'proveedor' | 'banco'; intencion?: string }
  | { tipo: 'ia' }
  | { tipo: 'catalogo' }
  /** «No era esto»: se vuelve a mirar la pregunta (message) sin la intención descartada. */
  | { tipo: 'noEraEsto'; intencion?: string };

/** Huecos que llegan desde un boton (ya estructurados). */
export interface HuecosEntrada {
  /** Código de periodo ('este-mes', '2026-3T', '2026-09'...). */
  periodo?: string;
  sentido?: 'cobros' | 'pagos';
  modelo?: string;
  terceroId?: string;
  rol?: 'cliente' | 'proveedor' | 'banco';
  importeMinimo?: number;
  diasMinimos?: number;
  ibanFinal?: string;
  /** Número de factura tal como lo escribió el usuario («A-12», «2026-0045»). */
  numeroFactura?: string;
  /** Solo lo vencido («facturas de proveedores vencidas»). */
  soloVencidas?: boolean;
  /** De qué lado se pregunta en INT-09: lo facturado (ventas) o lo gastado (gastos). */
  foco?: 'ventas' | 'gastos';
}

export interface Boton {
  texto: string;
  accion: Accion;
}

export interface Kpi {
  etiqueta: string;
  valor: string;
  detalle?: string;
}

export interface Enlace {
  texto: string;
  href: string;
}

export interface Descarga {
  texto: string;
  /** Ruta de la API (relativa a /companies/:companyId) que devuelve el fichero. */
  ruta: string;
  formato: 'pdf' | 'xlsx';
}

/** Tabla con la misma forma que TablaInforme (sin empresa ni fichero), 15 filas como maximo. */
export interface TablaCarmen {
  titulo: string;
  periodo: string;
  columnas: ColumnaInforme[];
  filas: FilaInforme[];
  /** Filas que habia en total antes de recortar a 15. */
  totalFilas: number;
  notas?: string[];
}

export interface FuenteFicha {
  titulo: string;
  url: string;
  verificadaEl: string;
}

/** Respuesta de POST /chat-assistant. */
export interface RespuestaCarmen {
  sessionId: string;
  mensajeId: string;
  origen: OrigenRespuesta;
  intencion?: string;
  /** «Pendiente de cobro de X a 07/10/2026»: lo que Carmen ha entendido (solo datos). */
  entendido?: string;
  texto: string;
  kpis?: Kpi[];
  tabla?: TablaCarmen;
  enlaces?: Enlace[];
  descargas?: Descarga[];
  botones?: Boton[];
  avisos?: string[];
  fuente?: FuenteFicha;
  calculadoEn?: string;
  /** Solo en respuestas de IA: «Respuesta orientativa generada por IA...». */
  etiquetaIA?: string;
  /**
   * Solo en respuestas de datos: la acción que repite la consulta con cifras
   * de ahora (botón «Actualizar»). Lleva códigos e ids, nunca nombres.
   */
  actualizar?: Accion;
}

/** Cuerpo de la respuesta antes de guardarla (sin sessionId ni mensajeId). */
export type CuerpoRespuesta = Omit<RespuestaCarmen, 'sessionId' | 'mensajeId'> & {
  /** Permiso con el que se ha calculado (para ocultar la respuesta si el usuario lo pierde). */
  permisoRequerido?: string;
  /** Huecos de la respuesta (códigos e ids, sin nombres) para el historial. */
  huecos?: HuecosEntrada;
  /** Resultado del validador de cifras de la IA. */
  validacion?: 'ok' | 'descartada';
};

/** Datos del usuario y la empresa con los que trabaja Carmen en una peticion. */
export interface CarmenCtx {
  companyId: string;
  userId: string;
  permisos: Set<string>;
  esAdminGlobal: boolean;
  /** Admin de la empresa (rol admin) o admin global. */
  esAdminEmpresa: boolean;
  /** Tiene 'nominas:read' en la empresa: puede ver sueldos y Seguridad Social (cuentas 64x, 465, 476). */
  puedeNominas: boolean;
  /** Hoy en hora peninsular, AAAA-MM-DD. */
  hoy: string;
}

/** Periodo resuelto: fechas incluidas y una etiqueta para el texto. */
export interface Periodo {
  desde: string;
  hasta: string;
  etiqueta: string;
  /** Ejercicios que toca (uno normalmente; dos si cruza de año). */
  ejercicios: number[];
  /** Codigo con el que se ha pedido ('este-mes', '2026-3T', '2026-09'...), para los botones. */
  codigo: string;
}

export interface HuecosResueltos {
  periodo?: Periodo;
  sentido?: 'cobros' | 'pagos';
  modelo?: string;
  terceroId?: string;
  rol?: 'cliente' | 'proveedor' | 'banco';
  importeMinimo?: number;
  /** «más de 60 días de retraso». */
  diasMinimos?: number;
  /** «la cuenta acabada en 1234». */
  ibanFinal?: string;
  /** Texto a buscar en el concepto de los movimientos («cargos de Repsol»). Nunca se guarda ni va a la IA. */
  texto?: string;
  numeroFactura?: string;
  soloVencidas?: boolean;
  foco?: 'ventas' | 'gastos';
}

/** Area de la app de una intencion (para chips por pagina y para el mensaje de permisos). */
export type AreaIntencion = 'cobros' | 'pagos' | 'facturacion' | 'contabilidad' | 'tesoreria' | 'impuestos' | 'resumen';

/** Lo que devuelve una intencion de datos. SOLO LECTURA. */
export type RespuestaDatos =
  | { sinPermiso: true; area: AreaIntencion }
  | {
      sinPermiso?: false;
      entendido: string;
      texto: string;
      permisoRequerido?: string;
      /** La respuesta solo lleva a una pantalla, sin cifras de la empresa (origen 'sistema'). */
      sinCifras?: boolean;
      kpis?: Kpi[];
      tabla?: TablaCarmen;
      enlaces?: Enlace[];
      descargas?: Descarga[];
      botones?: Boton[];
      avisos?: string[];
    };

/** Contexto del dialogo que se guarda en ChatSession.contexto (solo lo lee el servidor). */
export interface ContextoSesion {
  intencion?: string;
  huecos?: HuecosEntrada;
  /** Intencion a la que le falta un hueco obligatorio. */
  pendiente?: string;
  /** ISO de cuando se guardo. */
  en: string;
}
