/** Tipos compartidos del front (espejo de las respuestas reales del backend). */

export interface Sesion {
  token: string;
  email: string;
  esAdminGlobal: boolean;
  companyId: string; // empresa seleccionada
  empresas: EmpresaSesion[];
}

export interface EmpresaSesion {
  companyId: string;
  codigo: string;
  nombre: string;
}

export type EstadoCobro = 'pendiente' | 'parcial' | 'cobrada' | 'vencida';

export interface FacturaResumen {
  idfactura?: number | string;
  codigo?: string;
  codcliente?: string;
  nombrecliente?: string;
  fecha?: string;
  total?: number;
  codserie?: string;
  estadoCobro: EstadoCobro;
  importeCobrado: number;
  importePendiente: number;
  fechaUltimoCobro?: string;
  [key: string]: unknown;
}

export interface FiltrosFacturas {
  page?: number;
  pageSize?: number;
  desde?: string;
  hasta?: string;
  clienteCodigo?: string;
}

export interface Paginado<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClienteResumen {
  id: string;
  nombre: string;
  nif: string;
  email: string;
  telefono: string;
}

export interface CuentaBancaria {
  id: string;
  iban: string;
  bancoNombre?: string;
  subcuentaCodigo: string;
  activa: boolean;
}

export interface LineaExtracto {
  fecha: string;
  concepto: string;
  referencia?: string;
  cargo: number;
  abono: number;
  importe: number;
  saldoAcumulado: number;
  conciliado: boolean;
}

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

export interface MovimientoBancario {
  id: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia?: string;
  conciliado: boolean;
}

export interface RevisionExtracto {
  saldoExtracto: number;
  saldoContable: number;
  diferencia: number;
  cuadra: boolean;
  ingresosSinConciliar: number;
  gastosSinConciliar: number;
  movimientosSinConciliar: number;
}
