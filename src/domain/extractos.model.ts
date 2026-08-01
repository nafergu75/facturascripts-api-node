/** Una linea del extracto bancario con saldo acumulado calculado. */
export interface LineaExtracto {
  fecha: string;
  concepto: string;
  referencia?: string;
  cargo: number; // importe negativo (salida) en positivo, 0 si es abono
  abono: number; // importe positivo (entrada), 0 si es cargo
  importe: number; // con signo (abono +, cargo -)
  saldoAcumulado: number;
  conciliado: boolean;
}

/** Extracto bancario de una cuenta en un rango de fechas. */
export interface ExtractoBancario {
  cuentaBancariaId: string;
  iban: string;
  subcuentaCodigo: string;
  desde?: string;
  hasta?: string;
  saldoInicial: number;
  saldoFinal: number;
  totalCargos: number;
  totalAbonos: number;
  numMovimientos: number;
  lineas: LineaExtracto[];
}

/**
 * Revision de gastos/ingresos del extracto frente a la contabilidad: compara el
 * saldo del extracto con el saldo contable de la subcuenta 57x y separa
 * movimientos pendientes de conciliar (posibles apuntes no contabilizados).
 */
export interface RevisionExtractoContable {
  cuentaBancariaId: string;
  subcuentaCodigo: string;
  saldoExtracto: number;
  saldoContable: number;
  diferencia: number;
  cuadra: boolean;
  ingresosSinConciliar: number;
  gastosSinConciliar: number;
  movimientosSinConciliar: number;
}
