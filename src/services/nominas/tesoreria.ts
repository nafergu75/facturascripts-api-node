/**
 * Pagos de las nominas, con su asiento de tesoreria:
 *
 *   Liquidos:          Debe 465 de cada trabajador (y la 465 de embargos si se
 *                      pagan a la vez) / Haber 572 (banco) o 570 (caja).
 *   Seguros sociales:  ver segurosSociales.ts (476 contra 572).
 *   IRPF del 111:      Debe 4751 de trabajo (y la de profesionales) / Haber 572.
 *
 * Cada pago es un asiento cuadrado, en una transaccion, con el periodo de la
 * fecha de pago abierto. Se paga con una cuenta bancaria, en efectivo (caja) o
 * conciliando un movimiento del extracto: un cargo por el mismo importe, que
 * queda conciliado con el asiento del pago (no se contabiliza dos veces).
 *
 * Al pagar los liquidos, la fecha de pago de la nomina pasa a ser la del pago:
 * es la que decide el trimestre del 111 (art. 78.1 RIRPF).
 *
 * Anular un pago: con el periodo del asiento abierto, el asiento pasa a
 * REVERSED; con el periodo cerrado, contraasiento con la fecha de anulacion
 * (como los cobros). El movimiento del banco vuelve a quedar sin conciliar.
 */
import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../../config/database';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { hoyEspana } from '../../utils/fechas';
import type { CuentasNominas } from '../../domain/nominas.model';
import { crearAsientoConApuntes } from '../asientos.service';
import { comprobarFechaAbierta } from '../cobrosPagos.service';
import { calcularModelo111 } from '../impuestosCalculo.service';
import { obtenerReglas } from '../reglasContables.service';
import { nombreCompleto } from '../empleados.service';
import { NOMBRES_CUENTAS, fmtEuros } from './calculo';
import { asegurarCuentas, cuentasNominasEmpresa, prepararPlanEmpresa } from './plan';
import { periodoFiscal } from './fiscal';

export const OPCIONES_TX = { timeout: 120_000, maxWait: 15_000 };
const mm = (n: number) => String(n).padStart(2, '0');
const periodoTexto = (ejercicio: number, mes: number) => `${mm(mes)}/${ejercicio}`;
const euros = (centimos: number): number => Math.round(centimos) / 100;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reintenta si dos procesos a la vez chocan en un indice unico (numero de asiento...). */
export async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      const repetido = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      if (!repetido || intento >= 3) throw e;
    }
  }
}

export function validarFecha(fecha: string | undefined | null): string {
  const f = String(fecha ?? hoyEspana()).slice(0, 10);
  if (!FECHA_RE.test(f) || new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) !== f) throw badRequest('La fecha no es válida (AAAA-MM-DD).');
  return f;
}

// ---------------------------------------------------------------------------
// Medio de pago
// ---------------------------------------------------------------------------

/** Con que se paga: cuenta bancaria, caja o un movimiento del extracto (cargo). */
export interface MedioPago {
  /** Fecha del pago (AAAA-MM-DD); por defecto, hoy (o la del movimiento). */
  fecha?: string;
  cuentaBancariaId?: string;
  /** true: en efectivo (570). */
  caja?: boolean;
  /** Movimiento del extracto bancario (un cargo) que se concilia con el pago. */
  movimientoId?: string;
}

export interface Tesoreria {
  cuenta: string;
  nombre: string;
  bankAccountId: string | null;
  fecha: string;
  movimiento: { id: string; importe: number; fecha: string; concepto: string } | null;
}

