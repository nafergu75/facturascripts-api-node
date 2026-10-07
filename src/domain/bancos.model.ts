export interface CuentaBancariaEmpresa {
  id: string;
  companyId: string;
  iban: string;
  bancoNombre?: string;
  subcuentaCodigo: string; // referencia a subcuenta 572xxx
  activa: boolean;
  /** Moneda de la cuenta (ISO 4217): la de la contabilidad de la empresa. */
  moneda?: string;
}

export interface MovimientoBancarioImportado {
  id: string;
  companyId: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia?: string;
  origen: 'norma43' | 'csv' | 'excel';
  conciliado: boolean;
}
