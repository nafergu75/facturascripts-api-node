// Representacion ligera de una factura tal como la devuelve el listado de FS.
export interface Factura {
  codigo?: string;
  codcliente?: string;
  fecha?: string;
  total?: number;
  [key: string]: unknown;
}

/**
 * Linea de factura en clave CONTABLE (ya leida de FacturaScripts y normalizada),
 * con la base e IVA desglosados por tipo. No es el DTO de creacion.
 */
export interface LineaFacturaContable {
  productoCodigo?: string;
  familiaProducto?: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  /** Tipo de IVA en porcentaje: 21, 10, 4, 0... */
  tipoIva: number;
  baseImponible: number;
  importeIva: number;
  /** Retencion IRPF (Hallazgo 4). Porcentaje e importe. */
  irpf?: number;
  importeIrpf?: number;
  /** Recargo de equivalencia (Hallazgo 4). Porcentaje e importe. */
  recargoEquivalencia?: number;
  importeRecargo?: number;
}

/**
 * Factura en clave contable: lo que necesita el motor de asientos.
 */
export interface FacturaContable {
  idFactura: string | number;
  tipo: 'venta' | 'compra';
  /** codcliente o codproveedor segun el tipo. */
  codigoTercero: string;
  fecha: string;
  formaPago: string;
  lineas: LineaFacturaContable[];

  // Agregados de resumen
  totalBase: number;
  totalIva: number;
  /** Total de retencion IRPF (resta del total a pagar). Hallazgo 4. */
  totalIrpf?: number;
  /** Total de recargo de equivalencia (suma al total a pagar). Hallazgo 4. */
  totalRecargo?: number;
  totalFactura: number;

  /** Divisa original del documento y tipo de cambio a EUR (Hallazgo 6). */
  divisaOriginal?: string;
  tipoCambio?: number;
}
