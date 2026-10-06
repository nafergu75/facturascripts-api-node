import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { estadoPeriodoEnFecha } from './periodos.service';

/**
 * Cobros de facturas de venta y pagos de facturas de gasto, con su asiento.
 *
 * Cada cobro o pago es una fila de InvoicePayment y un asiento de tesoreria
 * POSTED enlazado a la factura (JournalEntry.invoiceId + invoiceType), para que
 * el mayor de terceros lo atribuya al cliente o proveedor:
 *
 *   Cobro: 572 (banco) o 570 (caja) al debe  /  430 del cliente al haber.
 *   Pago:  400/410 del proveedor al debe     /  572 o 570 al haber.
 *
 * La cuenta del cliente o proveedor es la misma que uso el asiento de la
 * factura (si no lo hay, la 430 o la 400 generica).
 *
 * Se permiten cobros parciales, pero nunca por encima de lo pendiente. Anular
 * no borra nada: el cobro queda ANULADO y su asiento REVERSED; si el periodo del
 * cobro ya esta cerrado, se hace un contraasiento con la fecha de anulacion.
 */

export type TipoDocumento = 'INGRESO' | 'GASTO';

export interface DatosCobro {
  fecha?: string;
  importe?: number;
  cuentaBancariaId?: string;
  /** true: cobro/pago en efectivo (570 Caja). */
  caja?: boolean;
  nota?: string;
  userId?: string;
}

export interface CobroResp {
  id: string;
  fecha: string;
  importe: number;
  cuentaTesoreria: string;
  cuentaBancariaId: string | null;
  medio: 'BANCO' | 'CAJA';
  nota: string | null;
  estado: string;
  asientoId: string | null;
  asientoNumero: string | null;
  anuladoEn: Date | null;
  createdAt: Date;
}

export interface ResumenCobros {
  invoiceId: string;
  tipo: TipoDocumento;
  numeroFactura: string | null;
  totalFactura: number;
  /** Suma de cobros/pagos activos. */
  importeCobrado: number;
  importePendiente: number;
  /** INGRESO: PENDING | OVERDUE | PAID. GASTO: PENDIENTE | PARCIAL | PAGADA. */
  estado: string;
  cobros: CobroResp[];
}

const CUENTA_CAJA = '570';
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const hoyISO = (): string => new Date().toISOString().slice(0, 10);

const TXT = {
  INGRESO: { cobro: 'cobro', Cobro: 'Cobro', prefijo: 'COBRO', cobrado: 'cobrada' },
  GASTO: { cobro: 'pago', Cobro: 'Pago', prefijo: 'PAGO', cobrado: 'pagada' },
} as const;

interface FacturaBase {
  id: string;
  companyId: string;
  numeroCompleto: string | null;
  fechaEmision: string;
  fechaVencimiento: string;
  totalFactura: number;
  estado: string;
  tercero: string;
}

async function cargarFactura(db: Tx | typeof prisma, companyId: string, tipo: TipoDocumento, id: string): Promise<FacturaBase> {
  if (tipo === 'INGRESO') {
    const f = await db.incomeInvoice.findFirst({ where: { id, companyId }, include: { customer: { select: { nombreFiscal: true } } } });
    if (!f) throw notFound('Factura no encontrada.');
    if (f.estadoDocumento === 'PROFORMA') throw badRequest('Una proforma no admite cobros: pásala a factura y emítela antes.');
    if (f.estadoDocumento !== 'FINAL') throw badRequest('La factura está en borrador: emítela antes de registrar cobros.');
    return { ...f, tercero: f.customer.nombreFiscal };
  }
  const f = await db.expenseInvoice.findFirst({ where: { id, companyId }, include: { supplier: { select: { nombreFiscal: true } } } });
  if (!f) throw notFound('Factura de gasto no encontrada.');
  return { ...f, tercero: f.supplier.nombreFiscal };
}

/**
 * Factura de venta marcada como cobrada a mano antes de que existieran los
 * cobros (estado PAID sin ningun cobro activo): se da por cobrada entera.
 */
const cobradaSinCobros = (tipo: TipoDocumento, estado: string, cobrado: number) => tipo === 'INGRESO' && estado === 'PAID' && cobrado === 0;

/** Pendiente de una factura a partir de su total, su estado y lo cobrado. Puro. */
export function calcularPendiente(tipo: TipoDocumento, totalFactura: number, estado: string, cobrado: number): number {
  if (cobradaSinCobros(tipo, estado, cobrado)) return 0;
  return round2(totalFactura - cobrado);
}

