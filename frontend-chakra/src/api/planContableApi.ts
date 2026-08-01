/**
 * API Service - Plan contable (Prisma/memoria, sin FacturaScripts).
 *   GET  /plan-contable/base/cuentas                          (público) cuentas PGC base
 *   GET  /companies/:companyId/plan-contable/subcuentas       subcuentas de la empresa
 *   POST /companies/:companyId/plan-contable/subcuentas       { codigo, nombre, cuentaBaseCodigo }
 *   POST /companies/:companyId/plan-contable/subcuentas/gasto-rapido  { cuentaBaseCodigo, nombre }
 */

import { httpGet, httpPost } from '../utils/http';

export type TipoCuenta = 'activo' | 'pasivo' | 'patrimonio_neto' | 'gasto' | 'ingreso' | string;

export interface CuentaBase {
  codigo: string;
  nombre: string;
  subgrupoCodigo: string;
  tipo: TipoCuenta;
}

export interface SubcuentaEmpresa {
  id: string;
  codigo: string;
  nombre: string;
  cuentaBaseCodigo: string;
  activa: boolean;
  analitica?: string;
}

export function listarCuentasBase(): Promise<CuentaBase[]> {
  return httpGet('/plan-contable/base/cuentas');
}

export function listarSubcuentas(companyId: string): Promise<SubcuentaEmpresa[]> {
  return httpGet(`/companies/${companyId}/plan-contable/subcuentas`);
}

export function crearSubcuenta(
  companyId: string,
  datos: { codigo: string; nombre: string; cuentaBaseCodigo: string },
): Promise<SubcuentaEmpresa> {
  return httpPost(`/companies/${companyId}/plan-contable/subcuentas`, datos);
}

export function crearSubcuentaGasto(
  companyId: string,
  datos: { cuentaBaseCodigo: string; nombre: string; sufijoOpcional?: string },
): Promise<SubcuentaEmpresa> {
  return httpPost(`/companies/${companyId}/plan-contable/subcuentas/gasto-rapido`, datos);
}
