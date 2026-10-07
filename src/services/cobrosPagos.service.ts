import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import { estadoPeriodoEnFecha } from './periodos.service';
import {
  calcularCobroDivisa,
  comprobarTipoManual,
  importeConMoneda,
  textoTipo,
  validarFormatoTipoCambio,
  type ApunteCobro,
} from '../domain/divisas';
import { CONTABLE_RULES } from './accounting-engine.service';
import { perfilEmpresa } from './perfilEmpresa.service';
import { tipoReferencia } from './tiposCambio.service';
import { asegurarPlanContableEmpresa } from './chart-of-accounts.service';

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
 *
 * DIVISAS (facturas de venta en otra moneda que la de cuenta): lo pendiente y
 * el estado de cobro van en la moneda de la factura. La 430 se salda al tipo de
 * la factura (en proporcion; el ultimo cobro salda el resto exacto), en el
 * banco entra lo recibido al tipo del dia del cobro y la diferencia va a la
 * 768 (ganancia) o a la 668 (perdida); la comision del banco, a la 626. Ver
 * calcularCobroDivisa en domain/divisas.ts. `importe` de cada cobro es SIEMPRE
 * lo aplicado a la 430/400 en moneda de cuenta, asi que lo cobrado segun las
 * facturas sigue cuadrando con el mayor.
 */

export type TipoDocumento = 'INGRESO' | 'GASTO';

export interface DatosCobro {
  fecha?: string;
  /**
   * Importe cobrado/pagado. En una factura en la moneda de cuenta es lo de
   * siempre; en una factura en divisa hay que usar `importeDoc`.
   */
  importe?: number;
  /** Lo que se cobra, en la moneda de la factura. Sin el (ni `importe`), todo lo pendiente. */
  importeDoc?: number;
  cuentaBancariaId?: string;
  /** true: cobro/pago en efectivo (570 Caja). */
  caja?: boolean;
  nota?: string;
  userId?: string;
  /** Solo en divisa: lo que ha llegado al banco, en la moneda de cuenta (ya sin la comision). */
  importeRecibido?: number;
  /**
   * Solo en divisa: tipo del dia del cobro (unidades de la moneda de la factura
   * por 1 de la de cuenta, "1 EUR = 1,0500 USD" -> 1.05). Sin el ni
   * `importeRecibido`, el de referencia del BCE de la fecha del cobro.
   */
  tipoCambio?: number | string;
  /** Solo en divisa: comision del banco en la moneda de cuenta (cuenta 626). */
  comisionBancaria?: number;
}

export interface CobroResp {
  id: string;
  fecha: string;
  /** En la moneda de cuenta: lo aplicado a la cuenta del cliente/proveedor (430/400), al tipo de la factura. */
  importe: number;
  /** Moneda de la factura. */
  moneda: string;
  /** En la moneda de la factura (lo que reduce lo pendiente). */
  importeDoc: number;
  /** En la moneda de cuenta: lo que entro (o salio) del banco o la caja. */
  importeTesoreria: number;
  /** Unidades de la moneda de la factura por 1 de la de cuenta, al cobrar (1 si es la misma). */
  tipoCambio: number;
  /** PAR | BCE | MANUAL | BANCO */
  fuenteTipoCambio: string;
  /** En la moneda de cuenta: > 0 ganancia (768), < 0 perdida (668) en los cobros. */
  diferenciaCambio: number;
  /** En la moneda de cuenta (626). */
  comisionBancaria: number;
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
  /** Moneda de la factura y de la contabilidad. */
  moneda: string;
  monedaCuenta: string;
  /** Total, cobrado y pendiente en la MONEDA DE LA FACTURA. */
  totalFactura: number;
  /** Suma de cobros/pagos activos. */
  importeCobrado: number;
  importePendiente: number;
  /** Lo mismo en la moneda de cuenta (cuadra con el saldo de la 430/400). */
  totalFacturaCuenta: number;
  importeCobradoCuenta: number;
  importePendienteCuenta: number;
  /** INGRESO: PENDING | OVERDUE | PAID. GASTO: PENDIENTE | PARCIAL | PAGADA. */
  estado: string;
  cobros: CobroResp[];
}

const CUENTA_CAJA = '570';
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const hoyISO = (): string => hoyEspana();
const hay = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

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
  /** En la moneda de cuenta. */
  totalFactura: number;
  /** En la moneda de la factura (igual que totalFactura si es la misma). */
  totalDoc: number;
  /** Moneda de la factura; null = la de cuenta (las de gasto no tienen moneda propia). */
  moneda: string | null;
  estado: string;
  tercero: string;
}

