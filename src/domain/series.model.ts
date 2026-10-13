/**
 * Serie de numeracion de documentos: facturas, rectificativas y proformas.
 * Se guarda en la tabla InvoiceSeries, una fila por serie y empresa.
 * (Antes se aceptaban tambien PEDIDO, ALBARAN y PRESUPUESTO, pero la app no
 * tiene esos documentos: una serie de esos tipos no numeraba nada.)
 *
 * RECTIFICATIVA_SIMPLIFICADA: rectificativas de tickets y facturas
 * simplificadas (R5). Tienen que ir en una serie distinta de la de las
 * rectificativas de facturas completas (art. 7.1.a RD 1619/2012). No se crea
 * sola en todas las empresas: la primera R5 crea la RT.
 */
export type TipoDocumentoSerie = 'FACTURA' | 'RECTIFICATIVA' | 'RECTIFICATIVA_SIMPLIFICADA' | 'PROFORMA';

export const TIPOS_DOCUMENTO_SERIE: readonly TipoDocumentoSerie[] = ['FACTURA', 'RECTIFICATIVA', 'RECTIFICATIVA_SIMPLIFICADA', 'PROFORMA'];

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
  /** Numero que llevara el proximo documento (ultimoNumero + 1). Solo en la lista de la API. */
  numeroSiguiente?: number;
  /** Documentos ya numerados en la serie (facturas emitidas o registradas y proformas). Solo en la lista de la API. */
  documentos?: number;
  creadoEn: string;
  actualizadoEn: string;
}
