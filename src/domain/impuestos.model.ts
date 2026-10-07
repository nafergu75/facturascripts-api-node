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
  /** Cuotas pendientes de compensar de periodos anteriores [110]. */
  cuotasACompensarAnteriores?: number;
  /** Parte de [110] aplicada en este periodo [78]: como mucho, el resultado positivo. */
  cuotasAplicadas?: number;
  /** Lo que queda por compensar en periodos posteriores [87] = [110] - [78]. */
  cuotasPendientesPosteriores?: number;
  /** Resultado final = resultado - cuotas aplicadas [71]. */
  resultadoFinal?: number;
  /** Informacion adicional pag.3: entregas intracomunitarias [59] y exportaciones [60]. */
  entregasIntracomunitarias?: number;
  exportaciones?: number;
  /** Importes pre-calculados por casilla (para UI tipo formulario AEAT). */
  casillas: Record<string, number>;
  /** Avisos que hay que revisar antes de presentar (tipos de IVA sin casilla...). */
  advertencias?: string[];
}

/**
 * Fila fija de cada tipo de IVA en el bloque de regimen general del 303:
 * [01]-[03] el 4 %, [04]-[06] el 10 % y [07]-[09] el 21 %. Antes se rellenaban
 * por orden de mayor a menor tipo, asi que el 21 % acababa en [01]-[03].
 */
export const FILA_303_POR_TIPO: Readonly<Record<number, 0 | 1 | 2>> = { 4: 0, 10: 1, 21: 2 };

/** Reparte el IVA devengado en las tres filas fijas; lo que no cabe va en `sinFila`. */
export function filasRegimenGeneral303(ivaDevengado: DesgloseIva[]): {
  filas: Array<DesgloseIva | null>;
  sinFila: DesgloseIva[];
} {
  const filas: Array<DesgloseIva | null> = [null, null, null];
  const sinFila: DesgloseIva[] = [];
  for (const d of ivaDevengado) {
    const i = FILA_303_POR_TIPO[d.tipo];
    if (i !== undefined) filas[i] = d;
    // Al 0 % (exentas o no sujetas) no hay cuota: no van en estas filas.
    else if (d.tipo !== 0 && (d.base !== 0 || d.cuota !== 0)) sinFila.push(d);
  }
  return { filas, sinFila };
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
  /** Importe anual de las operaciones CON IVA incluido (el nombre es historico). */
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

/**
 * Modelo 111 — retenciones IRPF (rendimientos del trabajo y de actividades
 * economicas). Lo calcula impuestosCalculo.calcularModelo111 con la fuente unica
 * de services/nominas/fiscal.ts (trabajo por fecha de pago).
 */
export interface DatosModelo111 {
  periodo: PeriodoFiscal;
  nPerceptoresTrabajo: number; // [01] perceptores distintos (por NIF)
  percepcionesTrabajo: number; // [02] base dineraria
  retencionesTrabajo: number; // [03]
  /** Rendimientos del trabajo en especie. */
  nPerceptoresEspecie?: number; // [04]
  percepcionesEspecie?: number; // [05]
  ingresosACuentaEspecie?: number; // [06]
  /** Rendimientos de actividades economicas (profesionales con retencion). */
  nPerceptoresActividades?: number; // [07]
  percepcionesActividades?: number; // [08]
  retencionesActividades?: number; // [09]
  /** Desglose de [08]/[09] por el tipo de retencion de las facturas (15 %, 7 %...). */
  actividadesPorTipo?: Array<{ porcentaje: number; perceptores: number; base: number; cuota: number }>;
  /** Parte de [02]/[03] que sale del resumen mensual antiguo (meses sin nominas por trabajador). */
  resumenAntiguo?: { bruto: number; irpf: number };
  /** Nominas en borrador con pago en el periodo (cuentan, pero aun no tienen asiento). */
  borradores?: number;
  totalRetenciones: number; // suma retenciones e ingresos a cuenta [casilla 28]
  resultadoIngresar: number; // [casilla 30]
  /** Avisos del calculo (nominas en borrador, meses solo con el resumen antiguo...). */
  avisos?: string[];
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
