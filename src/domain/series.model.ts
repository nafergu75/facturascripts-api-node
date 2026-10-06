/**
 * Serie de numeracion de documentos (factura, rectificativa, presupuesto...).
 * Se guarda en la tabla InvoiceSeries, una fila por serie y empresa.
 */
export type TipoDocumentoSerie = 'FACTURA' | 'RECTIFICATIVA' | 'PROFORMA' | 'PEDIDO' | 'ALBARAN' | 'PRESUPUESTO';

export const TIPOS_DOCUMENTO_SERIE: readonly TipoDocumentoSerie[] = [
  'FACTURA',
  'RECTIFICATIVA',
  'PROFORMA',
  'PEDIDO',
  'ALBARAN',
  'PRESUPUESTO',
];

export interface SerieDocumento {
  id: string;
  companyId: string;
  codigo: string; // ej: 'A', 'R', 'B2026'
  descripcion: string;
  tipoDocumento: TipoDocumentoSerie;
  activa: boolean;
  porDefecto: boolean;
  /** Ultimo numero emitido en la serie (0 si aun no hay facturas finales). */
  ultimoNumero?: number;
  /** Fecha (YYYY-MM-DD) de la ultima factura finalizada en la serie. */
  ultimaFecha?: string;
  creadoEn: string;
  actualizadoEn: string;
}