/** Cuenta de tesoreria y fecha del pago (y el movimiento del banco, si se concilia). */
export async function resolverMedioPago(companyId: string, medio: MedioPago, cuentas: CuentasNominas): Promise<Tesoreria> {
  if (medio.movimientoId) {
    const mov = await prisma.bankMovement.findFirst({ where: { id: medio.movimientoId, companyId }, include: { cuentaBancaria: true } });
    if (!mov) throw notFound('Movimiento bancario no encontrado.');
    if (mov.conciliado) throw conflict('El movimiento del banco ya está conciliado.');
    if (Number(mov.importe) >= 0) throw badRequest('El movimiento es un abono: para un pago hay que elegir un cargo.');
    if (medio.fecha && medio.fecha !== mov.fecha) throw badRequest(`La fecha del pago es la del movimiento del banco (${mov.fecha}).`);
    if (medio.caja || (medio.cuentaBancariaId && medio.cuentaBancariaId !== mov.cuentaBancariaId)) {
      throw badRequest('Con un movimiento del banco, el pago va a su cuenta bancaria.');
    }
    return {
      cuenta: mov.cuentaBancaria.subcuentaCodigo,
      nombre: mov.cuentaBancaria.bancoNombre || mov.cuentaBancaria.iban,
      bankAccountId: mov.cuentaBancariaId,
      fecha: mov.fecha,
      movimiento: { id: mov.id, importe: Number(mov.importe), fecha: mov.fecha, concepto: mov.concepto },
    };
  }
  const fecha = validarFecha(medio.fecha);
  if (medio.caja) return { cuenta: cuentas.caja, nombre: NOMBRES_CUENTAS.caja, bankAccountId: null, fecha, movimiento: null };
  if (medio.cuentaBancariaId) {
    const c = await prisma.bankAccount.findFirst({ where: { id: medio.cuentaBancariaId, companyId } });
    if (!c) throw badRequest('La cuenta bancaria no existe en esta empresa.');
    if (!c.activa) throw badRequest('La cuenta bancaria está desactivada.');
    return { cuenta: c.subcuentaCodigo, nombre: c.bancoNombre || c.iban, bankAccountId: c.id, fecha, movimiento: null };
  }
  const c = await prisma.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } });
  if (!c) {
    throw badRequest('No hay ninguna cuenta bancaria activa para apuntar el pago. Créala en Tesorería > Cuentas bancarias (con su subcuenta 572), o indica que es en efectivo (caja).');
  }
  return { cuenta: c.subcuentaCodigo, nombre: c.bancoNombre || c.iban, bankAccountId: c.id, fecha, movimiento: null };
}

/** El cargo del banco tiene que ser exactamente lo que se paga. */
export function comprobarImporteMovimiento(t: Tesoreria, centimos: number, que: string): void {
  if (!t.movimiento) return;
  if (aCentimos(-t.movimiento.importe) !== centimos) {
    throw badRequest(`El cargo del banco (${fmtEuros(-t.movimiento.importe)}) no coincide con ${que} (${fmtEuros(euros(centimos))}).`);
  }
}

/** Concilia el movimiento del banco con el asiento del pago, dentro de la transaccion. */
export async function conciliarMovimiento(tx: TransaccionBD, companyId: string, t: Tesoreria, referencia: string): Promise<void> {
  if (!t.movimiento) return;
  const r = await tx.bankMovement.updateMany({ where: { id: t.movimiento.id, companyId, conciliado: false }, data: { conciliado: true, referencia } });
  if (r.count !== 1) throw conflict('El movimiento del banco se ha conciliado mientras tanto: vuelve a cargarlo.');
}

/** Deja sin conciliar el movimiento que se concilio con un pago (si lo hay). */
export async function desconciliarMovimiento(tx: TransaccionBD, companyId: string, referencia: string): Promise<number> {
  const r = await tx.bankMovement.updateMany({ where: { companyId, referencia, conciliado: true }, data: { conciliado: false, referencia: null } });
  return r.count;
}

// ---------------------------------------------------------------------------
// Anular un asiento de pago
// ---------------------------------------------------------------------------

