/**
 * Modelo del "lector de facturas": una factura subida (PDF/imagen/XML) de la que
 * se extraen datos (OCR/servicio externo) para proponer un borrador y, si se
 * confirma, generar la contabilidad por el MISMO camino que una factura manual.
 *
 * NOTA: companyId es STRING en toda la API (req.companyId), aunque el prompt lo
 * describiera como number; se mantiene string por coherencia.
 */
export type TipoFacturaDetectada = 'venta' | 'compra' | 'desconocido';

export interface LineaFacturaLeida {
  descripcion: string;
  cantidad: number;
  baseImponible?: number;
  tipoIva?: number;
  importeIva?: number;
  totalLinea?: number;
}

export interface FacturaLeida {
  id: string;
  companyId: string;
  tipoDetectado: TipoFacturaDetectada;
  origen: 'upload' | 'email' | 'api';

  nombreArchivo: string;
  mimeType: string;
  rutaAlmacenamiento: string;

  // Datos extraidos por el OCR/servicio externo
  numero?: string;
  fecha?: string; // yyyy-mm-dd
  nifEmisor?: string;
  nombreEmisor?: string;
  nifReceptor?: string;
  nombreReceptor?: string;

  lineas: LineaFacturaLeida[];

  totalBase?: number;
  totalIva?: number;
  totalFactura?: number;

  /** Estado del flujo del lector. */
  estado: 'pendiente_revision' | 'confirmada' | 'descartada';

  /**
   * Aviso cuando el OCR/extraccion NO ha podido detectar datos (numero, fecha,
   * NIFs, totales todos vacios). El frontend lo muestra para que el usuario
   * sepa que debe completar el borrador a mano (PUT) en vez de pensar que la
   * subida ha fallado.
   */
  avisoLectura?: string;

  /** Enlace a la factura "oficial" creada en el sistema (si se confirma). */
  facturaId?: string;

  creadaEn: string;
  actualizadaEn: string;
}

/**
 * Forma ESPERADA de la salida de un OCR / servicio de extraccion de facturas
 * (ej. AWS Textract AnalyzeExpense, Google Document AI, Mindee, Veryfi...).
 * `procesarFacturaSubida` mapeara esto a `FacturaLeida`. Hoy es un TODO: el
 * conector real se enchufa en extraerDatosFactura().
 */
export interface SalidaOCRFactura {
  numero?: string;
  fecha?: string;
  nifEmisor?: string;
  nombreEmisor?: string;
  nifReceptor?: string;
  nombreReceptor?: string;
  lineas?: LineaFacturaLeida[];
  totalBase?: number;
  totalIva?: number;
  totalFactura?: number;
}
