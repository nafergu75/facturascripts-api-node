import { randomUUID } from 'crypto';
import { AlertaCompliance, NivelAlerta } from '../domain/compliance.model';
import { calcularModelo303, calcularModelo347 } from './impuestosCalculo.service';
import { badRequest } from '../utils/http-errors';
import { PeriodoFiscal } from '../domain/impuestos.model';

const UMBRAL_347 = 3005.06;

const TRIMESTRES: Record<string, [string, string]> = {
  '1T': ['01-01', '03-31'],
  '2T': ['04-01', '06-30'],
  '3T': ['07-01', '09-30'],
  '4T': ['10-01', '12-31'],
};

/** Construye un PeriodoFiscal a partir de ejercicio + periodo (1T..4T, 01..12, 0A). Movido desde aeat.controller (archivado en el cleanup del spine FS). */
function construirPeriodo(ejercicioRaw: unknown, periodoRaw: unknown): PeriodoFiscal {
  const ejercicio = Number(ejercicioRaw);
  if (!Number.isInteger(ejercicio) || ejercicio < 2000) {
    throw badRequest('Parametro "ejercicio" invalido.');
  }
  const periodo = String(periodoRaw ?? '0A').toUpperCase();

  if (periodo === '0A') {
    return { ejercicio, periodo, tipo: 'anual', fechaInicio: `${ejercicio}-01-01`, fechaFin: `${ejercicio}-12-31` };
  }
  if (TRIMESTRES[periodo]) {
    const [ini, fin] = TRIMESTRES[periodo];
    return { ejercicio, periodo, tipo: 'trimestral', fechaInicio: `${ejercicio}-${ini}`, fechaFin: `${ejercicio}-${fin}` };
  }
  const mes = periodo.padStart(2, '0');
  const mesNum = Number(mes);
  if (mesNum >= 1 && mesNum <= 12) {
    const ultimoDia = new Date(ejercicio, mesNum, 0).getDate();
    return {
      ejercicio,
      periodo: mes,
      tipo: 'mensual',
      fechaInicio: `${ejercicio}-${mes}-01`,
      fechaFin: `${ejercicio}-${mes}-${String(ultimoDia).padStart(2, '0')}`,
    };
  }
  throw badRequest('Parametro "periodo" invalido (use 1T..4T, 01..12 o 0A).');
}

function alerta(
  companyId: string,
  ejercicio: number,
  codigo: string,
  mensaje: string,
  nivel: NivelAlerta,
  datos?: Record<string, unknown>,
): AlertaCompliance {
  return { id: randomUUID(), companyId, ejercicio, codigo, mensaje, nivel, datos, creadaEn: new Date().toISOString() };
}

/**
 * Genera alertas de compliance en vivo combinando IVA (303), 347 y plazos.
 * TODO: ampliar con 349, Modelo 200, y persistir (listarAlertasGuardadas).
 */
export async function generarAlertasCompliance(companyId: string, ejercicio: number): Promise<AlertaCompliance[]> {
  const alertas: AlertaCompliance[] = [];

  // 1) Variacion brusca de IVA devengado entre trimestres (> 40%)
  let cuotaPrevia: number | null = null;
  for (const t of ['1T', '2T', '3T', '4T']) {
    const periodo = construirPeriodo(ejercicio, t);
    const m303 = await calcularModelo303(companyId, periodo);
    const cuota = m303.totalCuotaDevengada;
    if (cuotaPrevia !== null && cuotaPrevia > 0) {
      const variacion = ((cuota - cuotaPrevia) / cuotaPrevia) * 100;
      if (Math.abs(variacion) >= 40) {
        alertas.push(
          alerta(companyId, ejercicio, 'IVA_VARIACION_BRUSCA',
            `El IVA devengado de ${t} varia ${variacion.toFixed(0)}% respecto al trimestre anterior.`,
            Math.abs(variacion) >= 100 ? 'critical' : 'warning',
            { trimestre: t, cuota, cuotaPrevia }),
        );
      }
    }
    cuotaPrevia = cuota;
  }

  // 2) Umbral del 347 (3.005,06 € anuales por tercero)
  const m347 = await calcularModelo347(companyId, ejercicio, UMBRAL_347 * 0.8);
  for (const op of m347.operaciones) {
    if (op.baseAnual >= UMBRAL_347) {
      alertas.push(
        alerta(companyId, ejercicio, 'OBLIGADO_347',
          `Operaciones con ${op.nombre} (${op.cifnif}) suman ${op.baseAnual} € -> declarar en el 347.`,
          'info', { cifnif: op.cifnif, baseAnual: op.baseAnual }),
      );
    } else {
      alertas.push(
        alerta(companyId, ejercicio, 'LIMITE_347_CERCANO',
          `Operaciones con ${op.nombre} (${op.cifnif}) suman ${op.baseAnual} €, cerca del umbral del 347 (${UMBRAL_347} €).`,
          'warning', { cifnif: op.cifnif, baseAnual: op.baseAnual }),
      );
    }
  }

  // 3) TODO: avisos de plazos de presentacion (303 trimestral ~dia 20, 347 en febrero, etc.)
  return alertas;
}

/** TODO: recuperar alertas persistidas (cuando se guarden en BD). */
export async function listarAlertasGuardadas(_companyId: string, _ejercicio: number): Promise<AlertaCompliance[]> {
  return [];
}
