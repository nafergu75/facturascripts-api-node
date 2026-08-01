// Modelo de dominio para el Impuesto sobre Sociedades (Modelo 200) y los
// estados financieros base (balance, PyG, ECPN) sobre los que se construye.

export interface PeriodoFiscalIS {
  ejercicio: number;
  fechaInicio: string;
  fechaFin: string;
}

export interface BalancePartida {
  codigo?: string;
  descripcion: string;
  importe: number;
}

export interface BalanceSituacion {
  activoNoCorriente: BalancePartida[];
  activoCorriente: BalancePartida[];
  patrimonioNeto: BalancePartida[];
  pasivoNoCorriente: BalancePartida[];
  pasivoCorriente: BalancePartida[];
  totalActivo: number;
  totalPatrimonioNetoYPasivo: number;
}

export interface CuentaPerdidasGanancias {
  importeNetoCifraNegocios: number;
  otrosIngresosExplotacion: number;
  aprovisionamientos: number;
  gastosPersonal: number;
  otrosGastosExplotacion: number;
  amortizaciones: number;
  resultadoExplotacion: number;
  ingresosFinancieros: number;
  gastosFinancieros: number;
  resultadoFinanciero: number;
  resultadoAntesImpuestos: number;
  impuestoBeneficios: number;
  resultadoEjercicio: number;
}

export interface EstadoCambiosPatrimonioNeto {
  capital: number;
  reservas: number;
  resultadoEjercicio: number;
  otrasPartidas: number;
  totalPatrimonioNeto: number;
}

export interface AjusteExtracontable {
  descripcion: string;
  importe: number;
  tipo: 'permanente' | 'temporal';
  sentido: '+' | '-';
}

export interface DatosModelo200 {
  nif: string;
  razonSocial: string;
  ejercicio: number;
  periodo: PeriodoFiscalIS;
  claveEntidad: string;

  balance: BalanceSituacion;
  pyg: CuentaPerdidasGanancias;

  resultadoContableAntesImpuestos: number;
  ajustesExtracontables: AjusteExtracontable[];
  baseImponiblePrevia: number;
  basesNegativasCompensables: number;
  baseImponibleFinal: number;
  tipoGravamen: number;
  cuotaIntegra: number;
  deduccionesBonificaciones: number;
  pagosFraccionadosRetenciones: number;
  cuotaLiquida: number;
  cuotaADepositarODevolver: number;
  /** Limitaciones del calculo automatico que el usuario debe revisar antes de presentar. */
  advertencias: string[];
}