export async function periodoAbiertoEn(companyId: string, fecha: string): Promise<boolean> {
  try {
    await comprobarFechaAbierta(companyId, fecha);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fecha de anulacion: si alguno de los asientos esta en un periodo cerrado, la
 * indicada (o hoy), que tiene que estar abierta; si no, '' (no hace falta).
 */
export async function fechaAnulacionPara(companyId: string, fechasAsientos: string[], fecha?: string): Promise<{ abiertos: Map<string, boolean>; fechaAnulacion: string }> {
  const abiertos = new Map<string, boolean>();
  for (const f of new Set(fechasAsientos)) abiertos.set(f, await periodoAbiertoEn(companyId, f));
  if (![...abiertos.values()].some((v) => !v)) return { abiertos, fechaAnulacion: '' };
  const fechaAnulacion = validarFecha(fecha);
  await comprobarFechaAbierta(companyId, fechaAnulacion);
  return { abiertos, fechaAnulacion };
}

export interface Reversion {
  revertido: string | null;
  contraasiento: { id: string; numero: string } | null;
}

/**
 * Anula un asiento de pago: REVERSED si su periodo esta abierto; si no,
 * contraasiento (debe y haber cambiados) con la fecha de anulacion.
 */
export async function revertirAsiento(
  tx: TransaccionBD,
  companyId: string,
  asientoId: string,
  p: { abierto: boolean; fechaAnulacion: string; origen: string; invoiceType: string; invoiceId: string },
): Promise<Reversion> {
  const original = await tx.journalEntry.findFirst({ where: { id: asientoId, companyId }, include: { lineas: true } });
  if (!original || original.estado === 'REVERSED') return { revertido: null, contraasiento: null };
  if (p.abierto) {
    await tx.journalEntry.update({ where: { id: original.id }, data: { estado: 'REVERSED' } });
    return { revertido: original.numeroAsiento, contraasiento: null };
  }
  const contra = await crearAsientoConApuntes(companyId, {
    tx,
    fecha: p.fechaAnulacion,
    concepto: `Anulación ${original.descripcion} (${original.numeroAsiento})`.slice(0, 190),
    apuntes: original.lineas.map((l) => ({ subcuenta: l.accountCode, concepto: l.accountName, debe: Number(l.haber), haber: Number(l.debe) })),
    origen: p.origen,
    invoiceId: p.invoiceId,
    invoiceType: p.invoiceType,
    referencia: `REV ${original.numeroAsiento}`,
    exigirCuadre: true,
  });
  return { revertido: null, contraasiento: { id: String(contra.asiento.idasiento), numero: String(contra.asiento.numero) } };
}

// ---------------------------------------------------------------------------
// Pago de los liquidos
// ---------------------------------------------------------------------------

export interface OpcionesPagoNominas extends MedioPago {
  /** Nominas que se pagan (por defecto, todas las contabilizadas sin pagar del mes). */
  nominaIds?: string[];
  /** Pagar a la vez los embargos retenidos (465 de embargos). */
  incluirEmbargos?: boolean;
}

export interface ResultadoPagoNominas {
  ejercicio: number;
  mes: number;
  pagadas: number;
  nominaIds: string[];
  importe: number;
  embargos: number;
  fecha: string;
  cuentaTesoreria: string;
  asiento: { id: string; numero: string };
  movimientoId: string | null;
  avisos: string[];
}

const refPagoNominas = (asientoId: string) => `nominas-pago:${asientoId}`;

/**
 * Paga los liquidos de las nominas contabilizadas de un mes (todas o las
 * indicadas): un asiento con la 465 de cada trabajador al debe y la cuenta de
 * tesoreria al haber. Las nominas pasan a PAGADA con la fecha del pago.
 */
export async function pagarNominas(companyId: string, ejercicio: number, mes: number, opciones: OpcionesPagoNominas = {}): Promise<ResultadoPagoNominas> {
  const ids = opciones.nominaIds?.length ? [...new Set(opciones.nominaIds)] : undefined;
  const nominas = await prisma.nomina.findMany({
    where: { companyId, ejercicio, mes, ...(ids ? { id: { in: ids } } : {}) },
    include: { empleado: true },
    orderBy: { createdAt: 'asc' },
  });
  if (ids) {
    if (nominas.length !== ids.length) throw badRequest(`Hay ${ids.length - nominas.length} nómina(s) que no son de ${periodoTexto(ejercicio, mes)} en esta empresa.`);
    const pagadas = nominas.filter((n) => n.estado === 'PAGADA');
    if (pagadas.length) throw conflict(`${pagadas.length} de las nóminas indicadas ya están pagadas (${pagadas.map((n) => nombreCompleto(n.empleado)).slice(0, 3).join(', ')}).`);
    const sinContabilizar = nominas.filter((n) => n.estado !== 'CONTABILIZADA');
    if (sinContabilizar.length) throw conflict(`${sinContabilizar.length} de las nóminas indicadas no están contabilizadas: contabilízalas antes de pagarlas.`);
  }
  const aPagar = nominas.filter((n) => n.estado === 'CONTABILIZADA');
  if (!aPagar.length) {
    throw conflict(
      nominas.some((n) => n.estado === 'PAGADA')
        ? `Las nóminas de ${periodoTexto(ejercicio, mes)} ya están pagadas.`
        : `No hay nóminas contabilizadas sin pagar en ${periodoTexto(ejercicio, mes)}: contabilízalas antes.`,
    );
  }
  const sinSubcuenta = aPagar.filter((n) => !n.empleado.subcuenta465);
  if (sinSubcuenta.length) throw conflict(`${nombreCompleto(sinSubcuenta[0].empleado)} no tiene subcuenta 465: anula y vuelve a contabilizar su nómina.`);

  const { cuentas } = await cuentasNominasEmpresa(companyId);
  // Una linea por subcuenta 465 (un trabajador con dos recibos en el mes, una sola linea).
  const porSubcuenta = new Map<string, { nombre: string; centimos: number }>();
  for (const n of aPagar) {
    const sub = n.empleado.subcuenta465!;
    const v = porSubcuenta.get(sub) ?? { nombre: nombreCompleto(n.empleado), centimos: 0 };
    v.centimos += aCentimos(Number(n.liquido));
    porSubcuenta.set(sub, v);
  }
  const embargos = opciones.incluirEmbargos ? aPagar.reduce((a, n) => a + aCentimos(Number(n.embargos)), 0) : 0;
  const liquidos = [...porSubcuenta.values()].reduce((a, v) => a + v.centimos, 0);
  const total = liquidos + embargos;
  if (total <= 0) throw badRequest('Las nóminas seleccionadas no tienen líquido que pagar.');

  const t = await resolverMedioPago(companyId, opciones, cuentas);
  comprobarImporteMovimiento(t, total, `el líquido de las nóminas${embargos ? ' más los embargos' : ''}`);
  await comprobarFechaAbierta(companyId, t.fecha);
  const avisos: string[] = [];
  if (t.fecha < `${ejercicio}-${mm(mes)}-01`) avisos.push('La fecha de pago es anterior al mes de la nómina (¿un anticipo?).');
  const trimestrePago = `${Math.ceil(Number(t.fecha.slice(5, 7)) / 3)}T/${t.fecha.slice(0, 4)}`;
  const trimestreDevengo = `${Math.ceil(mes / 3)}T/${ejercicio}`;
  if (trimestrePago !== trimestreDevengo) avisos.push(`Se paga en el ${trimestrePago}: el IRPF de estas nóminas va al 111 de ese trimestre (fecha de pago).`);
  if (t.bankAccountId === null) await prepararPlanEmpresa(companyId);

  const apuntes = [...porSubcuenta]
    .filter(([, v]) => v.centimos > 0)
    .map(([subcuenta, v]) => ({ subcuenta, concepto: v.nombre, debe: euros(v.centimos), haber: 0 }));
  if (embargos) apuntes.push({ subcuenta: cuentas.embargos, concepto: NOMBRES_CUENTAS.embargos, debe: euros(embargos), haber: 0 });
  apuntes.push({ subcuenta: t.cuenta, concepto: t.nombre, debe: 0, haber: euros(total) });
  const concepto =
    aPagar.length === 1
      ? `Pago nómina ${periodoTexto(ejercicio, mes)} - ${nombreCompleto(aPagar[0].empleado)}`
      : `Pago nóminas ${periodoTexto(ejercicio, mes)} (${porSubcuenta.size} trabajadores)`;

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const idsPago = aPagar.map((n) => n.id);
      // Primero el estado: si otro proceso paga lo mismo a la vez, uno de los dos para aqui.
      const marcadas = await tx.nomina.updateMany({
        where: { id: { in: idsPago }, estado: 'CONTABILIZADA' },
        data: { estado: 'PAGADA', fechaPago: t.fecha, cuentaPago: t.cuenta },
      });
      if (marcadas.count !== idsPago.length) throw conflict('Alguna nómina ha cambiado de estado mientras tanto: vuelve a cargar el mes.');
      if (t.bankAccountId === null) await asegurarCuentas(tx, companyId, [{ codigo: t.cuenta, nombre: NOMBRES_CUENTAS.caja }]);
      const creado = await crearAsientoConApuntes(companyId, {
        tx,
        fecha: t.fecha,
        concepto,
        apuntes,
        origen: 'NOMINA_PAGO',
        invoiceId: `${ejercicio}-${mm(mes)}`,
        invoiceType: 'NOMINA_PAGO',
        referencia: `PAGO NOM ${periodoTexto(ejercicio, mes)}`,
        exigirCuadre: true,
      });
      const asientoId = String(creado.asiento.idasiento);
      await tx.nomina.updateMany({ where: { id: { in: idsPago } }, data: { asientoPagoId: asientoId } });
      await conciliarMovimiento(tx, companyId, t, refPagoNominas(asientoId));
      return {
        ejercicio,
        mes,
        pagadas: idsPago.length,
        nominaIds: idsPago,
        importe: euros(total),
        embargos: euros(embargos),
        fecha: t.fecha,
        cuentaTesoreria: t.cuenta,
        asiento: { id: asientoId, numero: String(creado.asiento.numero) },
        movimientoId: t.movimiento?.id ?? null,
        avisos,
      };
    }, OPCIONES_TX),
  );
}

