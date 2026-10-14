// Placeholder. Los campos reales se mapearan al integrar la API de FacturaScripts.
export interface Producto {
  referencia?: string;
  descripcion?: string;
  precio?: number;
  /** Plantilla A: unidades por pack (propone Uds = packs x unidades). Entero de 1 a 100.000. */
  unidadesPorPack?: number | null;
  /** Plantilla A: kg de plastico no reciclado POR UNIDAD (IEEPNR), de 0 a 1.000 y hasta 6 decimales. */
  kgPlasticoUnidad?: number | null;
  /** Plantilla A: el articulo lleva IEEPNR (se proponen sus kg en la factura). */
  llevaIeepnr?: boolean;
  /** Texto adicional del articulo en la factura: hasta 500 caracteres y 6 lineas. */
  textoFactura?: string | null;
  [key: string]: unknown;
}
