/**
 * Ajustes de la pantalla Configuración: valores por defecto de facturación y
 * ajustes fiscales que cambian el calendario de modelos.
 */

/** Formas de pago que se imprimen en la factura. */
export const FORMAS_PAGO = ['TRANSFERENCIA', 'GIRO', 'CONTADO'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

/** IRPF habitual que se puede proponer en las líneas (solo empresas españolas). */
export const IRPF_PERMITIDOS = [0, 1, 2, 7, 15, 19] as const;

export const DIAS_VENCIMIENTO_MAX = 365;
export const TEXTO_PIE_MAX = 500;

export interface AjustesFacturacion {
  formaPago: FormaPago;
  diasVencimiento: number;
  irpfDefecto: number;
  /** Cuenta que sale en la factura; null = automática (la primera activa en la moneda de la factura). */
  cuentaBancariaId: string | null;
  mostrarIban: boolean;
  textoPie: string | null;
}

export const AJUSTES_FACTURACION_POR_DEFECTO: Readonly<AjustesFacturacion> = Object.freeze({
  formaPago: 'TRANSFERENCIA',
  diasVencimiento: 30,
  irpfDefecto: 0,
  cuentaBancariaId: null,
  mostrarIban: true,
  textoPie: null,
});

export const PERIODICIDADES_IVA = ['TRIMESTRAL', 'MENSUAL'] as const;
export type PeriodicidadIva = (typeof PERIODICIDADES_IVA)[number];

export interface AjustesFiscales {
  periodicidadIva: PeriodicidadIva;
  redeme: boolean;
  sii: boolean;
  granEmpresa: boolean;
  /** Todavía no se aplican en los asientos ni en el 303 (v2): siempre su valor por defecto. */
  recargoEquivalencia: boolean;
  criterioCaja: boolean;
  prorrata: number | null;
}

export const AJUSTES_FISCALES_POR_DEFECTO: Readonly<AjustesFiscales> = Object.freeze({
  periodicidadIva: 'TRIMESTRAL',
  redeme: false,
  sii: false,
  granEmpresa: false,
  recargoEquivalencia: false,
  criterioCaja: false,
  prorrata: null,
});

/** Volumen de operaciones a partir del cual se es gran empresa (art. 71.3 RIVA). */
export const UMBRAL_GRAN_EMPRESA = '6.010.121,04 €';

/** Ajustes fiscales a partir de la fila guardada (o los de por defecto si no hay). */
export function ajustesFiscalesDeFila(
  fila: {
    periodicidadIva: string;
    redeme: boolean;
    sii: boolean;
    granEmpresa: boolean;
    recargoEquivalencia: boolean;
    criterioCaja: boolean;
    prorrata: unknown;
  } | null,
): AjustesFiscales {
  if (!fila) return { ...AJUSTES_FISCALES_POR_DEFECTO };
  return {
    periodicidadIva: fila.periodicidadIva === 'MENSUAL' ? 'MENSUAL' : 'TRIMESTRAL',
    redeme: fila.redeme,
    sii: fila.sii,
    granEmpresa: fila.granEmpresa,
    recargoEquivalencia: fila.recargoEquivalencia,
    criterioCaja: fila.criterioCaja,
    prorrata: fila.prorrata === null || fila.prorrata === undefined ? null : Number(fila.prorrata),
  };
}
