import {
  BalanceSituacion,
  CuentaPerdidasGanancias,
  EstadoCambiosPatrimonioNeto,
} from './impuesto-sociedades.model';

// Reutilizamos las estructuras de estados financieros para garantizar que las
// Cuentas Anuales (RM) y el Modelo 200 parten EXACTAMENTE de los mismos datos.
export type BalanceRM = BalanceSituacion;
export type PyGRM = CuentaPerdidasGanancias;
export type ECPNRM = EstadoCambiosPatrimonioNeto;

// --- Libros contables ---
export interface LineaLibroDiario {
  subcuenta: string;
  debe: number;
  haber: number;
}
export interface AsientoLibroDiario {
  numero: string | number;
  fecha: string;
  concepto: string;
  lineas: LineaLibroDiario[];
}
export interface LibroDiarioRM {
  ejercicio: number;
  asientos: AsientoLibroDiario[];
  totalDebe: number;
  totalHaber: number;
}

export interface PartidaInventario {
  codigo?: string;
  descripcion: string;
  importe: number;
}
export interface LibroInventarios {
  ejercicio: number;
  balanceApertura: PartidaInventario[];
  balanceCierre: PartidaInventario[];
}

// --- Estado de Flujos de Efectivo (EFE) ---
export interface PartidaFlujoEfectivo {
  codigo?: string;
  descripcion: string;
  /** positivo = entrada de efectivo, negativo = salida. */
  importe: number;
}
export interface SeccionFlujoEfectivo {
  titulo: string;
  partidas: PartidaFlujoEfectivo[];
  subtotal: number;
}
export interface EstadoFlujosEfectivo {
  flujosExplotacion: SeccionFlujoEfectivo;
  flujosInversion: SeccionFlujoEfectivo;
  flujosFinanciacion: SeccionFlujoEfectivo;
  variacionNetaEfectivo: number;
  efectivoInicial: number;
  efectivoFinal: number;
}

// --- Aplicacion del resultado ---
export interface AplicacionResultado {
  resultadoEjercicio: number;
  aReservas: number;
  aDividendos: number;
  aCompensacionPerdidas: number;
}

// --- Contenedor de Cuentas Anuales (Registro Mercantil) ---
export interface CuentasAnualesRM {
  sociedad: {
    denominacion: string;
    nif: string;
    domicilio: string;
    ejercicio: number;
    formaJuridica: string;
  };
  balance: BalanceRM;
  pyg: PyGRM;
  ecpn: ECPNRM;
  efe?: EstadoFlujosEfectivo;
  aplicacionResultado: AplicacionResultado;
  notasMemoria: string;
}