/** Estado de cobro (venta) o de pago (gasto) segun lo pendiente. Puro. */
export function estadoTrasCobros(
  tipo: TipoDocumento,
  f: { totalFactura: number; fechaVencimiento: string },
  cobrado: number,
  hoy: string = hoyISO(),
): string {
  const pendiente = round2(f.totalFactura - cobrado);
  if (tipo === 'INGRESO') {
    if (aCentimos(pendiente) <= 0) return 'PAID';
    return f.fechaVencimiento < hoy ? 'OVERDUE' : 'PENDING';
  }
  if (aCentimos(pendiente) <= 0) return 'PAGADA';
  return aCentimos(cobrado) > 0 ? 'PARCIAL' : 'PENDIENTE';
}

async function sumaActivos(db: Tx | typeof prisma, companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<number> {
  const r = await db.invoicePayment.aggregate({
    where: { companyId, invoiceType: tipo, invoiceId, estado: 'ACTIVO' },
    _sum: { importe: true },
  });
  return round2(Number(r._sum.importe ?? 0));
}

/** Guarda el estado de cobro/pago de la factura segun sus cobros activos. */
async function actualizarEstadoFactura(tx: Tx, f: FacturaBase, tipo: TipoDocumento): Promise<string> {
  const cobrado = await sumaActivos(tx, f.companyId, tipo, f.id);
  const estado = estadoTrasCobros(tipo, f, cobrado);
  if (tipo === 'INGRESO') await tx.incomeInvoice.update({ where: { id: f.id }, data: { estado } });
  else await tx.expenseInvoice.update({ where: { id: f.id }, data: { estadoPago: estado } });
  return estado;
}

/**
 * Subcuenta del cliente (43x, al debe) o del proveedor (40x/41x, al haber) que
 * uso el asiento de la factura. Sin asiento, la generica.
 */
export async function cuentaTerceroDeFactura(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<string> {
  const asiento = await prisma.journalEntry.findFirst({
    where: { companyId, invoiceId, invoiceType: tipo, origen: { not: 'TESORERIA' }, estado: { not: 'REVERSED' } },
    include: { lineas: true },
    orderBy: { createdAt: 'desc' },
  });
  const linea = asiento?.lineas.find((l) =>
    tipo === 'INGRESO' ? l.accountCode.startsWith('43') && l.debe > 0 : /^4[01]/.test(l.accountCode) && l.haber > 0,
  );
  return linea?.accountCode ?? (tipo === 'INGRESO' ? '430' : '400');
}

/**
 * No se apunta nada en un periodo cerrado o bloqueado, ni en un ejercicio
 * cerrado (con asientos de regularizacion/cierre o marcado como cerrado).
 */
export async function comprobarFechaAbierta(companyId: string, fecha: string): Promise<void> {
  const estado = await estadoPeriodoEnFecha(companyId, fecha);
  if (estado === 'cerrado' || estado === 'bloqueado') {
    throw badRequest(`El periodo de ${fecha.slice(5, 7)}/${fecha.slice(0, 4)} está ${estado}: no se pueden añadir asientos con esa fecha.`);
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
  if (cierre) throw badRequest(`El ejercicio ${ejercicio} está cerrado: no se pueden añadir asientos con esa fecha.`);
}

/** Cuenta de tesoreria: la de la cuenta bancaria indicada, caja, o la primera cuenta bancaria activa. */
async function resolverTesoreria(
  companyId: string,
  datos: DatosCobro,
  tipo: TipoDocumento,
): Promise<{ cuenta: string; bankAccountId: string | null; nombre: string }> {
  if (datos.caja) return { cuenta: CUENTA_CAJA, bankAccountId: null, nombre: 'Caja' };
  if (datos.cuentaBancariaId) {
    const c = await prisma.bankAccount.findFirst({ where: { id: datos.cuentaBancariaId, companyId } });
    if (!c) throw badRequest('La cuenta bancaria no existe en esta empresa.');
    if (!c.activa) throw badRequest('La cuenta bancaria está desactivada.');
    return { cuenta: c.subcuentaCodigo, bankAccountId: c.id, nombre: c.bancoNombre || c.iban };
  }
  const c = await prisma.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } });
  if (!c) {
    throw badRequest(
      `No hay ninguna cuenta bancaria activa para apuntar el ${TXT[tipo].cobro}. Créala en Tesorería > Cuentas bancarias (con su subcuenta 572), o indica que es en efectivo (caja).`,
    );
  }
  return { cuenta: c.subcuentaCodigo, bankAccountId: c.id, nombre: c.bancoNombre || c.iban };
}

