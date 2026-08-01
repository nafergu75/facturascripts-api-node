/**
 * API Service - Modelo 200 / Impuesto de Sociedades (Prisma, sin FacturaScripts).
 *   GET /companies/:companyId/modelo-200/preview?ejercicio=
 *   GET /companies/:companyId/modelo-200/fichero?ejercicio=&nif=   (TXT BOE)
 */

import { httpGet } from '../utils/http';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

export interface DatosModelo200 {
  nif: string;
  razonSocial: string;
  ejercicio: number;
  resultadoContableAntesImpuestos: number;
  baseImponiblePrevia: number;
  basesNegativasCompensables: number;
  baseImponibleFinal: number;
  tipoGravamen: number;
  cuotaIntegra: number;
  deduccionesBonificaciones: number;
  pagosFraccionadosRetenciones: number;
  cuotaLiquida: number;
  cuotaADepositarODevolver: number;
  advertencias: string[];
}

export function getModelo200(companyId: string, ejercicio: number): Promise<DatosModelo200> {
  return httpGet(`/companies/${companyId}/modelo-200/preview`, { ejercicio });
}

export async function descargarFicheroModelo200(companyId: string, ejercicio: number, nif: string): Promise<void> {
  const token = localStorage.getItem('jwt_token');
  const url = new URL(`${API_BASE_URL}/companies/${companyId}/modelo-200/fichero`);
  url.searchParams.append('ejercicio', String(ejercicio));
  if (nif) url.searchParams.append('nif', nif);
  const res = await fetch(url.toString(), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error('No se pudo descargar el fichero del Modelo 200.');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `200_${ejercicio}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}
