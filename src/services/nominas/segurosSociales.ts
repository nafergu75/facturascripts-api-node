/**
 * Seguros sociales del mes (recibo de liquidacion de cotizaciones, RLC).
 *
 * Lo previsto sale de las nominas contabilizadas (o pagadas) del mes: SS del
 * trabajador + SS de la empresa, que el asiento de cada nomina dejo en la 476.
 * Al pagar se apunta lo que dice el RLC real:
 *
 *   Debe  476  lo previsto (la deuda que dejaron las nominas)
 *   Debe  642  la diferencia si el RLC es mayor (Haber 642 si es menor)
 *   Haber 471  la compensacion por IT en pago delegado
 *   Haber 572  el importe del RLC (o 570 si fuera en efectivo)
 *
 * La complementaria (tipo COMPLEMENTARIA, p. ej. por una orden de cotizacion
 * con efectos atrasados) no tiene nominas detras: todo su importe va a la 642.
 * La compensacion de IT va a la 471: la prestacion de IT en pago delegado tiene
 * que estar en la 471 (ver pendientes del ADR-004).
 */
import { prisma } from '../../config/database';
import { badRequest, conflict } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { crearAsientoConApuntes } from '../asientos.service';
import { comprobarFechaAbierta } from '../cobrosPagos.service';
import { NOMBRES_CUENTAS, fmtEuros, ultimoDiaMes } from './calculo';
import { asegurarCuentas, cuentasNominasEmpresa, prepararPlanEmpresa } from './plan';
import {
  OPCIONES_TX,
  comprobarImporteMovimiento,
  conReintento,
  conciliarMovimiento,
  desconciliarMovimiento,
  fechaAnulacionPara,
  resolverMedioPago,
  revertirAsiento,
  validarFecha,
  type MedioPago,
} from './tesoreria';

export const TIPOS_LIQUIDACION_SS = ['NORMAL', 'COMPLEMENTARIA'] as const;
export type TipoLiquidacionSS = (typeof TIPOS_LIQUIDACION_SS)[number];

const mm = (n: number) => String(n).padStart(2, '0');
const periodoTexto = (ejercicio: number, mes: number) => `${mm(mes)}/${ejercicio}`;
const euros = (centimos: number): number => Math.round(centimos) / 100;

/** Ultimo dia del mes siguiente (cargo habitual del RLC). */
export function fechaCargoPorDefecto(ejercicio: number, mes: number): string {
  return mes === 12 ? ultimoDiaMes(ejercicio + 1, 1) : ultimoDiaMes(ejercicio, mes + 1);
}

export interface SegurosSocialesMes {
  id: string | null;
  ejercicio: number;
  mes: number;
  tipo: TipoLiquidacionSS;
  /** Nominas contabilizadas o pagadas del mes (las que dejaron la SS en la 476). */
  nominas: number;
  /** Nominas del mes aun en borrador (su SS no esta en la 476). */
  borradores: number;
  cuotaObrera: number;
  cuotaPatronal: number;
  totalPrevisto: number;
  /** Importe del RLC real (null: aun no se ha indicado). */
  totalRlc: number | null;
  compensacionIt: number;
  /** Lo que se paga: el RLC, o lo previsto menos la IT compensada. */
  aPagar: number;
  /** RLC + IT compensada - previsto: va a la 642 al pagar. */
  diferencia: number;
  fechaCargoPrevista: string;
  /** SIN_NOMINAS | PENDIENTE | PAGADA */
  estado: 'SIN_NOMINAS' | 'PENDIENTE' | 'PAGADA';
  asientoPagoId: string | null;
  asientoPagoNumero: string | null;
  fechaPago: string | null;
  cuentaPago: string | null;
  observaciones: string | null;
}

type FilaSS = Awaited<ReturnType<typeof prisma.liquidacionSS.findFirstOrThrow>>;

/** SS de las nominas contabilizadas o pagadas de un mes, y cuantas siguen en borrador. */
export async function previstoSegurosSociales(companyId: string, ejercicio: number, mes: number) {
  const [contabilizadas, borradores] = await Promise.all([
    prisma.nomina.findMany({ where: { companyId, ejercicio, mes, estado: { in: ['CONTABILIZADA', 'PAGADA'] } }, select: { ssTrabajador: true, ssEmpresa: true } }),
    prisma.nomina.count({ where: { companyId, ejercicio, mes, estado: 'BORRADOR' } }),
  ]);
  const obrera = contabilizadas.reduce((a, n) => a + aCentimos(Number(n.ssTrabajador)), 0);
  const patronal = contabilizadas.reduce((a, n) => a + aCentimos(Number(n.ssEmpresa)), 0);
  return { nominas: contabilizadas.length, borradores, cuotaObrera: euros(obrera), cuotaPatronal: euros(patronal), totalPrevisto: euros(obrera + patronal) };
}

