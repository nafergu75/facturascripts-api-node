/**
 * API Service - Periodos y cierre de ejercicio (Prisma /periodos).
 * El cierre crea los asientos de regularización/cierre/apertura en Prisma.
 * Endpoints: /companies/:companyId/periodos
 *   GET  /?ejercicio=
 *   PUT  /:mes/estado?ejercicio=   { estado }
 *   POST /cierre?ejercicio=
 */

import { httpGet, httpPost, httpPut } from '../utils/http';

export type EstadoPeriodo = 'abierto' | 'bloqueado' | 'cerrado';

export interface PeriodoContable {
  id: string;
  ejercicio: number;
  mes: number;
  estado: EstadoPeriodo;
  fechaApertura: string;
  fechaCierre?: string;
}

export interface ResultadoCierre {
  asientoRegularizacionId: string;
  asientoCierreId: string;
  asientoAperturaId: string;
  resultadoEjercicio: number;
}

const base = (companyId: string): string => `/companies/${companyId}/periodos`;

export function listarPeriodos(companyId: string, ejercicio: number): Promise<PeriodoContable[]> {
  return httpGet(base(companyId), { ejercicio });
}

export function cambiarEstadoPeriodo(
  companyId: string,
  ejercicio: number,
  mes: number,
  estado: EstadoPeriodo,
): Promise<PeriodoContable> {
  return httpPut(`${base(companyId)}/${mes}/estado?ejercicio=${ejercicio}`, { estado });
}

export function cerrarEjercicio(companyId: string, ejercicio: number): Promise<ResultadoCierre> {
  return httpPost(`${base(companyId)}/cierre?ejercicio=${ejercicio}`, {});
}