export interface ResultadoAnulacionPago {
  ejercicio: number;
  mes: number;
  nominas: number;
  nominaIds: string[];
  /** Nominas que no se indicaron pero iban en el mismo pago (un pago se anula entero). */
  arrastradas: number;
  asientosRevertidos: string[];
  contraasientos: Array<{ id: string; numero: string }>;
  movimientosDesconciliados: number;
}

/**
 * Anula el pago de las nominas pagadas de un mes (o de las indicadas). Un pago
 * se anula entero: si incluia otras nominas, tambien vuelven a CONTABILIZADA.
 */
export async function anularPagoNominas(
  companyId: string,
  ejercicio: number,
  mes: number,
  opciones: { nominaIds?: string[]; fecha?: string } = {},
): Promise<ResultadoAnulacionPago> {
  const ids = opciones.nominaIds?.length ? [...new Set(opciones.nominaIds)] : undefined;
  const seleccion = await prisma.nomina.findMany({
    where: { companyId, ejercicio, mes, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, estado: true, asientoPagoId: true },
  });
  if (ids && seleccion.length !== ids.length) throw badRequest(`Alguna de las nóminas indicadas no es de ${periodoTexto(ejercicio, mes)} en esta empresa.`);
  const pagadas = seleccion.filter((n) => n.estado === 'PAGADA');
  if (ids && pagadas.length !== ids.length) throw conflict(`${ids.length - pagadas.length} de las nóminas indicadas no están pagadas.`);
  if (!pagadas.length) throw conflict(`No hay nóminas pagadas en ${periodoTexto(ejercicio, mes)}.`);

  const asientoIds = [...new Set(pagadas.map((n) => n.asientoPagoId).filter((x): x is string => !!x))];
  const afectadas = await prisma.nomina.findMany({
    where: { companyId, estado: 'PAGADA', OR: [{ id: { in: pagadas.map((n) => n.id) } }, ...(asientoIds.length ? [{ asientoPagoId: { in: asientoIds } }] : [])] },
    select: { id: true },
  });
  const originales = asientoIds.length ? await prisma.journalEntry.findMany({ where: { companyId, id: { in: asientoIds } }, select: { id: true, fecha: true } }) : [];
  const fechaDe = new Map(originales.map((a) => [a.id, a.fecha.toISOString().slice(0, 10)]));
  const { abiertos, fechaAnulacion } = await fechaAnulacionPara(companyId, [...fechaDe.values()], opciones.fecha);

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const asientosRevertidos: string[] = [];
      const contraasientos: Array<{ id: string; numero: string }> = [];
      let movimientos = 0;
      for (const id of asientoIds) {
        const r = await revertirAsiento(tx, companyId, id, {
          abierto: abiertos.get(fechaDe.get(id) ?? '') ?? true,
          fechaAnulacion,
          origen: 'NOMINA_PAGO',
          invoiceType: 'NOMINA_PAGO',
          invoiceId: `${ejercicio}-${mm(mes)}`,
        });
        if (r.revertido) asientosRevertidos.push(r.revertido);
        if (r.contraasiento) contraasientos.push(r.contraasiento);
        movimientos += await desconciliarMovimiento(tx, companyId, refPagoNominas(id));
      }
      const idsAfectadas = afectadas.map((n) => n.id);
      const r = await tx.nomina.updateMany({
        where: { id: { in: idsAfectadas }, estado: 'PAGADA' },
        data: { estado: 'CONTABILIZADA', asientoPagoId: null, cuentaPago: null },
      });
      if (r.count !== idsAfectadas.length) throw conflict('Alguna nómina ha cambiado de estado mientras tanto: vuelve a cargar el mes.');
      return {
        ejercicio,
        mes,
        nominas: idsAfectadas.length,
        nominaIds: idsAfectadas,
        arrastradas: idsAfectadas.length - pagadas.length,
        asientosRevertidos,
        contraasientos,
        movimientosDesconciliados: movimientos,
      };
    }, OPCIONES_TX),
  );
}