function aDTO(
  ejercicio: number,
  mes: number,
  tipo: TipoLiquidacionSS,
  fila: FilaSS | null,
  previsto: Awaited<ReturnType<typeof previstoSegurosSociales>>,
  numeroPago: string | null,
): SegurosSocialesMes {
  const pagada = fila?.estado === 'PAGADA';
  // Pagada: lo que se pago (foto del momento). Pendiente: lo de las nominas de hoy.
  const base = tipo === 'COMPLEMENTARIA' ? { cuotaObrera: 0, cuotaPatronal: 0, totalPrevisto: 0 } : previsto;
  const cuotaObrera = pagada ? Number(fila!.cuotaObrera) : base.cuotaObrera;
  const cuotaPatronal = pagada ? Number(fila!.cuotaPatronal) : base.cuotaPatronal;
  const totalPrevisto = pagada ? Number(fila!.totalPrevisto) : base.totalPrevisto;
  const totalRlc = fila?.totalRlc === null || fila?.totalRlc === undefined ? null : Number(fila.totalRlc);
  const compensacionIt = Number(fila?.compensacionIt ?? 0);
  const aPagar = totalRlc ?? euros(Math.max(0, aCentimos(totalPrevisto) - aCentimos(compensacionIt)));
  const diferencia = euros(aCentimos(aPagar) + aCentimos(compensacionIt) - aCentimos(totalPrevisto));
  const sinNominas = tipo === 'NORMAL' && !pagada && previsto.nominas === 0;
  return {
    id: fila?.id ?? null,
    ejercicio,
    mes,
    tipo,
    nominas: previsto.nominas,
    borradores: previsto.borradores,
    cuotaObrera,
    cuotaPatronal,
    totalPrevisto,
    totalRlc,
    compensacionIt,
    aPagar,
    diferencia,
    fechaCargoPrevista: fila?.fechaCargoPrevista ?? fechaCargoPorDefecto(ejercicio, mes),
    estado: pagada ? 'PAGADA' : sinNominas && !fila?.totalRlc ? 'SIN_NOMINAS' : 'PENDIENTE',
    asientoPagoId: fila?.asientoPagoId ?? null,
    asientoPagoNumero: numeroPago,
    fechaPago: fila?.fechaPago ?? null,
    cuentaPago: fila?.cuentaPago ?? null,
    observaciones: fila?.observaciones ?? null,
  };
}

async function numeroAsiento(id: string | null | undefined): Promise<string | null> {
  if (!id) return null;
  return (await prisma.journalEntry.findUnique({ where: { id }, select: { numeroAsiento: true } }))?.numeroAsiento ?? null;
}

function tipoValido(tipo: unknown): TipoLiquidacionSS {
  const t = String(tipo ?? 'NORMAL').toUpperCase();
  if (!(TIPOS_LIQUIDACION_SS as readonly string[]).includes(t)) throw badRequest('El tipo tiene que ser NORMAL o COMPLEMENTARIA.');
  return t as TipoLiquidacionSS;
}

/** Seguros sociales de un mes: lo previsto por las nominas, el RLC y su pago. */
export async function obtenerSegurosSociales(companyId: string, ejercicio: number, mes: number, tipoEntrada?: unknown): Promise<SegurosSocialesMes> {
  const tipo = tipoValido(tipoEntrada);
  const [fila, previsto] = await Promise.all([
    prisma.liquidacionSS.findUnique({ where: { companyId_ejercicio_mes_tipo: { companyId, ejercicio, mes, tipo } } }),
    previstoSegurosSociales(companyId, ejercicio, mes),
  ]);
  return aDTO(ejercicio, mes, tipo, fila, previsto, await numeroAsiento(fila?.asientoPagoId));
}

