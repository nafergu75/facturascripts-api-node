/**
 * Serie de numeracion de documentos: facturas, rectificativas y proformas.
 * Se guarda en la tabla InvoiceSeries, una fila por serie y empresa.
 * (Antes se aceptaban tambien PEDIDO, ALBARAN y PRESUPUESTO, pero la app no
 * tiene esos documentos: una serie de esos tipos no numeraba nada.)
 */
export type TipoDocumentoSerie = 'FACTURA' | 'RECTIFICATIVA' | 'PROFORMA';

export const TIPOS_DOCUMENTO_SERIE: readonly TipoDocumentoSerie[] = ['FACTURA', 'RECTIFICATIVA', 'PROFORMA'];

export const esTipoDocumentoSerie = (t: unknown): t is TipoDocumentoSerie =>
  typeof t === 'string' && (TIPOS_DOCUMENTO_SERIE as readonly string[]).includes(t);

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