async function cargarFactura(db: Tx | typeof prisma, companyId: string, tipo: TipoDocumento, id: string): Promise<FacturaBase> {
  if (tipo === 'INGRESO') {
    const f = await db.incomeInvoice.findFirst({ where: { id, companyId }, include: { customer: { select: { nombreFiscal: true } } } });
    if (!f) throw notFound('Factura no encontrada.');
    if (f.estadoDocumento === 'PROFORMA') throw badRequest('Una proforma no admite cobros: pásala a factura y emítela antes.');
    if (f.estadoDocumento !== 'FINAL') throw badRequest('La factura está en borrador: emítela antes de registrar cobros.');
    // Lo pendiente se lleva en la moneda de la factura (null = igual que la de cuenta).
    return { ...f, totalDoc: f.totalFacturaDoc ?? f.totalFactura, moneda: f.moneda, tercero: f.customer.nombreFiscal };
  }
  const f = await db.expenseInvoice.findFirst({ where: { id, companyId }, include: { supplier: { select: { nombreFiscal: true } } } });
  if (!f) throw notFound('Factura de gasto no encontrada.');
  // Gastos en divisa: fuera de alcance. Van en la moneda de cuenta.
  return { ...f, totalDoc: f.totalFactura, moneda: null, tercero: f.supplier.nombreFiscal };
}

/**
 * Factura de venta marcada como cobrada a mano antes de que existieran los
 * cobros (estado PAID sin ningun cobro activo): se da por cobrada entera.
 */
const cobradaSinCobros = (tipo: TipoDocumento, estado: string, cobrado: number) => tipo === 'INGRESO' && estado === 'PAID' && cobrado === 0;

/**
 * Pendiente de una factura a partir de su total, su estado y lo cobrado. Puro.
 *
 * `cobradoACorte` es lo cobrado hasta una fecha (por defecto, todo lo cobrado):
 * el pendiente se calcula con eso, pero lo de "cobrada a mano" se decide con
 * todos los cobros, para no tomar por cobrada a mano una factura cuyo cobro
 * tiene fecha posterior al corte.
 */
export function calcularPendiente(
  tipo: TipoDocumento,
  totalFactura: number,
  estado: string,
  cobrado: number,
  cobradoACorte: number = cobrado,
): number {
  if (cobradaSinCobros(tipo, estado, cobrado)) return 0;
  return round2(totalFactura - cobradoACorte);
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

/**
 * Lo cobrado (cobros activos) en la moneda de la factura (`doc`) y en la de
 * cuenta (`cuenta`, lo aplicado a la 430/400). Los cobros anteriores a las
 * divisas no tienen importeDoc: es su `importe`.
 */
async function sumaActivos(
  db: Tx | typeof prisma,
  companyId: string,
  tipo: TipoDocumento,
  invoiceId: string,
): Promise<{ doc: number; cuenta: number }> {
  const filas = await db.invoicePayment.findMany({
    where: { companyId, invoiceType: tipo, invoiceId, estado: 'ACTIVO' },
    select: { importe: true, importeDoc: true },
  });
  return {
    doc: round2(filas.reduce((s, p) => s + Number(p.importeDoc ?? p.importe), 0)),
    cuenta: round2(filas.reduce((s, p) => s + Number(p.importe), 0)),
  };
}

/** Guarda el estado de cobro/pago de la factura segun sus cobros activos (en la moneda de la factura). */
async function actualizarEstadoFactura(tx: Tx, f: FacturaBase, tipo: TipoDocumento): Promise<string> {
  const cobrado = await sumaActivos(tx, f.companyId, tipo, f.id);
  const estado = estadoTrasCobros(tipo, { totalFactura: f.totalDoc, fechaVencimiento: f.fechaVencimiento }, cobrado.doc);
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

/**
 * Cuenta de tesoreria: la de la cuenta bancaria indicada, caja, o la primera
 * cuenta bancaria activa. `moneda` es la de la cuenta bancaria (null en caja:
 * la de cuenta).
 */
async function resolverTesoreria(
  companyId: string,
  datos: DatosCobro,
  tipo: TipoDocumento,
): Promise<{ cuenta: string; bankAccountId: string | null; nombre: string; moneda: string | null }> {
  if (datos.caja) return { cuenta: CUENTA_CAJA, bankAccountId: null, nombre: 'Caja', moneda: null };
  if (datos.cuentaBancariaId) {
    const c = await prisma.bankAccount.findFirst({ where: { id: datos.cuentaBancariaId, companyId } });
    if (!c) throw badRequest('La cuenta bancaria no existe en esta empresa.');
    if (!c.activa) throw badRequest('La cuenta bancaria está desactivada.');
    return { cuenta: c.subcuentaCodigo, bankAccountId: c.id, nombre: c.bancoNombre || c.iban, moneda: c.moneda };
  }
  const c = await prisma.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } });
  if (!c) {
    throw badRequest(
      `No hay ninguna cuenta bancaria activa para apuntar el ${TXT[tipo].cobro}. Créala en Tesorería > Cuentas bancarias (con su subcuenta 572), o indica que es en efectivo (caja).`,
    );
  }
  return { cuenta: c.subcuentaCodigo, bankAccountId: c.id, nombre: c.bancoNombre || c.iban, moneda: c.moneda };
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

