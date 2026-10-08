import { prisma } from '../config/database';
import { badRequest, conflict } from '../utils/http-errors';
import { EstadoPeriodo, PeriodoContable } from '../domain/periodos.model';
import { FILTRO_ASIENTOS_CIERRE } from '../domain/asientosCierre';
import {
  enlaceCierre,
  ENLACE_CONFIG_EJERCICIOS,
  estadoEfectivoEjercicio,
  reaperturaDelAnio,
  type EstadoEfectivoEjercicio,
} from './fiscalYears.service';

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
 * Una factura recibida lleva la fecha que puso el proveedor: no se cambia para
 * esquivar un mes bloqueado. Su IVA se deduce en el periodo en que se recibe
 * (art. 99 LIVA), pero la app todavia no contabiliza una factura recibida en
 * un periodo posterior al de su fecha: se dice asi, sin invitar a cambiarla.
 */
const esFacturaRecibida = (accion: string) => accion.includes('factura de gasto');
const SIN_CAMBIAR_FECHA_RECIBIDA =
  'No cambies la fecha de la factura: es la que puso el proveedor. Si la recibiste más tarde, modifica la factura y pon la fecha en que la recibiste (en «¿La recibiste más tarde?»): su IVA se deduce en ese periodo.';

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
          (esFacturaRecibida(accion)
            ? SIN_CAMBIAR_FECHA_RECIBIDA
            : estado === 'bloqueado'
              ? 'Usa otra fecha o desbloquea ese mes en Configuración > Ejercicios y periodos.'
              : 'Usa otra fecha: ese mes ya se cerró.'),
        { ...campoFecha(accion), motivo: `periodo_${estado}` },
      );
    }
    throw badRequest(`El periodo de ${mes} está ${estado}: no se pueden añadir asientos con esa fecha.`);
  }
  const ejercicio = Number(fecha.slice(0, 4));
  const estadoEj = await estadoCierreAnio(companyId, ejercicio);
  if (estadoEj !== 'ABIERTO') {
    if (accion) {
      const queHacer =
        estadoEj === 'CERRADO_SIN_ASIENTOS'
          ? await textoReabrir(companyId, ejercicio)
          : esFacturaRecibida(accion)
            ? SIN_CAMBIAR_FECHA_RECIBIDA
            : 'Usa otra fecha o, si de verdad tiene que ir en ese año, deshaz antes el cierre en Contabilidad > Cierre y traspaso de saldos.';
      throw badRequest(`No se puede ${accion} con fecha ${ddmmaaaa(fecha)}: el ejercicio ${ejercicio} está cerrado. ${queHacer}`, {
        ...campoFecha(accion),
        motivo: 'ejercicio_cerrado',
        enlace: estadoEj === 'CERRADO_SIN_ASIENTOS' ? ENLACE_CONFIG_EJERCICIOS : enlaceCierre(ejercicio),
      });
    }
    throw badRequest(`El ejercicio ${ejercicio} está cerrado: no se pueden añadir asientos con esa fecha.`);
  }
}

/** Que hacer con un ejercicio cerrado sin asientos de cierre (Configuracion, no Cierre y traspaso). */
async function textoReabrir(companyId: string, ejercicio: number): Promise<string> {
  const { motivo } = await reaperturaDelAnio(companyId, ejercicio);
  return motivo
    ? `Se marcó como cerrado sin hacer la regularización ni el cierre. ${motivo}`
    : 'Se marcó como cerrado sin hacer la regularización ni el cierre: el administrador de la empresa puede reabrirlo en Configuración > Ejercicios y periodos.';
}

/**
 * Estado del ejercicio de ese año: CERRADO si tiene asientos de regularizacion
 * o cierre (domain/asientosCierre, tambien los de cierres anteriores);
 * CERRADO_SIN_ASIENTOS si esta marcado como cerrado sin ellos; si no, ABIERTO.
 */
export async function estadoCierreAnio(companyId: string, ejercicio: number): Promise<EstadoEfectivoEjercicio> {
  // Sin alguna de esas tablas (tests con prisma simulado) se mira solo la que hay.
  const hay = (t: unknown) => typeof (t as { findFirst?: unknown } | undefined)?.findFirst === 'function';
  const p = prisma as unknown as { fiscalYear?: unknown; journalEntry?: unknown };
  const [fy, cierre] = await Promise.all([
    hay(p.fiscalYear) ? prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio) }, select: { estado: true } }) : null,
    hay(p.journalEntry)
      ? prisma.journalEntry.findFirst({
          where: {
            companyId,
            estado: 'POSTED',
            ...FILTRO_ASIENTOS_CIERRE,
            fecha: { gte: new Date(Date.UTC(ejercicio, 0, 1)), lt: new Date(Date.UTC(ejercicio + 1, 0, 1)) },
          },
          select: { id: true },
        })
      : null,
  ]);
  return estadoEfectivoEjercicio(fy?.estado ?? 'OPEN', !!cierre);
}

