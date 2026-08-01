export type TipoDocumento = 'FACTURA' | 'PEDIDO' | 'ALBARAN' | 'PRESUPUESTO';

export const TIPOS_DOCUMENTO: TipoDocumento[] = ['FACTURA', 'PEDIDO', 'ALBARAN', 'PRESUPUESTO'];

export interface CampoDocumento {
  id: string;
  tipo: 'texto' | 'fecha' | 'numero' | 'importe' | 'tabla';
  origen: 'empresa' | 'cliente' | 'factura' | 'linea' | 'fijo';
  /** ej: 'empresa.nombre', 'cliente.nif', 'factura.serie', 'linea.descripcion'. */
  pathOrigen?: string;
  /** valor fijo cuando origen === 'fijo'. */
  valorFijo?: string;
  etiqueta: string;
  visible: boolean;
  orden: number;
}

export interface SeccionDocumento {
  nombre: 'encabezado' | 'cuerpo' | 'pie' | 'observaciones';
  campos: CampoDocumento[];
}

export interface PlantillaDocumento {
  id: string;
  companyId: string;
  tipoDocumento: TipoDocumento;
  nombre: string;
  idioma?: string;
  secciones: SeccionDocumento[];
  predeterminada: boolean;
  creadoEn: string;
  actualizadoEn: string;
}
