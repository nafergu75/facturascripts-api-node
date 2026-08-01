export type EstadoPeriodo = 'abierto' | 'bloqueado' | 'cerrado';

export interface PeriodoContable {
  id: string;
  companyId: string;
  ejercicio: number;
  mes: number; // 1..12
  estado: EstadoPeriodo;
  fechaApertura: string;
  fechaCierre?: string;
}