// ---------------------------------------------------------------------------
// Pago del 111 (IRPF trimestral)
// ---------------------------------------------------------------------------

const TIPO_PAGO_111 = 'MODELO_111';
const TIPO_PAGO_111_ANULADO = 'MODELO_111_ANULADO';

/**
 * Subcuenta donde estan las retenciones de profesionales: la 4751 (distinta de
 * la de trabajo) mas usada al haber en los asientos de la empresa; si no hay,
 * la de las reglas contables (475100).
 */
export async function cuentaRetencionesProfesionales(companyId: string, irpfTrabajo: string): Promise<string> {
  const lineas = await prisma.journalEntryLine.findMany({
    where: { companyId, accountCode: { startsWith: '4751', not: irpfTrabajo }, haber: { gt: 0 }, entry: { estado: { not: 'REVERSED' } } },
    select: { accountCode: true },
    take: 5000,
  });
  const veces = new Map<string, number>();
  for (const l of lineas) veces.set(l.accountCode, (veces.get(l.accountCode) ?? 0) + 1);
  const masUsada = [...veces].sort((a, b) => b[1] - a[1])[0]?.[0];
  return masUsada ?? (await obtenerReglas(companyId)).cuentaRetencionesProfesionales ?? '475100';
}

/** Asiento del pago del 111 de un periodo, si esta pagado. */
export async function pagoModelo111(companyId: string, ejercicio: number, periodo: string) {
  return prisma.journalEntry.findFirst({
    where: { companyId, invoiceType: TIPO_PAGO_111, invoiceId: `${ejercicio}-${periodo}`, estado: { not: 'REVERSED' } },
    select: { id: true, numeroAsiento: true, fecha: true },
  });
}

