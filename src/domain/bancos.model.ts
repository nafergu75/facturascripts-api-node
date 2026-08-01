export interface CuentaBancariaEmpresa {
  id: string;
  companyId: string;
  iban: string;
  bancoNombre?: string;
  subcuentaCodigo: string; // referencia a subcuenta 572xxx
  activa: boolean;
}

export interface MovimientoBancarioImportado {
  id: string;
  companyId: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia?: string;
  origen: 'norma43' | 'csv';
  conciliado: boolean;
}