/** Los doce meses del ejercicio (y las complementarias que haya). */
export async function listarSegurosSociales(companyId: string, ejercicio: number): Promise<SegurosSocialesMes[]> {
  const [filas, nominas] = await Promise.all([
    prisma.liquidacionSS.findMany({ where: { companyId, ejercicio } }),
    prisma.nomina.findMany({ where: { companyId, ejercicio, estado: { not: 'ANULADA' } }, select: { mes: true, estado: true, ssTrabajador: true, ssEmpresa: true } }),
  ]);
  const numeros = new Map(
    (
      await prisma.journalEntry.findMany({
        where: { id: { in: filas.map((f) => f.asientoPagoId).filter((x): x is string => !!x) } },
        select: { id: true, numeroAsiento: true },
      })
    ).map((a) => [a.id, a.numeroAsiento]),
  );
  const previstoMes = (mes: number) => {
    const delMes = nominas.filter((n) => n.mes === mes);
    const ok = delMes.filter((n) => n.estado === 'CONTABILIZADA' || n.estado === 'PAGADA');
    const obrera = ok.reduce((a, n) => a + aCentimos(Number(n.ssTrabajador)), 0);
    const patronal = ok.reduce((a, n) => a + aCentimos(Number(n.ssEmpresa)), 0);
    return { nominas: ok.length, borradores: delMes.filter((n) => n.estado === 'BORRADOR').length, cuotaObrera: euros(obrera), cuotaPatronal: euros(patronal), totalPrevisto: euros(obrera + patronal) };
  };
  const out: SegurosSocialesMes[] = [];
  for (let mes = 1; mes <= 12; mes++) {
    const fila = filas.find((f) => f.mes === mes && f.tipo === 'NORMAL') ?? null;
    out.push(aDTO(ejercicio, mes, 'NORMAL', fila, previstoMes(mes), fila?.asientoPagoId ? (numeros.get(fila.asientoPagoId) ?? null) : null));
    for (const c of filas.filter((f) => f.mes === mes && f.tipo === 'COMPLEMENTARIA')) {
      out.push(aDTO(ejercicio, mes, 'COMPLEMENTARIA', c, previstoMes(mes), c.asientoPagoId ? (numeros.get(c.asientoPagoId) ?? null) : null));
    }
  }
  return out;
}

export interface DatosSegurosSociales {
  tipo?: string;
  totalRlc?: number | null;
  compensacionIt?: number;
  fechaCargoPrevista?: string;
  observaciones?: string | null;
}

/** Guarda el RLC real, la IT compensada o la fecha de cargo de un mes pendiente. */
export async function guardarSegurosSociales(companyId: string, ejercicio: number, mes: number, datos: DatosSegurosSociales): Promise<SegurosSocialesMes> {
  const tipo = tipoValido(datos.tipo);
  const clave = { companyId_ejercicio_mes_tipo: { companyId, ejercicio, mes, tipo } };
  const actual = await prisma.liquidacionSS.findUnique({ where: clave });
  if (actual?.estado === 'PAGADA') throw conflict(`Los seguros sociales de ${periodoTexto(ejercicio, mes)} ya están pagados: anula el pago para cambiarlos.`);
  const cambios = {
    ...(datos.totalRlc !== undefined ? { totalRlc: datos.totalRlc } : {}),
    ...(datos.compensacionIt !== undefined ? { compensacionIt: datos.compensacionIt } : {}),
    ...(datos.fechaCargoPrevista !== undefined ? { fechaCargoPrevista: validarFecha(datos.fechaCargoPrevista) } : {}),
    ...(datos.observaciones !== undefined ? { observaciones: datos.observaciones } : {}),
  };
  await prisma.liquidacionSS.upsert({
    where: clave,
    update: cambios,
    create: { companyId, ejercicio, mes, tipo, fechaCargoPrevista: fechaCargoPorDefecto(ejercicio, mes), ...cambios },
  });
  return obtenerSegurosSociales(companyId, ejercicio, mes, tipo);
}

const refPagoSS = (asientoId: string) => `ss-pago:${asientoId}`;

/**
 * Paga los seguros sociales de un mes: 476 (lo previsto) y la diferencia con
 * el RLC a la 642, la IT compensada a la 471, contra la cuenta de tesoreria.
 */
