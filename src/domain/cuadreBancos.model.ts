/** Diferencia entre el saldo contable (57x) y el saldo del extracto de una cuenta. */
export interface DiferenciaCuentaBancaria {
  cuentaBancariaId: string;
  iban: string;
  subcuentaCodigo: string;
  saldoContable: number;
  saldoExtracto: number;
  diferencia: number; // contable - extracto
  cuadra: boolean;
}

/** Resultado del cuadre de todas las cuentas bancarias de la empresa. */
export interface CuadreBancosEmpresa {
  ejercicio: number;
  tolerancia: number;
  cuentas: DiferenciaCuentaBancaria[];
  todasCuadran: boolean;
  totalDiferencia: number;
}

/** Configuracion de cierre por empresa (controla el bloqueo por descuadre). */
export interface CierreConfig {
  exigirCuadreBancos: boolean;
  toleranciaCuadre: number; // EUR
}
