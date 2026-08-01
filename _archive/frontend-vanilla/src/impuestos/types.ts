/**
 * Tipos del frontend de Impuestos. Espejan las respuestas REALES del backend
 * (src/domain/impuestosModulo.model.ts). companyId es STRING en toda la API.
 */
export type EstadoModeloImpuesto = 'vigente' | 'expirado' | 'omitido' | 'presentado';

export interface ModeloImpuestoResumen {
  id: string;
  companyId: string;
  codigo: string; // '303', '390', '347', '349', '111', '115', '200'
  descripcion: string;
  ejercicio: number;
  periodo: string; // '1T'..'4T' | '0A'
  periodoEtiqueta: string; // '2026Q1' | '2026'
  estado: EstadoModeloImpuesto;
  fechaVencimiento: string;
  diasHastaVencimiento?: number;
  diasDesdeVencimiento?: number;
  tieneBorrador: boolean;
  origen?: 'autorrelleno' | 'manual-mixto';
}

export interface FichaModeloImpuesto {
  modeloCodigo: string;
  titulo: string;
  textoExplicativo: string;
  advertencias: string[];
  notasConfiguracion: string[];
  recomendaciones: string[];
}

export type Casillas = Record<string, number | string | null>;

export interface ModeloImpuestoDetalle {
  resumen: ModeloImpuestoResumen;
  ficha: FichaModeloImpuesto;
  casillas: Casillas;
  origen: 'autorrelleno' | 'manual-mixto';
}

export type TabImpuestos = 'activos' | 'omitidos' | 'presentados';