export async function pagarSegurosSociales(
  companyId: string,
  ejercicio: number,
  mes: number,
  opciones: MedioPago & { tipo?: string; totalRlc?: number; compensacionIt?: number },
) {
  const tipo = tipoValido(opciones.tipo);
  const previsto = await previstoSegurosSociales(companyId, ejercicio, mes);
  if (tipo === 'NORMAL') {
    if (previsto.borradores) {
      throw conflict(`Hay ${previsto.borradores} nómina(s) de ${periodoTexto(ejercicio, mes)} sin contabilizar: contabilízalas antes de pagar los seguros sociales (su cuota no está en la 476).`);
    }
    if (!previsto.nominas) throw conflict(`No hay nóminas contabilizadas en ${periodoTexto(ejercicio, mes)}: no hay seguros sociales que pagar.`);
  }
  const clave = { companyId_ejercicio_mes_tipo: { companyId, ejercicio, mes, tipo } };
  const fila = await prisma.liquidacionSS.upsert({
    where: clave,
    update: {},
    create: { companyId, ejercicio, mes, tipo, fechaCargoPrevista: fechaCargoPorDefecto(ejercicio, mes) },
  });
  if (fila.estado === 'PAGADA') throw conflict(`Los seguros sociales ${tipo === 'COMPLEMENTARIA' ? 'complementarios ' : ''}de ${periodoTexto(ejercicio, mes)} ya están pagados.`);

  const { cuentas } = await cuentasNominasEmpresa(companyId);
  const t = await resolverMedioPago(companyId, opciones, cuentas);
  const totalPrevisto = tipo === 'COMPLEMENTARIA' ? 0 : aCentimos(previsto.totalPrevisto);
  const compensacionIt = aCentimos(opciones.compensacionIt ?? Number(fila.compensacionIt ?? 0));
  const rlcGuardado = fila.totalRlc === null || fila.totalRlc === undefined ? null : aCentimos(Number(fila.totalRlc));
  const rlc =
    opciones.totalRlc !== undefined
      ? aCentimos(opciones.totalRlc)
      : t.movimiento
        ? aCentimos(-t.movimiento.importe)
        : (rlcGuardado ?? totalPrevisto - compensacionIt);
  if (rlc <= 0) throw badRequest('El importe del RLC tiene que ser mayor que cero.');
  comprobarImporteMovimiento(t, rlc, 'el importe del RLC');
  await comprobarFechaAbierta(companyId, t.fecha);
  await prepararPlanEmpresa(companyId);

  const diferencia = rlc + compensacionIt - totalPrevisto;
  const apuntes: Array<{ subcuenta: string; concepto: string; debe: number; haber: number }> = [];
  if (totalPrevisto) apuntes.push({ subcuenta: cuentas.ssAcreedora, concepto: NOMBRES_CUENTAS.ssAcreedora, debe: euros(totalPrevisto), haber: 0 });
  if (diferencia > 0) apuntes.push({ subcuenta: cuentas.ssEmpresa, concepto: NOMBRES_CUENTAS.ssEmpresa, debe: euros(diferencia), haber: 0 });
  if (diferencia < 0) apuntes.push({ subcuenta: cuentas.ssEmpresa, concepto: NOMBRES_CUENTAS.ssEmpresa, debe: 0, haber: euros(-diferencia) });
  if (compensacionIt) apuntes.push({ subcuenta: cuentas.ssDeudoraIt, concepto: NOMBRES_CUENTAS.ssDeudoraIt, debe: 0, haber: euros(compensacionIt) });
  apuntes.push({ subcuenta: t.cuenta, concepto: t.nombre, debe: 0, haber: euros(rlc) });
  const usadas = apuntes.map((a) => a.subcuenta).filter((c) => c !== t.cuenta || t.bankAccountId === null);
  const nombres: Record<string, string> = {
    [cuentas.ssAcreedora]: NOMBRES_CUENTAS.ssAcreedora,
    [cuentas.ssEmpresa]: NOMBRES_CUENTAS.ssEmpresa,
    [cuentas.ssDeudoraIt]: NOMBRES_CUENTAS.ssDeudoraIt,
    [cuentas.caja]: NOMBRES_CUENTAS.caja,
  };
  const avisos: string[] = [];
  if (diferencia) {
    avisos.push(`El RLC (${fmtEuros(euros(rlc + compensacionIt))} antes de la IT compensada) y lo previsto por las nóminas (${fmtEuros(euros(totalPrevisto))}) difieren en ${fmtEuros(euros(diferencia))}: la diferencia va a la ${cuentas.ssEmpresa}.`);
  }

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const marcada = await tx.liquidacionSS.updateMany({
        where: { id: fila.id, estado: 'PENDIENTE' },
        data: {
          estado: 'PAGADA',
          cuotaObrera: tipo === 'COMPLEMENTARIA' ? 0 : previsto.cuotaObrera,
          cuotaPatronal: tipo === 'COMPLEMENTARIA' ? 0 : previsto.cuotaPatronal,
          totalPrevisto: euros(totalPrevisto),
          totalRlc: euros(rlc),
          compensacionIt: euros(compensacionIt),
          fechaPago: t.fecha,
          cuentaPago: t.cuenta,
        },
      });
      if (marcada.count !== 1) throw conflict('Los seguros sociales se han pagado mientras tanto: vuelve a cargar el mes.');
      await asegurarCuentas(tx, companyId, [...new Set(usadas)].map((codigo) => ({ codigo, nombre: nombres[codigo] ?? codigo })));
      const creado = await crearAsientoConApuntes(companyId, {
        tx,
        fecha: t.fecha,
        concepto: `Seguros sociales ${tipo === 'COMPLEMENTARIA' ? 'complementarios ' : ''}${periodoTexto(ejercicio, mes)}`,
        apuntes,
        origen: 'SEG_SOCIAL',
        invoiceId: `${ejercicio}-${mm(mes)}-${tipo}`,
        invoiceType: 'SEG_SOCIAL',
        referencia: `RLC ${periodoTexto(ejercicio, mes)}`,
        exigirCuadre: true,
      });
      const asientoId = String(creado.asiento.idasiento);
      await tx.liquidacionSS.update({ where: { id: fila.id }, data: { asientoPagoId: asientoId } });
      await conciliarMovimiento(tx, companyId, t, refPagoSS(asientoId));
      return {
        ejercicio,
        mes,
        tipo,
        importe: euros(rlc),
        totalPrevisto: euros(totalPrevisto),
        compensacionIt: euros(compensacionIt),
        diferencia: euros(diferencia),
        fecha: t.fecha,
        cuentaTesoreria: t.cuenta,
        asiento: { id: asientoId, numero: String(creado.asiento.numero) },
        movimientoId: t.movimiento?.id ?? null,
        avisos,
      };
    }, OPCIONES_TX),
  );
}