/**
 * ¿Esta cerrado el ejercicio? Si tiene asientos de regularizacion o cierre, o
 * si esta marcado como cerrado (CLOSED), aunque no los tenga.
 */
export async function ejercicioCerrado(companyId: string, ejercicio: number): Promise<boolean> {
  return (await estadoCierreAnio(companyId, ejercicio)) !== 'ABIERTO';
}

/** Modelos que se miran al desbloquear un mes: si estan presentados, hay que confirmar. */
const MODELOS_AVISO_DESBLOQUEO = ['303', '111'];

/**
 * 303 y 111 ya presentados que cubren el mes (el del propio mes o el de su
 * trimestre), p. ej. ['303 2T', '111 05']. Desbloquear el mes deja cambiar
 * facturas o asientos ya declarados.
 */
export async function modelosPresentadosDelMes(companyId: string, ejercicio: number, mes: number): Promise<string[]> {
  if (typeof (prisma as { modeloImpuesto?: { findMany?: unknown } }).modeloImpuesto?.findMany !== 'function') return [];
  const periodos = [String(mes).padStart(2, '0'), `${Math.ceil(mes / 3)}T`];
  const filas = await prisma.modeloImpuesto.findMany({
    where: { companyId, ejercicio, estado: 'presentado', codigo: { in: MODELOS_AVISO_DESBLOQUEO }, periodo: { in: periodos } },
    select: { codigo: true, periodo: true },
    orderBy: [{ codigo: 'asc' }, { periodo: 'asc' }],
  });
  return filas.map((f) => `${f.codigo} ${f.periodo}`);
}

/** Lo que se puede hacer a mano con un mes desde Configuracion. */
export type EstadoMesManual = 'abierto' | 'bloqueado';

export interface ResultadoCambioMes extends PeriodoContable {
  /** Al desbloquear con confirmacion un mes con modelos presentados. */
  aviso?: 'modelo_presentado';
  modelosPresentados?: string[];
}

/**
 * Bloquea o desbloquea un mes (Configuracion > Ejercicios y periodos).
 *  - Un mes 'cerrado' lo puso el cierre del ejercicio: no se cambia a mano (409).
 *  - Un mes de un ejercicio cerrado no se desbloquea (409): primero se deshace el cierre.
 *  - Si el 303 o el 111 del mes o de su trimestre estan presentados, desbloquear
 *    pide confirmacion: sin `confirmar`, 409 con details.aviso='modelo_presentado';
 *    con ella, se desbloquea y la respuesta lleva el aviso.
 */
export async function cambiarBloqueoMes(
  companyId: string,
  ejercicio: number,
  mes: number,
  estado: EstadoMesManual,
  opciones: { confirmar?: boolean } = {},
): Promise<ResultadoCambioMes> {
  const periodos = await listarPeriodos(companyId, ejercicio);
  const actual = periodos.find((p) => p.mes === mes);
  const nombreMes = `${String(mes).padStart(2, '0')}/${ejercicio}`;
  if (actual?.estado === 'cerrado') {
    throw conflict(
      `El mes ${nombreMes} lo cerró el cierre del ejercicio y no se cambia a mano. Si hay que corregir algo, deshaz el cierre en Contabilidad > Cierre y traspaso de saldos.`,
      { campo: 'estado', motivo: 'periodo_cerrado' },
    );
  }
  if (estado === 'abierto' && actual?.estado !== 'abierto') {
    const estadoEj = await estadoCierreAnio(companyId, ejercicio);
    if (estadoEj === 'CERRADO_SIN_ASIENTOS') {
      throw conflict(`El ejercicio ${ejercicio} está cerrado: sus meses no se desbloquean. ${await textoReabrir(companyId, ejercicio)}`, {
        campo: 'estado',
        motivo: 'ejercicio_cerrado',
        enlace: ENLACE_CONFIG_EJERCICIOS,
      });
    }
    if (estadoEj === 'CERRADO') {
      throw conflict(
        `El ejercicio ${ejercicio} está cerrado: sus meses no se desbloquean. Si hay que corregir algo, deshaz antes el cierre en Contabilidad > Cierre y traspaso de saldos.`,
        { campo: 'estado', motivo: 'ejercicio_cerrado', enlace: enlaceCierre(ejercicio) },
      );
    }
    const presentados = await modelosPresentadosDelMes(companyId, ejercicio, mes);
    if (presentados.length && !opciones.confirmar) {
      throw conflict(
        `Ya está presentado el modelo ${presentados.join(' y el ')}, que incluye el mes ${nombreMes}. Si cambias facturas o asientos de ese mes, tendrás que presentar una declaración complementaria o rectificativa. ¿Quieres desbloquearlo igualmente?`,
        { aviso: 'modelo_presentado', modelosPresentados: presentados },
      );
    }
    const p = await cambiarEstadoPeriodo(companyId, ejercicio, mes, 'abierto');
    return presentados.length ? { ...p, aviso: 'modelo_presentado', modelosPresentados: presentados } : p;
  }
  return cambiarEstadoPeriodo(companyId, ejercicio, mes, estado);
}
