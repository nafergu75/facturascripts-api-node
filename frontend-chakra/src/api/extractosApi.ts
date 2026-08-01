/**
 * API Service - Extractos bancarios (Prisma /extractos, sin FacturaScripts).
 * Endpoints: /companies/:companyId/extractos/cuentas/:cuentaId
 *   GET /extracto?desde&hasta&saldoInicial     extracto con saldo acumulado
 *   GET /extracto.csv                           descarga CSV
 *   GET /revision?ejercicio&desde&hasta         revisión vs contabilidad
 */

import { httpGet } from '../utils/http';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

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

export interface FiltrosExtracto {
  desde?: string;
  hasta?: string;
  saldoInicial?: number;
}

const base = (companyId: string, cuentaId: string): string => `/companies/${companyId}/extractos/cuentas/${cuentaId}`;

export function getExtracto(companyId: string, cuentaId: string, filtros: FiltrosExtracto = {}): Promise<ExtractoBancario> {
  return httpGet(`${base(companyId, cuentaId)}/extracto`, filtros as Record<string, string | number | undefined>);
}

export function getRevision(
  companyId: string,
  cuentaId: string,
  params: { ejercicio: number; desde?: string; hasta?: string },
): Promise<RevisionExtractoContable> {
  return httpGet(`${base(companyId, cuentaId)}/revision`, params as Record<string, string | number | undefined>);
}

/** Descarga el extracto CSV (fetch con auth -> blob -> descarga). */
export async function descargarExtractoCsv(companyId: string, cuentaId: string, filtros: FiltrosExtracto = {}): Promise<void> {
  const token = localStorage.getItem('jwt_token');
  const url = new URL(`${API_BASE_URL}${base(companyId, cuentaId)}/extracto.csv`);
  Object.entries(filtros).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, String(v));
  });
  const res = await fetch(url.toString(), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('No se pudo descargar el extracto.');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `extracto_${cuentaId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
