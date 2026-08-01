/**
 * Modulo "Impuestos" estilo Quipu: calendario de modelos tributarios con estados
 * (vigente=verde / expirado=naranja / omitido / presentado), autorrelleno desde
 * la contabilidad y edicion manual de casillas.
 *
 * NOTA: companyId es STRING en toda la API (req.companyId), aunque el prompt lo
 * describiera como number; se mantiene string por coherencia.
 */
export type EstadoModeloImpuesto = 'vigente' | 'expirado' | 'omitido' | 'presentado';

export interface ModeloImpuestoResumen {
  id: string;
  companyId: string;
  codigo: string; // '303', '390', '347', '349', '111', '115', '200'
  descripcion: string;
  ejercicio: number;
  periodo: string; // '1T'..'4T' | '0A'
  /** Periodo legible estilo Quipu, ej. '2026Q1' o '2026'. */
  periodoEtiqueta: string;
  estado: EstadoModeloImpuesto;
  /** Fecha limite de presentacion (yyyy-mm-dd). */
  fechaVencimiento: string;
  /** Si aun no ha vencido: dias que quedan (modelo "verde"). */
  diasHastaVencimiento?: number;
  /** Si ya ha vencido: dias transcurridos (modelo "naranja"). */
  diasDesdeVencimiento?: number;
  /** Si hay casillas guardadas (borrador autorrelleno o manual). */
  tieneBorrador: boolean;
  origen?: 'autorrelleno' | 'manual-mixto';
}

/** Texto explicativo del modelo (como la cabecera informativa del video). */
export interface FichaModeloImpuesto {
  modeloCodigo: string;
  titulo: string;
  textoExplicativo: string;
  advertencias: string[];
  notasConfiguracion: string[];
  recomendaciones: string[];
}

export interface ModeloImpuestoDetalle {
  resumen: ModeloImpuestoResumen;
  ficha: FichaModeloImpuesto;
  /** Casillas del modelo: '01', '03', 'config_nif', 'config_iban'... */
  casillas: Record<string, number | string | null>;
  /**
   * 'autorrelleno'  -> tal cual lo calculo el sistema (se guarda automaticamente).
   * 'manual-mixto'  -> el usuario edito casillas; NO se recalculan los totales
   *                    dependientes (debe hacerlo a mano, como en el video).
   */
  origen: 'autorrelleno' | 'manual-mixto';
}
