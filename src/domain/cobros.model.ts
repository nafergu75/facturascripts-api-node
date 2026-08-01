export type EstadoCobro = 'pendiente' | 'parcial' | 'cobrada' | 'vencida';

/** Cobro parcial o total imputado a una factura. */
export interface Cobro {
  id: string;
  companyId: string;
  facturaId: string;
  importe: number;
  fecha: string; // yyyy-mm-dd
}

/** Resumen del estado de cobro de una factura (se anexa al listado de facturas). */
export interface EstadoCobroFactura {
  estadoCobro: EstadoCobro;
  importeCobrado: number;
  importePendiente: number;
  fechaUltimoCobro?: string;
}
