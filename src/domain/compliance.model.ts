export type NivelAlerta = 'info' | 'warning' | 'critical';

export interface AlertaCompliance {
  id: string;
  companyId: string;
  ejercicio: number;
  codigo: string; // 'IVA_VARIACION_BRUSCA', 'LIMITE_347_CERCANO', 'OBLIGADO_347', ...
  mensaje: string;
  nivel: NivelAlerta;
  datos?: Record<string, unknown>;
  creadaEn: string;
}