/**
 * Apuntes del asiento de un cobro/pago a partir del calculo (puro): tesoreria,
 * tercero, comision (626) y diferencias de cambio (768/668), con las cuentas
 * de CONTABLE_RULES.
 */
export function apuntesDeCobro(
  apuntes: ApunteCobro[],
  cuentas: { tesoreria: { cuenta: string; nombre: string }; tercero: { cuenta: string; nombre: string } },
): Apunte[] {
  const de: Record<ApunteCobro['cuenta'], { cuenta: string; nombre: string }> = {
    TESORERIA: cuentas.tesoreria,
    TERCERO: cuentas.tercero,
    COMISION: { cuenta: CONTABLE_RULES.COMISION_BANCARIA.cuenta, nombre: 'Servicios bancarios y similares' },
    DIF_POSITIVA: { cuenta: CONTABLE_RULES.DIFERENCIAS_CAMBIO.positiva, nombre: 'Diferencias positivas de cambio' },
    DIF_NEGATIVA: { cuenta: CONTABLE_RULES.DIFERENCIAS_CAMBIO.negativa, nombre: 'Diferencias negativas de cambio' },
  };
  return apuntes.map((a) => ({ ...de[a.cuenta], debe: a.debe, haber: a.haber }));
}

type FilaPago = Awaited<ReturnType<typeof prisma.invoicePayment.findMany>>[number];