/** Anula el pago de los seguros sociales de un mes (vuelven a PENDIENTE). */
export async function anularPagoSegurosSociales(companyId: string, ejercicio: number, mes: number, opciones: { tipo?: string; fecha?: string } = {}) {
  const tipo = tipoValido(opciones.tipo);
  const fila = await prisma.liquidacionSS.findUnique({ where: { companyId_ejercicio_mes_tipo: { companyId, ejercicio, mes, tipo } } });
  if (!fila || fila.estado !== 'PAGADA') throw conflict(`Los seguros sociales de ${periodoTexto(ejercicio, mes)} no están pagados.`);
  const original = fila.asientoPagoId ? await prisma.journalEntry.findFirst({ where: { id: fila.asientoPagoId, companyId }, select: { id: true, fecha: true } }) : null;
  const fechaAsiento = original?.fecha.toISOString().slice(0, 10);
  const { abiertos, fechaAnulacion } = await fechaAnulacionPara(companyId, fechaAsiento ? [fechaAsiento] : [], opciones.fecha);
  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const r = original
        ? await revertirAsiento(tx, companyId, original.id, {
            abierto: abiertos.get(fechaAsiento!) ?? true,
            fechaAnulacion,
            origen: 'SEG_SOCIAL',
            invoiceType: 'SEG_SOCIAL',
            invoiceId: `${ejercicio}-${mm(mes)}-${tipo}`,
          })
        : { revertido: null, contraasiento: null };
      const movimientos = original ? await desconciliarMovimiento(tx, companyId, refPagoSS(original.id)) : 0;
      const u = await tx.liquidacionSS.updateMany({
        where: { id: fila.id, estado: 'PAGADA' },
        data: { estado: 'PENDIENTE', asientoPagoId: null, fechaPago: null, cuentaPago: null },
      });
      if (u.count !== 1) throw conflict('Los seguros sociales han cambiado mientras tanto: vuelve a cargar el mes.');
      return { ejercicio, mes, tipo, asientoRevertido: r.revertido, contraasiento: r.contraasiento, movimientosDesconciliados: movimientos };
    }, OPCIONES_TX),
  );
}
