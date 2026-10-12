/**
 * Aviso fijo del panel de «Traer la contabilidad de 2026» (A4):
 *
 *  - A_MEDIAS (rojo): una carga se quedo importandose a medias.
 *  - FALTAN_DATOS (ambar): la carga vigente se trajo con datos por completar;
 *    hasta 5 puntos y el total.
 *  - INVITACION: empresa española sin carga ni plan anterior traido, a la que
 *    conviene traer la contabilidad de la gestoria antes de dar de alta
 *    clientes o proveedores.
 *  - null: nada que avisar (todo correcto o empresa extranjera).
 */
import { prisma } from '../../config/database';
import { ENLACE_ARRANQUE } from '../periodos.service';
import { esEmpresaEspanola } from '../perfilEmpresa.service';
import { EJERCICIO_ARRANQUE } from './analisis.service';
import type { PuntoComprobacion } from './comprobaciones';

export interface AvisoArranque {
  nivel: 'A_MEDIAS' | 'FALTAN_DATOS' | 'INVITACION';
  texto: string;
  puntos: string[];
  total: number;
  enlace: string;
}

const MAX_PUNTOS = 5;

export async function avisoArranque(companyId: string): Promise<AvisoArranque | null> {
  if (!(await esEmpresaEspanola(companyId))) return null;
  const anio = EJERCICIO_ARRANQUE - 1;
  const [aplicando, vigente] = await Promise.all([
    prisma.cargaArranque.findFirst({ where: { companyId, ejercicio: EJERCICIO_ARRANQUE, estado: 'APLICANDO' }, select: { version: true } }),
    prisma.cargaArranque.findFirst({ where: { companyId, ejercicio: EJERCICIO_ARRANQUE, estado: 'CONFIRMADA' }, select: { resumen: true } }),
  ]);
  if (aplicando) {
    return {
      nivel: 'A_MEDIAS',
      texto: `La importación de la contabilidad de ${anio} se quedó a medias. Entra para seguir donde se quedó o para deshacerla.`,
      puntos: [],
      total: 0,
      enlace: ENLACE_ARRANQUE,
    };
  }
  if (vigente) {
    const resumen = (vigente.resumen ?? {}) as { confirmacion?: { comprobaciones?: { puntos?: PuntoComprobacion[] } }; avisosAceptados?: Array<{ clave: string }> };
    const aceptados = new Set((resumen.avisosAceptados ?? []).map((a) => a.clave));
    const faltan = (resumen.confirmacion?.comprobaciones?.puntos ?? []).filter((p) => p.nivel === 'FALTA' && !aceptados.has(p.clave));
    if (!faltan.length) return null;
    return {
      nivel: 'FALTAN_DATOS',
      texto: `La contabilidad de ${anio} está traída, pero faltan datos:`,
      puntos: faltan.slice(0, MAX_PUNTOS).map((p) => p.texto),
      total: faltan.length,
      enlace: ENLACE_ARRANQUE,
    };
  }
  // Sin carga: se invita solo si tampoco se trajo el plan desde la puesta en marcha ni se dijo que no hace falta.
  const [reglas, planPuestaEnMarcha] = await Promise.all([
    prisma.reglasContables.findUnique({ where: { companyId }, select: { data: true } }),
    prisma.auditLog.count({ where: { companyId, action: 'IMPORTAR_PLAN_ANTERIOR' } }),
  ]);
  const data = (reglas?.data ?? {}) as { planAnterior?: unknown; altaSinPlanAnterior?: unknown };
  if (data.planAnterior || data.altaSinPlanAnterior || planPuestaEnMarcha) return null;
  return {
    nivel: 'INVITACION',
    texto: `Trae la contabilidad de ${anio} de tu gestoría antes de dar de alta clientes o proveedores: así sus subcuentas siguen la numeración que ya usaba.`,
    puntos: [],
    total: 0,
    enlace: ENLACE_ARRANQUE,
  };
}
