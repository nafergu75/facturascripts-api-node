export type TipoVencimiento = 'cobro' | 'pago';
export type EstadoVencimiento = 'pendiente' | 'liquidado';

/** Vencimiento de cobro (venta) o pago (compra) derivado de una factura. */
export interface Vencimiento {
  id: string;
  companyId: string;
  facturaId: string;
  tipo: TipoVencimiento;
  numero: number; // 1..N (plazos)
  fecha: string; // yyyy-mm-dd fecha de vencimiento
  importe: number;
  formaPago: string;
  estado: EstadoVencimiento;
  fechaLiquidacion?: string;
}
