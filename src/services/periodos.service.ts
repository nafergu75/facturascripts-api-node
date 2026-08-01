import { prisma } from '../config/database';
import { EstadoPeriodo, PeriodoContable } from '../domain/periodos.model';

/**
 * Periodos contables PERSISTIDOS en Prisma (tabla Periodo). Si la BD no esta
 * disponible (tests con prisma mockeado, arranque sin MySQL) se usa un fallback
 * en memoria para no bloquear el resto de la API.
 */
const memoria = new Map<string, PeriodoContable>();
const key = (companyId: string, ejercicio: number, mes: number): string => `${companyId}:${ejercicio}:${mes}`;

type PeriodoDb = { id: string; companyId: string; ejercicio: number; mes: number; estado: string; fechaApertura: string | null; fechaCierre: string | null };
const dbOk = (): boolean => typeof (prisma as { periodo?: { findMany?: unknown } }).periodo?.findMany === 'function';
const aDom = (p: PeriodoDb): PeriodoContable => ({
  id: p.id,
  companyId: p.companyId,
  ejercicio: p.ejercicio,
  mes: p.mes,
  estado: p.estado as EstadoPeriodo,
  fechaApertura: p.fechaApertura ?? '',
  fechaCierre: p.fechaCierre ?? undefined,
});

/** Lista los 12 periodos del ejercicio, creandolos abiertos si no existen. */
export async function listarPeriodos(companyId: string, ejercicio: number): Promise<PeriodoContable[]> {
  if (dbOk()) {
    const existentes = await prisma.periodo.findMany({ where: { companyId, ejercicio } });
    const porMes = new Map(existentes.map((p) => [p.mes, p]));
    const out: PeriodoContable[] = [];
    for (let mes = 1; mes <= 12; mes++) {
      let p = porMes.get(mes);
      if (!p) {
        p = await prisma.periodo.create({
          data: { companyId, ejercicio, mes, estado: 'abierto', fechaApertura: new Date().toISOString() },
        });
      }
      out.push(aDom(p));
    }
    return out;
  }
  // Fallback memoria
  const out: PeriodoContable[] = [];
  for (let mes = 1; mes <= 12; mes++) {
    const k = key(companyId, ejercicio, mes);
    let p = memoria.get(k);
    if (!p) {
      p = { id: k, companyId, ejercicio, mes, estado: 'abierto', fechaApertura: new Date().toISOString() };
      memoria.set(k, p);
    }
    out.push(p);
  }
  return out;
}

export async function cambiarEstadoPeriodo(
  companyId: string,
  ejercicio: number,
  mes: number,
  nuevoEstado: EstadoPeriodo,
): Promise<PeriodoContable> {
  await listarPeriodos(companyId, ejercicio); // asegura que existen
  const fechaCierre = nuevoEstado === 'cerrado' ? new Date().toISOString() : undefined;
  if (dbOk()) {
    const p = await prisma.periodo.update({
      where: { companyId_ejercicio_mes: { companyId, ejercicio, mes } },
      data: { estado: nuevoEstado, ...(fechaCierre ? { fechaCierre } : {}) },
    });
    return aDom(p);
  }
  const p = memoria.get(key(companyId, ejercicio, mes))!;
  p.estado = nuevoEstado;
  if (fechaCierre) p.fechaCierre = fechaCierre;
  return p;
}

/** Estado del periodo correspondiente a una fecha (yyyy-mm-dd). */
export async function estadoPeriodoEnFecha(companyId: string, fecha: string): Promise<EstadoPeriodo | null> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (!m) return null;
  const periodos = await listarPeriodos(companyId, Number(m[1]));
  return periodos.find((p) => p.mes === Number(m[2]))?.estado ?? null;
}
