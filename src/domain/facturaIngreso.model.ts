/**
 * Flujo "Crear ingreso" (estilo Quipu) sobre FacturaScripts. El DTO de entrada
 * mapea los pasos del tutorial: cliente (existente o nuevo), serie, fechas,
 * lineas con base/dto/IVA/retencion. NO hay modelo paralelo: la factura vive en
 * FacturaScripts (facturaclientes + lineafacturaclientes); los totales se
 * calculan con las MISMAS formulas que FS (Calculator) para que cuadre.
 */

/** Estado de la factura mapeado al vocabulario del tutorial. */
export type EstadoFacturaIngreso = 'DRAFT' | 'PENDING' | 'PAID' | 'OVERDUE';

export interface LineaIngresoDTO {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  /** Descuento de linea en %, 0 por defecto. */
  descuentoPorcentaje?: number;
  /** Tipo de IVA (21, 10, 4, 0). */
  tipoIva: number;
  /** Retencion IRPF en % (15, 7, 0...). */
  tipoRetencion?: number;
  /** Referencia de producto del catalogo (opcional). */
  productoServicioId?: string;
}

export interface ClienteNuevoDTO {
  nombreFiscal: string;
  nifCif: string;
  direccion?: string;
  pais?: string; // codpais FS (ESP por defecto)
  provincia?: string;
  municipio?: string;
  cp?: string;
  email?: string;
}

export interface CrearFacturaIngresoDTO {
  /** Cliente: usar uno existente (codcliente) o crear uno nuevo al vuelo. */
  customer: { id?: string; nuevo?: ClienteNuevoDTO };
  /** Serie (codigo, ej. 'A'); si falta se usa la serie por defecto de FACTURA. */
  serie?: string;
  fechaEmision?: string; // yyyy-mm-dd (hoy por defecto)
  fechaVencimiento?: string; // yyyy-mm-dd (emision + 15 dias por defecto)
  lineas: LineaIngresoDTO[];
  observaciones?: string;
  plantillaId?: string;
  /** Solo uso interno (rectificativas): id de la factura FS original. */
  facturaOriginalId?: string;
}

export interface LineaIngresoResp {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuentoPorcentaje: number;
  baseLine: number;
  tipoIva: number;
  ivaImporte: number;
  tipoRetencion: number;
  retencionImporte: number;
}

export interface FacturaIngresoResp {
  id: string;
  companyId: string;
  customerId: string;
  serie: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: string;
  fechaVencimiento: string;
  estado: EstadoFacturaIngreso;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  observaciones: string;
  esRectificativa: boolean;
  facturaOriginalId?: string;
  lineas: LineaIngresoResp[];
}