/**
 * Paga el 111 de un periodo (el resultado calculado: trabajo + profesionales):
 * Debe 4751 de trabajo (retenciones e ingresos a cuenta de las nominas) y la
 * 4751 de profesionales / Haber 572 o 570.
 */
export async function pagarModelo111(
  companyId: string,
  ejercicio: number,
  periodoTxt: string,
  opciones: MedioPago & { cuentaProfesionales?: string } = {},
) {
  const periodo = periodoFiscal(ejercicio, periodoTxt);
  const ya = await pagoModelo111(companyId, ejercicio, periodo.periodo);
  if (ya) throw conflict(`El 111 de ${periodo.periodo}/${ejercicio} ya está pagado (asiento ${ya.numeroAsiento}).`);
  const d = await calcularModelo111(companyId, periodo);
  const trabajo = aCentimos(d.retencionesTrabajo) + aCentimos(d.ingresosACuentaEspecie ?? 0);
  const profesionales = aCentimos(d.retencionesActividades ?? 0);
  const total = trabajo + profesionales;
  if (total <= 0) throw badRequest(`El 111 de ${periodo.periodo}/${ejercicio} sale a cero: no hay nada que pagar.`);

  const { cuentas } = await cuentasNominasEmpresa(companyId);
  const cuentaProf = opciones.cuentaProfesionales?.trim() || (profesionales ? await cuentaRetencionesProfesionales(companyId, cuentas.irpfTrabajo) : '');
  if (profesionales && !/^4751\d{0,6}$/.test(cuentaProf)) throw badRequest('La cuenta de las retenciones de profesionales tiene que ser una 4751.');
  const t = await resolverMedioPago(companyId, opciones, cuentas);
  comprobarImporteMovimiento(t, total, `el resultado del 111`);
  await comprobarFechaAbierta(companyId, t.fecha);
  await prepararPlanEmpresa(companyId);

  const apuntes: Array<{ subcuenta: string; concepto: string; debe: number; haber: number }> = [];
  if (trabajo) apuntes.push({ subcuenta: cuentas.irpfTrabajo, concepto: NOMBRES_CUENTAS.irpfTrabajo, debe: euros(trabajo), haber: 0 });
  if (profesionales) apuntes.push({ subcuenta: cuentaProf, concepto: 'HP acreedora por retenciones de profesionales', debe: euros(profesionales), haber: 0 });
  apuntes.push({ subcuenta: t.cuenta, concepto: t.nombre, debe: 0, haber: euros(total) });

  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const otro = await tx.journalEntry.findFirst({
        where: { companyId, invoiceType: TIPO_PAGO_111, invoiceId: `${ejercicio}-${periodo.periodo}`, estado: { not: 'REVERSED' } },
        select: { numeroAsiento: true },
      });
      if (otro) throw conflict(`El 111 de ${periodo.periodo}/${ejercicio} ya está pagado (asiento ${otro.numeroAsiento}).`);
      await asegurarCuentas(tx, companyId, [
        { codigo: cuentas.irpfTrabajo, nombre: NOMBRES_CUENTAS.irpfTrabajo },
        ...(profesionales ? [{ codigo: cuentaProf, nombre: 'HP acreedora por retenciones de profesionales' }] : []),
        ...(t.bankAccountId === null ? [{ codigo: t.cuenta, nombre: NOMBRES_CUENTAS.caja }] : []),
      ]);
      const creado = await crearAsientoConApuntes(companyId, {
        tx,
        fecha: t.fecha,
        concepto: `Pago modelo 111 ${periodo.periodo}/${ejercicio}`,
        apuntes,
        origen: 'TESORERIA',
        invoiceId: `${ejercicio}-${periodo.periodo}`,
        invoiceType: TIPO_PAGO_111,
        referencia: `111 ${periodo.periodo}/${ejercicio}`,
        exigirCuadre: true,
      });
      const asientoId = String(creado.asiento.idasiento);
      await conciliarMovimiento(tx, companyId, t, `modelo111-pago:${asientoId}`);
      return {
        ejercicio,
        periodo: periodo.periodo,
        importe: euros(total),
        trabajo: euros(trabajo),
        profesionales: euros(profesionales),
        cuentaProfesionales: profesionales ? cuentaProf : null,
        fecha: t.fecha,
        cuentaTesoreria: t.cuenta,
        asiento: { id: asientoId, numero: String(creado.asiento.numero) },
        movimientoId: t.movimiento?.id ?? null,
        avisos: d.avisos ?? [],
      };
    }, OPCIONES_TX),
  );
}

