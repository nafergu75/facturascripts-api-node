/** Periodo fiscal de una declaracion. */
export interface PeriodoFiscal {
  ejercicio: number;
  /** "1T".."4T" (trimestral), "01".."12" (mensual) o "0A" (anual). */
  periodo: string;
  tipo: 'mensual' | 'trimestral' | 'anual';
  fechaInicio: string; // yyyy-mm-dd
  fechaFin: string; // yyyy-mm-dd
}

/**
 * Factura en clave FISCAL (normalizada desde FacturaScripts) para alimentar los
 * modelos AEAT. Incluye NIF del tercero y clasificacion de la operacion.
 */
export interface FacturaFiscal {
  idFactura: string | number;
  tipo: 'venta' | 'compra';
  cifnif: string;
  nombreTercero: string;
  fecha: string; // yyyy-mm-dd
  operacion: 'interior' | 'intracomunitaria' | 'exportacion';
  /**
   * Deducibilidad del gasto (solo compras). Por defecto true; si es false, su
   * IVA NO entra en el bloque deducible del 303 (estilo Quipu "IVA no
   * deducible"). TODO: alimentar desde una categoria de gasto por factura
   * (hoy no hay fuente en FS; se respeta si viene informado).
   */
  deducible?: boolean;
  /** Categoria del ingreso/gasto (informativa, para deducibilidad futura). */
  categoria?: string;
  /** Desglose por tipo de IVA. */
  lineas: Array<{ tipoIva: number; base: number; cuota: number }>;
}

/** Desglose de base y cuota para un tipo de IVA. */
export interface DesgloseIva {
  tipo: number;
  base: number;
  cuota: number;
}

/** Modelo 303 — autoliquidacion de IVA (trimestral/mensual). */
export interface DatosModelo303 {
  periodo: PeriodoFiscal;
  ivaDevengado: DesgloseIva[];
  totalBaseDevengada: number;
  totalCuotaDevengada: number;
  ivaDeducible: DesgloseIva[];
  totalBaseDeducible: number;
  totalCuotaDeducible: number;
  /** Resultado = cuota devengada - cuota deducible. */
  resultado: number;
  /** Cuotas a compensar de periodos anteriores [78] (patron Quipu "a compensar"). */
  cuotasACompensarAnteriores?: number;
  /** Resultado final = resultado - cuotas a compensar [71]. */
  resultadoFinal?: number;
  /** Informacion adicional pag.3: entregas intracomunitarias [59] y exportaciones [60]. */
  entregasIntracomunitarias?: number;
  exportaciones?: number;
  /** Importes pre-calculados por casilla (para UI tipo formulario AEAT). */
  casillas: Record<string, number>;
}

/** Modelo 390 — resumen anual de IVA. */
export interface DatosModelo390 {
  ejercicio: number;
  resumenDevengado: DesgloseIva[];
  resumenDeducible: DesgloseIva[];
  totalCuotaDevengada: number;
  totalCuotaDeducible: number;
  resultadoAnual: number;
  volumenOperaciones: number;
}

/** Operacion con un tercero para el Modelo 347. */
export interface OperacionTercero {
  cifnif: string;
  nombre: string;
  tipo: 'cliente' | 'proveedor';
  baseAnual: number;
}

/** Modelo 347 — operaciones con terceros > umbral anual. */
export interface DatosModelo347 {
  ejercicio: number;
  umbral: number;
  operaciones: OperacionTercero[];
}

/** Operacion intracomunitaria para el Modelo 349. */
export interface OperacionIntracomunitaria {
  cifnif: string;
  nombre: string;
  /** Clave de operacion (E: entregas, A: adquisiciones...). */
  clave: 'E' | 'A';
  base: number;
}

/** Modelo 111 — retenciones IRPF (rendimientos del trabajo, etc.). */
export interface DatosModelo111 {
  periodo: PeriodoFiscal;
  nPerceptoresTrabajo: number;
  percepcionesTrabajo: number; // base
  retencionesTrabajo: number;
  /** Rendimientos de actividades economicas (profesionales con retencion, Alta 5). */
  nPerceptoresActividades?: number; // [07]
  percepcionesActividades?: number; // [08]
  retencionesActividades?: number; // [09] TODO: posicion exacta en fichero BOE
  totalRetenciones: number; // suma retenciones e ingresos a cuenta [casilla 28]
  resultadoIngresar: number; // [casilla 30]
}

/** Modelo 115 — retenciones por arrendamiento de inmuebles urbanos. */
export interface DatosModelo115 {
  periodo: PeriodoFiscal;
  nPerceptores: number; // [01]
  baseRetenciones: number; // [02]
  retenciones: number; // [03]
  resultadoAnteriores: number; // [04]
  resultadoIngresar: number; // [05] = [03] - [04]
}

/** Modelo 349 — operaciones intracomunitarias. */
export interface DatosModelo349 {
  periodo: PeriodoFiscal;
  operaciones: OperacionIntracomunitaria[];
  totalBase: number;
}