function aCobroResp(p: FilaPago, numeros: Map<string, string>): CobroResp {
  return {
    id: p.id,
    fecha: p.fecha,
    importe: p.importe,
    moneda: p.moneda,
    // Cobros anteriores a las divisas: sin importeDoc ni importeTesoreria (= importe).
    importeDoc: p.importeDoc ?? p.importe,
    importeTesoreria: p.importeTesoreria ?? p.importe,
    tipoCambio: p.tipoCambio,
    fuenteTipoCambio: p.fuenteTipoCambio,
    diferenciaCambio: p.diferenciaCambio,
    comisionBancaria: p.comisionBancaria,
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

/** Cobros (o pagos) de una factura, con lo cobrado y lo pendiente (en la moneda de la factura y en la de cuenta). */
export async function listarCobros(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<ResumenCobros> {
  const f = await cargarFactura(prisma, companyId, tipo, invoiceId);
  const { monedaCuenta } = await perfilEmpresa(companyId);
  const filas = await prisma.invoicePayment.findMany({
    where: { companyId, invoiceType: tipo, invoiceId },
    orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
  });
  const ids = filas.map((p) => p.journalEntryId).filter((x): x is string => !!x);
  const asientos = ids.length
    ? await prisma.journalEntry.findMany({ where: { id: { in: ids } }, select: { id: true, numeroAsiento: true } })
    : [];
  const numeros = new Map(asientos.map((a) => [a.id, a.numeroAsiento]));
  const activos = filas.filter((p) => p.estado === 'ACTIVO');
  const cobrado = round2(activos.reduce((s, p) => s + (p.importeDoc ?? p.importe), 0));
  const cobradoCuenta = round2(activos.reduce((s, p) => s + p.importe, 0));
  const enDoc = { totalFactura: f.totalDoc, fechaVencimiento: f.fechaVencimiento };
  const estado =
    tipo === 'INGRESO'
      ? cobradaSinCobros(tipo, f.estado, cobrado)
        ? 'PAID'
        : estadoTrasCobros(tipo, enDoc, cobrado)
      : estadoTrasCobros(tipo, enDoc, cobrado);
  return {
    invoiceId: f.id,
    tipo,
    numeroFactura: f.numeroCompleto,
    moneda: f.moneda ?? monedaCuenta,
    monedaCuenta,
    totalFactura: f.totalDoc,
    importeCobrado: cobrado,
    importePendiente: calcularPendiente(tipo, f.totalDoc, f.estado, cobrado),
    totalFacturaCuenta: f.totalFactura,
    importeCobradoCuenta: cobradoCuenta,
    importePendienteCuenta: calcularPendiente(tipo, f.totalFactura, f.estado, cobradoCuenta),
    estado,
    cobros: filas.map((p) => aCobroResp(p, numeros)),
  };
}

/**
 * Tipo del dia para un cobro en divisa (fuera de cualquier transaccion): el
 * indicado a mano (comprobado contra el del BCE si se conoce: invertido o muy
 * lejos -> 400) o, si no, el de referencia del BCE de la fecha del cobro. Sin
 * BCE y sin tipo, 400: se pide el tipo o lo recibido en el banco.
 */
async function tipoDelCobro(
  monedaCuenta: string,
  moneda: string,
  fecha: string,
  manual: unknown,
): Promise<{ tipoCambio: number; fuente: 'BCE' | 'MANUAL' }> {
  if (hay(manual)) {
    const tipoCambio = validarFormatoTipoCambio(manual);
    const ref = await tipoReferencia(monedaCuenta, moneda, fecha, { permitirVieja: true }).catch(() => null);
    comprobarTipoManual(tipoCambio, ref?.tipoCambio ?? null, monedaCuenta, moneda);
    return { tipoCambio, fuente: 'MANUAL' };
  }
  const ref = await tipoReferencia(monedaCuenta, moneda, fecha, { permitirVieja: false }).catch(() => null);
  if (!ref) {
    throw badRequest(
      `No se ha podido obtener el tipo del BCE para ${moneda} a ${fecha.slice(8, 10)}/${fecha.slice(5, 7)}/${fecha.slice(0, 4)}: indica el tipo de cambio del día o lo recibido en el banco.`,
    );
  }
  return { tipoCambio: ref.tipoCambio, fuente: 'BCE' };
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
  for (const [campo, valor] of [
    ['importe', datos.importe],
    ['importe', datos.importeDoc],
    ['importe recibido', datos.importeRecibido],
    ['comisión', datos.comisionBancaria],
  ] as const) {
    if (hay(valor) && !Number.isFinite(Number(valor))) throw badRequest(`El ${campo} no es un número.`);
  }

  const { monedaCuenta } = await perfilEmpresa(companyId);
  const moneda = f.moneda ?? monedaCuenta;
  const enDivisa = moneda !== monedaCuenta;
  if (!enDivisa && (hay(datos.tipoCambio) || hay(datos.importeRecibido) || hay(datos.comisionBancaria))) {
    throw badRequest('El tipo de cambio, lo recibido en el banco y la comisión solo se indican en cobros de facturas en otra moneda.');
  }
  // En divisa, el importe tiene que decir en que moneda va: importeDoc (moneda de la factura).
  if (enDivisa && hay(datos.importe) && !hay(datos.importeDoc)) {
    throw badRequest(`La factura está en ${moneda}: indica el importe cobrado en ${moneda} (importeDoc).`);
  }
  const solicitado = hay(datos.importeDoc) ? Number(datos.importeDoc) : hay(datos.importe) ? Number(datos.importe) : undefined;

  await comprobarFechaAbierta(companyId, fecha);
  const tesoreria = await resolverTesoreria(companyId, datos, tipo);
  const cuentaTercero = await cuentaTerceroDeFactura(companyId, tipo, invoiceId);
  const nota = datos.nota?.trim() ? datos.nota.trim().slice(0, 1000) : null;
  const numero = f.numeroCompleto ?? f.id;

  // El tipo del dia se resuelve ANTES de la transaccion (puede consultar al BCE).
  const delDia = enDivisa && !hay(datos.importeRecibido) ? await tipoDelCobro(monedaCuenta, moneda, fecha, datos.tipoCambio) : null;
  // 768, 668 y 626 en el plan de las empresas que ya existian.
  if (enDivisa) await asegurarPlanContableEmpresa(companyId);

  const id = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquearFactura(tx, tipo, invoiceId);
      const actual = await cargarFactura(tx, companyId, tipo, invoiceId);
      const cobrado = await sumaActivos(tx, companyId, tipo, invoiceId);
      const pendiente = calcularPendiente(tipo, actual.totalDoc, actual.estado, cobrado.doc);
      if (aCentimos(pendiente) <= 0) throw badRequest(`La factura ${numero} ya está ${t.cobrado}: no queda nada pendiente.`);
      const importeDoc = solicitado === undefined ? pendiente : round2(solicitado);
      if (aCentimos(importeDoc) <= 0) throw badRequest('El importe tiene que ser mayor que cero.');
      if (aCentimos(importeDoc) > aCentimos(pendiente)) {
        const simbolo = moneda === 'EUR' ? '€' : moneda;
        throw badRequest(
          `El importe (${importeDoc.toFixed(2)} ${simbolo}) supera lo pendiente de la factura (${pendiente.toFixed(2)} ${simbolo}).`,
        );
      }

      const calculo = calcularCobroDivisa({
        tipo,
        moneda,
        monedaCuenta,
        monedaTesoreria: tesoreria.moneda ?? monedaCuenta,
        totalCuenta: actual.totalFactura,
        totalDoc: actual.totalDoc,
        cobradoCuenta: cobrado.cuenta,
        cobradoDoc: cobrado.doc,
        importeDoc,
        importeRecibido: hay(datos.importeRecibido) ? Number(datos.importeRecibido) : null,
        tipoCambio: delDia?.tipoCambio ?? null,
        fuenteTipoCambio: delDia?.fuente ?? null,
        comisionBancaria: hay(datos.comisionBancaria) ? Number(datos.comisionBancaria) : null,
      });

      const divisa = enDivisa
        ? ` [${importeConMoneda(calculo.importeDoc, moneda)}; ${textoTipo(monedaCuenta, moneda, calculo.tipoCambio)}]`
        : '';
      const descripcion = `${t.Cobro} factura ${numero} - ${actual.tercero}${divisa}${nota ? ` (${nota})` : ''}`;
      const nombreTercero = tipo === 'INGRESO' ? `Clientes · ${actual.tercero}` : `Proveedores · ${actual.tercero}`;
      const apuntes = apuntesDeCobro(calculo.apuntes, {
        tesoreria: { cuenta: tesoreria.cuenta, nombre: tesoreria.nombre },
        tercero: { cuenta: cuentaTercero, nombre: nombreTercero },
      });
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
          importe: calculo.importe,
          moneda,
          importeDoc: calculo.importeDoc,
          importeTesoreria: calculo.importeTesoreria,
          tipoCambio: calculo.tipoCambio,
          fuenteTipoCambio: calculo.fuenteTipoCambio,
          diferenciaCambio: calculo.diferenciaCambio,
          comisionBancaria: calculo.comisionBancaria,
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
 * anulacion (por defecto hoy), que tiene que caer en un periodo abierto. En
 * divisa se invierten todas sus lineas (tambien la 626, la 668 y la 768) y el
 * estado se recalcula en la moneda de la factura.
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

/**
 * Cobrado/pagado (cobros activos con fecha <= hasta) por factura, para cruces.
 * En la moneda de cuenta: lo aplicado a la 430/400 (cuadra con el mayor).
 */
export async function cobradoPorFactura(companyId: string, tipo: TipoDocumento, hasta?: string): Promise<Map<string, number>> {
  const filas = await prisma.invoicePayment.groupBy({
    by: ['invoiceId'],
    where: { companyId, invoiceType: tipo, estado: 'ACTIVO', ...(hasta ? { fecha: { lte: hasta } } : {}) },
    _sum: { importe: true },
  });
  return new Map(filas.map((r) => [r.invoiceId, round2(Number(r._sum.importe ?? 0))]));
}

/** Suma de los cobros/pagos activos con fecha entre `desde` y `hasta` (ambas incluidas). */
export async function totalCobradoEntre(companyId: string, tipo: TipoDocumento, desde: string, hasta: string): Promise<number> {
  const r = await prisma.invoicePayment.aggregate({
    where: { companyId, invoiceType: tipo, estado: 'ACTIVO', fecha: { gte: desde, lte: hasta } },
    _sum: { importe: true },
  });
  return round2(Number(r._sum.importe ?? 0));
}

/** Hay cobros activos en la factura (para no "desmarcar" una factura cobrada con asientos). */
export async function tieneCobrosActivos(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<boolean> {
  return (await prisma.invoicePayment.count({ where: { companyId, invoiceType: tipo, invoiceId, estado: 'ACTIVO' } })) > 0;
}
