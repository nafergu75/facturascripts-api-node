/**
 * Serie de numeracion de documentos (factura, pedido, etc.). En FacturaScripts
 * equivale al recurso `series` (campo `codserie`). Aqui se gestiona la serie
 * elegible por el usuario al facturar.
 *
 * NOTA: companyId es STRING en toda la API (req.companyId), aunque el prompt lo
 * describiese como number. Se mantiene string por coherencia con el resto.
 */
export interface SerieDocumento {
  id: string;
  companyId: string;
  codigo: string; // ej: 'A', 'B2026', 'FCTA' -> mapea a FS codserie
  descripcion: string;
  tipoDocumento: 'FACTURA' | 'PEDIDO' | 'ALBARAN' | 'PRESUPUESTO';
  activa: boolean;
  porDefecto: boolean;
  creadoEn: string;
  actualizadoEn: string;
}