/** Anula el pago del 111 de un periodo (REVERSED o contraasiento). */
export async function anularPagoModelo111(companyId: string, ejercicio: number, periodoTxt: string, opciones: { fecha?: string } = {}) {
  const periodo = periodoFiscal(ejercicio, periodoTxt);
  const pago = await pagoModelo111(companyId, ejercicio, periodo.periodo);
  if (!pago) throw conflict(`El 111 de ${periodo.periodo}/${ejercicio} no está pagado.`);
  const fechaAsiento = pago.fecha.toISOString().slice(0, 10);
  const { abiertos, fechaAnulacion } = await fechaAnulacionPara(companyId, [fechaAsiento], opciones.fecha);
  return conReintento(() =>
    prisma.$transaction(async (tx) => {
      const r = await revertirAsiento(tx, companyId, pago.id, {
        abierto: abiertos.get(fechaAsiento) ?? true,
        fechaAnulacion,
        origen: 'TESORERIA',
        invoiceType: TIPO_PAGO_111_ANULADO,
        invoiceId: `${ejercicio}-${periodo.periodo}`,
      });
      // Con contraasiento el original sigue POSTED: deja de contar como pago del periodo.
      if (r.contraasiento) await tx.journalEntry.update({ where: { id: pago.id }, data: { invoiceType: TIPO_PAGO_111_ANULADO } });
      const movimientos = await desconciliarMovimiento(tx, companyId, `modelo111-pago:${pago.id}`);
      return { ejercicio, periodo: periodo.periodo, asientoRevertido: r.revertido, contraasiento: r.contraasiento, movimientosDesconciliados: movimientos };
    }, OPCIONES_TX),
  );
}