function validarFecha(fecha: string | undefined): string {
  const f = (fecha ?? hoyISO()).slice(0, 10);
  if (!FECHA_RE.test(f) || Number.isNaN(new Date(`${f}T00:00:00Z`).getTime())) throw badRequest('La fecha no es válida (AAAA-MM-DD).');
  return f;
}

/** Siguiente numero de asiento del prefijo (mayor existente + 1, como grabarAsientos). */
async function siguienteNumero(tx: Tx, companyId: string, prefijo: string): Promise<string> {
  const existentes = await tx.journalEntry.findMany({
    where: { companyId, numeroAsiento: { startsWith: `${prefijo}-` } },
    select: { numeroAsiento: true },
  });
  let max = 0;
  for (const e of existentes) {
    const n = Number(e.numeroAsiento.slice(prefijo.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefijo}-${String(max + 1).padStart(5, '0')}`;
}

interface Apunte {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
}

async function crearAsiento(
  tx: Tx,
  companyId: string,
  p: { prefijo: string; fecha: string; descripcion: string; tipo: TipoDocumento; invoiceId: string; referencia: string; apuntes: Apunte[] },
) {
  const debe = round2(p.apuntes.reduce((s, a) => s + a.debe, 0));
  const haber = round2(p.apuntes.reduce((s, a) => s + a.haber, 0));
  if (aCentimos(debe) !== aCentimos(haber)) throw badRequest(`El asiento no cuadra: Debe ${debe} y Haber ${haber}.`);
  return tx.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(`${p.fecha}T00:00:00.000Z`),
      numeroAsiento: await siguienteNumero(tx, companyId, p.prefijo),
      descripcion: p.descripcion.slice(0, 190),
      origen: 'TESORERIA',
      estado: 'POSTED',
      invoiceId: p.invoiceId,
      invoiceType: p.tipo,
      lineas: {
        create: p.apuntes.map((a) => ({
          accountCode: a.cuenta,
          accountName: a.nombre.slice(0, 190),
          debe: round2(a.debe),
          haber: round2(a.haber),
          referencia: p.referencia.slice(0, 190),
          companyId,
        })),
      },
    },
  });
}

/** Reintenta si dos asientos a la vez sacan el mismo numero (indice unico). */
async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (e) {
      const repetido = e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
      if (!repetido || intento >= 3) throw e;
    }
  }
}

/** Bloquea la fila de la factura hasta el final de la transaccion (dos cobros a la vez no se pasan del total). */
async function bloquearFactura(tx: Tx, tipo: TipoDocumento, id: string): Promise<void> {
  if (tipo === 'INGRESO') await tx.$queryRaw`SELECT id FROM IncomeInvoice WHERE id = ${id} FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM ExpenseInvoice WHERE id = ${id} FOR UPDATE`;
}

type FilaPago = Awaited<ReturnType<typeof prisma.invoicePayment.findMany>>[number];

function aCobroResp(p: FilaPago, numeros: Map<string, string>): CobroResp {
  return {
    id: p.id,
    fecha: p.fecha,
    importe: p.importe,
    cuentaTesoreria: p.cuentaTesoreria,
    cuentaBancariaId: p.bankAccountId,
    medio: p.bankAccountId ? 'BANCO' : 'CAJA',
    nota: p.nota,
    estado: p.estado,
    asientoId: p.journalEntryId,
    asientoNumero: p.journalEntryId ? (numeros.get(p.journalEntryId) ?? null) : null,
    anuladoEn: p.anuladoEn,
    createdAt: p.createdAt,
  };
}

/** Cobros (o pagos) de una factura, con lo cobrado y lo pendiente. */
export async function listarCobros(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<ResumenCobros> {
  const f = await cargarFactura(prisma, companyId, tipo, invoiceId);
  const filas = await prisma.invoicePayment.findMany({
    where: { companyId, invoiceType: tipo, invoiceId },
    orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
  });
  const ids = filas.map((p) => p.journalEntryId).filter((x): x is string => !!x);
  const asientos = ids.length
    ? await prisma.journalEntry.findMany({ where: { id: { in: ids } }, select: { id: true, numeroAsiento: true } })
    : [];
  const numeros = new Map(asientos.map((a) => [a.id, a.numeroAsiento]));
  const cobrado = round2(filas.filter((p) => p.estado === 'ACTIVO').reduce((s, p) => s + p.importe, 0));
  const estado =
    tipo === 'INGRESO'
      ? cobradaSinCobros(tipo, f.estado, cobrado)
        ? 'PAID'
        : estadoTrasCobros(tipo, f, cobrado)
      : estadoTrasCobros(tipo, f, cobrado);
  return {
    invoiceId: f.id,
    tipo,
    numeroFactura: f.numeroCompleto,
    totalFactura: f.totalFactura,
    importeCobrado: cobrado,
    importePendiente: calcularPendiente(tipo, f.totalFactura, f.estado, cobrado),
    estado,
    cobros: filas.map((p) => aCobroResp(p, numeros)),
  };
}

/**
 * Registra un cobro (venta) o pago (gasto) y su asiento. Sin importe, se cobra
 * todo lo pendiente.
 */
export async function registrarCobroFactura(
  companyId: string,
  tipo: TipoDocumento,
  invoiceId: string,
  datos: DatosCobro,
): Promise<{ cobro: CobroResp; resumen: ResumenCobros }> {
  const t = TXT[tipo];
  const f = await cargarFactura(prisma, companyId, tipo, invoiceId);
  if (aCentimos(f.totalFactura) <= 0) {
    throw badRequest(`La factura tiene importe cero o negativo (rectificativa): no admite ${t.cobro}s desde aquí.`);
  }
  const fecha = validarFecha(datos.fecha);
  if (fecha < f.fechaEmision) throw badRequest(`La fecha del ${t.cobro} no puede ser anterior a la de la factura (${f.fechaEmision}).`);
  if (datos.importe !== undefined && datos.importe !== null && !Number.isFinite(Number(datos.importe))) {
    throw badRequest('El importe no es un número.');
  }
  await comprobarFechaAbierta(companyId, fecha);
  const tesoreria = await resolverTesoreria(companyId, datos, tipo);
  const cuentaTercero = await cuentaTerceroDeFactura(companyId, tipo, invoiceId);
  const nota = datos.nota?.trim() ? datos.nota.trim().slice(0, 1000) : null;
  const numero = f.numeroCompleto ?? f.id;

  const id = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquearFactura(tx, tipo, invoiceId);
      const actual = await cargarFactura(tx, companyId, tipo, invoiceId);
      const cobrado = await sumaActivos(tx, companyId, tipo, invoiceId);
      const pendiente = calcularPendiente(tipo, actual.totalFactura, actual.estado, cobrado);
      if (aCentimos(pendiente) <= 0) throw badRequest(`La factura ${numero} ya está ${t.cobrado}: no queda nada pendiente.`);
      const importe = datos.importe === undefined || datos.importe === null ? pendiente : round2(Number(datos.importe));
      if (aCentimos(importe) <= 0) throw badRequest('El importe tiene que ser mayor que cero.');
      if (aCentimos(importe) > aCentimos(pendiente)) {
        throw badRequest(`El importe (${importe.toFixed(2)} €) supera lo pendiente de la factura (${pendiente.toFixed(2)} €).`);
      }

      const descripcion = `${t.Cobro} factura ${numero} - ${actual.tercero}${nota ? ` (${nota})` : ''}`;
      const nombreTercero = tipo === 'INGRESO' ? `Clientes · ${actual.tercero}` : `Proveedores · ${actual.tercero}`;
      const apuntes: Apunte[] =
        tipo === 'INGRESO'
          ? [
              { cuenta: tesoreria.cuenta, nombre: tesoreria.nombre, debe: importe, haber: 0 },
              { cuenta: cuentaTercero, nombre: nombreTercero, debe: 0, haber: importe },
            ]
          : [
              { cuenta: cuentaTercero, nombre: nombreTercero, debe: importe, haber: 0 },
              { cuenta: tesoreria.cuenta, nombre: tesoreria.nombre, debe: 0, haber: importe },
            ];
      const asiento = await crearAsiento(tx, companyId, {
        prefijo: t.prefijo,
        fecha,
        descripcion,
        tipo,
        invoiceId,
        referencia: numero,
        apuntes,
      });
      const pago = await tx.invoicePayment.create({
        data: {
          companyId,
          invoiceType: tipo,
          invoiceId,
          fecha,
          importe,
          cuentaTesoreria: tesoreria.cuenta,
          bankAccountId: tesoreria.bankAccountId,
          nota,
          journalEntryId: asiento.id,
          createdBy: datos.userId ?? null,
        },
      });
      // Una factura de venta "cobrada a mano" (legacy) no llega aqui: su pendiente es 0.
      await actualizarEstadoFactura(tx, actual, tipo);
      return pago.id;
    }),
  );

  const resumen = await listarCobros(companyId, tipo, invoiceId);
  return { cobro: resumen.cobros.find((c) => c.id === id)!, resumen };
}

/**
 * Anula un cobro/pago. Si su fecha esta en un periodo abierto, el asiento pasa
 * a REVERSED (deja de contar). Si no, se crea un contraasiento con la fecha de
 * anulacion (por defecto hoy), que tiene que caer en un periodo abierto.
 */
export async function anularCobroFactura(
  companyId: string,
  tipo: TipoDocumento,
  invoiceId: string,
  cobroId: string,
  opciones: { fecha?: string } = {},
): Promise<{ resumen: ResumenCobros; contraasiento: boolean }> {
  const t = TXT[tipo];
  const pago = await prisma.invoicePayment.findFirst({ where: { id: cobroId, companyId, invoiceType: tipo, invoiceId } });
  if (!pago) throw notFound(`${t.Cobro} no encontrado.`);
  if (pago.estado !== 'ACTIVO') throw badRequest(`El ${t.cobro} ya está anulado.`);
  const f = await cargarFactura(prisma, companyId, tipo, invoiceId);

  let periodoAbierto = true;
  try {
    await comprobarFechaAbierta(companyId, pago.fecha);
  } catch {
    periodoAbierto = false;
  }
  const fechaAnulacion = periodoAbierto ? pago.fecha : validarFecha(opciones.fecha);
  if (!periodoAbierto) await comprobarFechaAbierta(companyId, fechaAnulacion);

  const original = pago.journalEntryId
    ? await prisma.journalEntry.findFirst({ where: { id: pago.journalEntryId, companyId }, include: { lineas: true } })
    : null;

  await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquearFactura(tx, tipo, invoiceId);
      const r = await tx.invoicePayment.updateMany({
        where: { id: pago.id, estado: 'ACTIVO' },
        data: { estado: 'ANULADO', anuladoEn: new Date() },
      });
      if (r.count !== 1) throw badRequest(`El ${t.cobro} ya está anulado.`);
      if (original && original.estado !== 'REVERSED') {
        if (periodoAbierto) {
          await tx.journalEntry.update({ where: { id: original.id }, data: { estado: 'REVERSED' } });
        } else {
          const contra = await crearAsiento(tx, companyId, {
            prefijo: t.prefijo,
            fecha: fechaAnulacion,
            descripcion: `Anulación ${t.cobro} factura ${f.numeroCompleto ?? f.id} (${original.numeroAsiento})`,
            tipo,
            invoiceId,
            referencia: `REV-${f.numeroCompleto ?? f.id}`,
            apuntes: original.lineas.map((l) => ({ cuenta: l.accountCode, nombre: l.accountName, debe: l.haber, haber: l.debe })),
          });
          await tx.invoicePayment.update({ where: { id: pago.id }, data: { anulacionEntryId: contra.id } });
        }
      }
      await actualizarEstadoFactura(tx, f, tipo);
    }),
  );

  return { resumen: await listarCobros(companyId, tipo, invoiceId), contraasiento: !periodoAbierto };
}

/** Cobrado/pagado (cobros activos con fecha <= hasta) por factura, para cruces. */
export async function cobradoPorFactura(companyId: string, tipo: TipoDocumento, hasta?: string): Promise<Map<string, number>> {
  const filas = await prisma.invoicePayment.groupBy({
    by: ['invoiceId'],
    where: { companyId, invoiceType: tipo, estado: 'ACTIVO', ...(hasta ? { fecha: { lte: hasta } } : {}) },
    _sum: { importe: true },
  });
  return new Map(filas.map((r) => [r.invoiceId, round2(Number(r._sum.importe ?? 0))]));
}

/** Hay cobros activos en la factura (para no "desmarcar" una factura cobrada con asientos). */
export async function tieneCobrosActivos(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<boolean> {
  return (await prisma.invoicePayment.count({ where: { companyId, invoiceType: tipo, invoiceId, estado: 'ACTIVO' } })) > 0;
}
