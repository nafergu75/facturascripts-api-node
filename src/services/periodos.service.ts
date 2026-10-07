import { prisma } from '../config/database';
import { badRequest } from '../utils/http-errors';
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

/**
 * Lista los 12 periodos del ejercicio, creandolos abiertos si no existen. Los
 * que faltan se crean de una vez con skipDuplicates: dos peticiones a la vez
 * (la pantalla pide los periodos y el cierre tambien) ya no chocan con el unico
 * (empresa, ejercicio, mes) y no dan un 500.
 */
export async function listarPeriodos(companyId: string, ejercicio: number): Promise<PeriodoContable[]> {
  if (dbOk()) {
    let existentes = await prisma.periodo.findMany({ where: { companyId, ejercicio } });
    if (existentes.length < 12) {
      const hay = new Set(existentes.map((p) => p.mes));
      const fechaApertura = new Date().toISOString();
      const faltan = Array.from({ length: 12 }, (_, i) => i + 1).filter((mes) => !hay.has(mes));
      await prisma.periodo.createMany({
        data: faltan.map((mes) => ({ companyId, ejercicio, mes, estado: 'abierto', fechaApertura })),
        skipDuplicates: true,
      });
      existentes = await prisma.periodo.findMany({ where: { companyId, ejercicio } });
    }
    const porMes = new Map(existentes.map((p) => [p.mes, p]));
    const out: PeriodoContable[] = [];
    for (let mes = 1; mes <= 12; mes++) {
      const p = porMes.get(mes);
      if (p) out.push(aDom(p));
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

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;
/** Al emitir, el error señala el campo de la fecha de emision (campoDelError en la pantalla). */
const campoFecha = (accion: string) => (accion.startsWith('emitir') ? { campo: 'fechaEmision' } : {});

/**
 * No se apunta nada en un periodo cerrado o bloqueado, ni en un ejercicio
 * cerrado (con asientos de regularizacion/cierre o marcado como cerrado).
 *
 * `accion` (p. ej. 'emitir la factura') da un mensaje pensado para quien emite
 * o contabiliza una factura; sin ella, el mensaje general de los asientos.
 * Vive aqui (y no en cobrosPagos) para que el motor contable y las facturas la
 * usen sin importarse en circulo; cobrosPagos la reexporta.
 */
export async function comprobarFechaAbierta(companyId: string, fecha: string, accion?: string): Promise<void> {
  const estado = await estadoPeriodoEnFecha(companyId, fecha);
  const mes = `${fecha.slice(5, 7)}/${fecha.slice(0, 4)}`;
  if (estado === 'cerrado' || estado === 'bloqueado') {
    if (accion) {
      throw badRequest(
        `No se puede ${accion} con fecha ${ddmmaaaa(fecha)}: el mes ${mes} está ${estado}. ` +
          (estado === 'bloqueado'
            ? 'Usa otra fecha o desbloquea ese mes en Configuración > Ejercicios y periodos.'
            : 'Usa otra fecha: ese mes ya se cerró.'),
        { ...campoFecha(accion), motivo: `periodo_${estado}` },
      );
    }
    throw badRequest(`El periodo de ${mes} está ${estado}: no se pueden añadir asientos con esa fecha.`);
  }
  const ejercicio = Number(fecha.slice(0, 4));
  const fy = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) }, select: { estado: true } });
  const cierre =
    fy?.estado === 'CLOSED' ||
    !!(await prisma.journalEntry.findFirst({
      where: {
        companyId,
        estado: 'POSTED',
        origen: { in: ['REGULARIZACION', 'CIERRE'] },
        fecha: { gte: new Date(Date.UTC(ejercicio, 0, 1)), lt: new Date(Date.UTC(ejercicio + 1, 0, 1)) },
      },
      select: { id: true },
    }));
  if (cierre) {
    if (accion) {
      throw badRequest(
        `No se puede ${accion} con fecha ${ddmmaaaa(fecha)}: el ejercicio ${ejercicio} está cerrado. ` +
          'Usa otra fecha o, si de verdad tiene que ir en ese año, deshaz antes el cierre en Contabilidad > Cierre y traspaso de saldos.',
        { ...campoFecha(accion), motivo: 'ejercicio_cerrado' },
      );
    }
    throw badRequest(`El ejercicio ${ejercicio} está cerrado: no se pueden añadir asientos con esa fecha.`);
  }
}
