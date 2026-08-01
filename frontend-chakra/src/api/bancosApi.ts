/**
 * API Service - Tesorería / Bancos (módulo Prisma, sin FacturaScripts).
 * Endpoints: /companies/:companyId/bancos
 *   GET  /cuentas
 *   POST /cuentas                          { iban, subcuentaCodigo, bancoNombre? }
 *   GET  /movimientos?cuentaId=
 *   POST /cuentas/:cuentaId/importar-csv   { csv }
 */

import { httpGet, httpPost } from '../utils/http';

export interface CuentaBancaria {
  id: string;
  iban: string;
  bancoNombre?: string;
  subcuentaCodigo: string;
  activa: boolean;
}

export interface MovimientoBancario {
  id: string;
  cuentaBancariaId: string;
  fecha: string;
  importe: number;
  concepto: string;
  referencia?: string;
  origen: string;
  conciliado: boolean;
}

const base = (companyId: string): string => `/companies/${companyId}/bancos`;

export function listarCuentas(companyId: string): Promise<CuentaBancaria[]> {
  return httpGet(`${base(companyId)}/cuentas`);
}

export function crearCuenta(
  companyId: string,
  datos: { iban: string; subcuentaCodigo: string; bancoNombre?: string },
): Promise<CuentaBancaria> {
  return httpPost(`${base(companyId)}/cuentas`, datos);
}

export function listarMovimientos(companyId: string, cuentaId: string): Promise<MovimientoBancario[]> {
  return httpGet(`${base(companyId)}/movimientos`, { cuentaId });
}

/** Todos los movimientos de la empresa (sin filtrar por cuenta) — para conciliación. */
export function listarTodosMovimientos(companyId: string): Promise<MovimientoBancario[]> {
  return httpGet(`${base(companyId)}/movimientos`);
}

/** Concilia un movimiento contra una factura (cobro contabilizado por la vía única). */
export function conciliarConFactura(companyId: string, movId: string, facturaId: string): Promise<unknown> {
  return httpPost(`${base(companyId)}/movimientos/${movId}/conciliar-factura`, { facturaId });
}

/** Concilia un movimiento sin documento contra una cuenta contable (555 por defecto). */
export function conciliarConCuenta(
  companyId: string,
  movId: string,
  subcuenta?: string,
  concepto?: string,
): Promise<unknown> {
  return httpPost(`${base(companyId)}/movimientos/${movId}/conciliar-cuenta`, { subcuenta, concepto });
}

export function importarCsv(
  companyId: string,
  cuentaId: string,
  csv: string,
): Promise<{ importados: number; movimientos: MovimientoBancario[] }> {
  return httpPost(`${base(companyId)}/cuentas/${cuentaId}/importar-csv`, { csv });
}
