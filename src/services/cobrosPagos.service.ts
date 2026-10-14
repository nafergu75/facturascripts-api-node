import { prisma, type TransaccionBD as Tx } from '../config/database';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { partidaDeFactura } from './arranque/partidas.service';
import { aCentimos } from '../utils/money';
import { fechaTexto, hoyEspana } from '../utils/fechas';
import { comprobarFechaAbierta, exigirFechaContabilizable } from './periodos.service';
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
import { referenciaParaComprobar, tipoReferencia } from './tiposCambio.service';
import { asegurarPlanContableEmpresa } from './chart-of-accounts.service';
import { esTipoGasto, TIPO_GASTO_INFO } from '../domain/factura-gasto.model';
import { subcuentaClienteParaApunte, subcuentaProveedorParaApunte } from './terceros/subcuentas';
import { esSubcuentaGenerica } from './terceros/numeracion';
import { conReintento } from '../utils/reintento';
import { aFavorDeAbonos } from './rectificativasVenta.service';
import { asegurarSubcuentaBancoEnPlan, exigirSubcuentaDeBanco, nombreSubcuentaBanco } from './subcuentaBanco.service';

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
  /** Suma de cobros/pagos activos (y, en gastos, de lo compensado con abonos). */
  importeCobrado: number;
  /** Gastos: lo compensado con abonos (incluido en importeCobrado). En un abono, en negativo. */
  importeCompensado: number;
  /** true si es un abono (total < 0): sus «pagos» son devoluciones (recibidas en gastos, al cliente en ventas). */
  esAbono: boolean;
  /** Ventas, solo en un abono: lo que queda a favor del cliente (en la moneda de la factura, sin lo ya devuelto). */
  aFavor?: number;
  importePendiente: number;
  /** Lo mismo en la moneda de cuenta (cuadra con el saldo de la 430/400). */
  totalFacturaCuenta: number;
  importeCobradoCuenta: number;
  importePendienteCuenta: number;
  /** INGRESO: PENDING | OVERDUE | PAID. GASTO: PENDIENTE | PARCIAL | PAGADA. */
  estado: string;
  /**
   * Cuenta del cliente o proveedor contra la que va el cobro o pago: la del
   * asiento de la factura o, sin el, la subcuenta de su ficha (null si aun no
   * tiene). Solo para ensenarla: no asigna nada.
   */
  cuentaTercero: string | null;
  /**
   * Ventas: la rectificativa por sustitucion que reemplazo esta factura. Ya no
   * se cobra (lo pendiente es 0): los cobros se apuntan en la sustituta.
   */
  sustituidaPor?: { id: string; numeroCompleto: string | null };
  /**
   * Ventas, en una rectificativa por sustitucion: lo cobrado a la factura que
   * sustituye (en la moneda de la factura y en la de cuenta). Cuenta como
   * cobrado: lo pendiente es su total menos sus cobros y estos.
   */
  cobradoEnOriginal?: { id: string; numeroCompleto: string | null; importe: number; importeCuenta: number };
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
/** Un abono de proveedor no se paga: el proveedor devuelve lo que queda a tu favor. */
const TXT_DEVOLUCION = { cobro: 'devolución', Cobro: 'Devolución recibida', prefijo: 'DEVOL', cobrado: 'devuelta' } as const;
/** Un abono de venta no se cobra: se le devuelve al cliente lo que queda a su favor. */
const TXT_DEVOLUCION_CLIENTE = { cobro: 'devolución', Cobro: 'Devolución al cliente', prefijo: 'DEVOL', cobrado: 'devuelta' } as const;
/** Textos de un abono (total < 0) segun el tipo. */
const textosAbono = (tipo: TipoDocumento) => (tipo === 'GASTO' ? TXT_DEVOLUCION : TXT_DEVOLUCION_CLIENTE);
/** «el cobro», «el pago» o «la devolución», para meterlo en una frase. */
const conArticulo = (t: { cobro: string }) => (t.cobro === 'devolución' ? `la ${t.cobro}` : `el ${t.cobro}`);
/** «del cobro», «del pago» o «de la devolución». */
const delArticulo = (t: { cobro: string }) => (t.cobro === 'devolución' ? `de la ${t.cobro}` : `del ${t.cobro}`);
/** «El cobro ya está anulado.» o «La devolución ya está anulada.» */
const yaAnulado = (t: { cobro: string }) => (t.cobro === 'devolución' ? `La ${t.cobro} ya está anulada.` : `El ${t.cobro} ya está anulado.`);

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
  if (f.estado === 'ANULADA') throw badRequest('La factura está anulada: no admite pagos.');
  if (f.estado === 'DRAFT') {
    throw badRequest('La factura está pendiente de revisar: aprueba su asiento en el Motor contable antes de registrar pagos.');
  }
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
  // Un abono (total < 0): devuelto o aplicado cuando lo pendiente llega a 0 por
  // arriba. Sin esto, un abono recien dado de alta saldria PAGADA (pendiente < 0).
  if (aCentimos(f.totalFactura) < 0) {
    if (aCentimos(pendiente) >= 0) return 'PAGADA';
    return aCentimos(cobrado) < 0 ? 'PARCIAL' : 'PENDIENTE';
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
  // Gastos: tambien lo compensado con abonos (CompensacionGasto), sin movimiento de dinero.
  const compensado = tipo === 'GASTO' ? await compensadoDe(db, companyId, invoiceId) : 0;
  return {
    doc: round2(filas.reduce((s, p) => s + Number(p.importeDoc ?? p.importe), 0) + compensado),
    cuenta: round2(filas.reduce((s, p) => s + Number(p.importe), 0) + compensado),
  };
}

/**
 * Lo compensado en una factura de gasto: lo que ha recibido de abonos (en
 * positivo) menos lo que ella, si es un abono, ha aplicado a otras.
 */
async function compensadoDe(db: Tx | typeof prisma, companyId: string, invoiceId: string): Promise<number> {
  const tabla = (db as unknown as { compensacionGasto?: { aggregate?: unknown } }).compensacionGasto;
  if (typeof tabla?.aggregate !== 'function') return 0;
  const [recibido, aplicado] = await Promise.all([
    db.compensacionGasto.aggregate({ where: { companyId, facturaId: invoiceId, estado: 'ACTIVO' }, _sum: { importe: true } }),
    db.compensacionGasto.aggregate({ where: { companyId, abonoId: invoiceId, estado: 'ACTIVO' }, _sum: { importe: true } }),
  ]);
  return (aCentimos(Number(recibido._sum.importe ?? 0)) - aCentimos(Number(aplicado._sum.importe ?? 0))) / 100;
}

/**
 * Venta y rectificativa por sustitucion (la S reemplaza a su original, con el
 * mismo criterio que la cartera, pendienteSinAbonos):
 *  - la original sustituida ya no se cobra: `sustituidaPor`;
 *  - en la S, lo cobrado a la original cuenta como cobrado: `original` y
 *    `cobradoOriginal`.
 */
interface SustitucionVenta {
  sustituidaPor: { id: string; numeroCompleto: string | null } | null;
  original: { id: string; numeroCompleto: string | null } | null;
  cobradoOriginal: { doc: number; cuenta: number };
}

const SIN_SUSTITUCION: SustitucionVenta = { sustituidaPor: null, original: null, cobradoOriginal: { doc: 0, cuenta: 0 } };

async function sustitucionVenta(db: Tx | typeof prisma, companyId: string, invoiceId: string): Promise<SustitucionVenta> {
  // Con una BD simulada sin la tabla de enlaces: como antes.
  if (typeof (db as unknown as { incomeInvoiceRectificada?: { findFirst?: unknown } }).incomeInvoiceRectificada?.findFirst !== 'function') return SIN_SUSTITUCION;
  const f = await db.incomeInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { esRectificativa: true, tipoRectificativa: true, facturaOriginalId: true } });
  if (!f) return SIN_SUSTITUCION;
  if (!f.esRectificativa) {
    const enlace = await db.incomeInvoiceRectificada.findFirst({
      where: { companyId, originalId: invoiceId, rectificativa: { estadoDocumento: 'FINAL', tipoRectificativa: 'S' } },
      select: { rectificativa: { select: { id: true, numeroCompleto: true } } },
    });
    const s =
      enlace?.rectificativa ??
      (await db.incomeInvoice.findFirst({
        where: { companyId, facturaOriginalId: invoiceId, estadoDocumento: 'FINAL', tipoRectificativa: 'S', enlacesRectifica: { none: {} } },
        select: { id: true, numeroCompleto: true },
      }));
    return s ? { ...SIN_SUSTITUCION, sustituidaPor: s } : SIN_SUSTITUCION;
  }
  if (f.tipoRectificativa !== 'S') return SIN_SUSTITUCION;
  const enlace = await db.incomeInvoiceRectificada.findFirst({
    where: { companyId, rectificativaId: invoiceId, originalId: { not: null } },
    select: { original: { select: { id: true, numeroCompleto: true } } },
  });
  const o = enlace?.original ?? (f.facturaOriginalId ? await db.incomeInvoice.findFirst({ where: { id: f.facturaOriginalId, companyId }, select: { id: true, numeroCompleto: true } }) : null);
  if (!o) return SIN_SUSTITUCION;
  return { sustituidaPor: null, original: o, cobradoOriginal: await sumaActivos(db, companyId, 'INGRESO', o.id) };
}

/** Recalcula el estado de pago de una factura de gasto (pagos, devoluciones y compensaciones). */
export async function recalcularEstadoPagoGasto(tx: Tx, companyId: string, invoiceId: string): Promise<string> {
  const f = await tx.expenseInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { id: true, totalFactura: true, fechaVencimiento: true } });
  if (!f) throw notFound('Factura de gasto no encontrada.');
  const cobrado = await sumaActivos(tx, companyId, 'GASTO', invoiceId);
  const estado = estadoTrasCobros('GASTO', { totalFactura: Number(f.totalFactura), fechaVencimiento: f.fechaVencimiento }, cobrado.doc);
  await tx.expenseInvoice.update({ where: { id: invoiceId }, data: { estadoPago: estado } });
  return estado;
}

/**
 * Guarda el estado de cobro/pago de la factura segun sus cobros activos (en la
 * moneda de la factura). En una venta por sustitucion cuentan tambien los
 * cobros de la original; un cobro de una original sustituida mueve el estado de su sustituta.
 */
async function actualizarEstadoFactura(tx: Tx, f: FacturaBase, tipo: TipoDocumento): Promise<string> {
  const cobrado = await sumaActivos(tx, f.companyId, tipo, f.id);
  const sust = tipo === 'INGRESO' ? await sustitucionVenta(tx, f.companyId, f.id) : SIN_SUSTITUCION;
  const estado = estadoTrasCobros(tipo, { totalFactura: f.totalDoc, fechaVencimiento: f.fechaVencimiento }, round2(cobrado.doc + sust.cobradoOriginal.doc));
  if (tipo === 'INGRESO') await tx.incomeInvoice.update({ where: { id: f.id }, data: { estado } });
  else await tx.expenseInvoice.update({ where: { id: f.id }, data: { estadoPago: estado } });
  if (sust.sustituidaPor) await recalcularEstadoCobroVenta(tx, f.companyId, sust.sustituidaPor.id);
  return estado;
}

/**
 * Estado de cobro de una venta segun sus cobros (y, en una sustitucion, los de
 * su original). Lo usa la emision de una rectificativa por sustitucion: si la
 * original ya estaba cobrada, la S nace cobrada.
 */
export async function recalcularEstadoCobroVenta(tx: Tx, companyId: string, invoiceId: string): Promise<string | null> {
  const f = await tx.incomeInvoice.findFirst({
    where: { id: invoiceId, companyId, estadoDocumento: 'FINAL' },
    select: { id: true, totalFactura: true, totalFacturaDoc: true, fechaVencimiento: true, estado: true },
  });
  if (!f) return null;
  const cobrado = await sumaActivos(tx, companyId, 'INGRESO', f.id);
  const sust = await sustitucionVenta(tx, companyId, f.id);
  // Cobrada a mano antes de los cobros (PAID sin cobros): se queda como esta.
  if (cobradaSinCobros('INGRESO', f.estado, cobrado.doc) && !sust.original) return f.estado;
  const estado = estadoTrasCobros('INGRESO', { totalFactura: Number(f.totalFacturaDoc ?? f.totalFactura), fechaVencimiento: f.fechaVencimiento }, round2(cobrado.doc + sust.cobradoOriginal.doc));
  if (estado !== f.estado) await tx.incomeInvoice.update({ where: { id: f.id }, data: { estado } });
  return estado;
}

/**
 * Subcuenta del cliente (43x, al debe) o del proveedor (40x/41x, al haber) que
 * uso el asiento de la factura: el cobro hereda la cuenta de la deuda. Sin
 * asiento (o sin esa linea), la subcuenta del tercero, asignada y dada de alta
 * en el plan si falta: en gastos, la 400N o la 410N segun el tipo de gasto,
 * para que el pago y la deuda casen al contabilizar la factura despues.
 * Nombre: el del plan; con la generica (asientos anteriores a las
 * subcuentas), "Clientes · X" o "Proveedores · X" como siempre.
 */
export async function cuentaTerceroDeFactura(
  tx: Tx,
  companyId: string,
  tipo: TipoDocumento,
  invoiceId: string,
): Promise<{ codigo: string; nombre: string }> {
  const asiento = await tx.journalEntry.findFirst({
    where: { companyId, invoiceId, invoiceType: tipo, origen: { not: 'TESORERIA' }, estado: { not: 'REVERSED' } },
    include: { lineas: true },
    orderBy: { createdAt: 'desc' },
  });
  // En gastos, por la cuenta y sin mirar el lado: un abono lleva la 400N/410N al debe.
  const linea = asiento?.lineas.find((l) => (tipo === 'INGRESO' ? l.accountCode.startsWith('43') && l.debe > 0 : /^4[01]/.test(l.accountCode)));
  if (tipo === 'INGRESO') {
    const f = await tx.incomeInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { customerId: true, customer: { select: { nombreFiscal: true } } } });
    if (!f) throw notFound('Factura no encontrada.');
    if (!linea) return subcuentaClienteParaApunte(tx, companyId, f.customerId);
    return { codigo: linea.accountCode, nombre: await nombreDeCuentaTercero(tx, companyId, linea.accountCode, `Clientes · ${f.customer.nombreFiscal}`) };
  }
  const f = await tx.expenseInvoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { supplierId: true, tipoGasto: true, supplier: { select: { nombreFiscal: true } } },
  });
  if (!f) throw notFound('Factura no encontrada.');
  if (!linea) return subcuentaProveedorParaApunte(tx, companyId, f.supplierId, esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA');
  return { codigo: linea.accountCode, nombre: await nombreDeCuentaTercero(tx, companyId, linea.accountCode, `Proveedores · ${f.supplier.nombreFiscal}`) };
}

/**
 * La cuenta que tomaria cuentaTerceroDeFactura, sin escribir nada (para la
 * pantalla): la linea del tercero del asiento de la factura o la subcuenta que
 * ya tiene su ficha (en gastos, la 400N o la 410N segun el tipo de gasto).
 */
async function cuentaTerceroParaVer(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<string | null> {
  const asiento = await prisma.journalEntry.findFirst({
    where: { companyId, invoiceId, invoiceType: tipo, origen: { not: 'TESORERIA' }, estado: { not: 'REVERSED' } },
    include: { lineas: true },
    orderBy: { createdAt: 'desc' },
  });
  const linea = asiento?.lineas.find((l) => (tipo === 'INGRESO' ? l.accountCode.startsWith('43') && l.debe > 0 : /^4[01]/.test(l.accountCode)));
  if (linea) return linea.accountCode;
  if (tipo === 'INGRESO') {
    const f = await prisma.incomeInvoice.findFirst({ where: { id: invoiceId, companyId }, select: { customer: { select: { subcuenta430: true } } } });
    return f?.customer.subcuenta430 ?? null;
  }
  const f = await prisma.expenseInvoice.findFirst({
    where: { id: invoiceId, companyId },
    select: { tipoGasto: true, supplier: { select: { subcuenta400: true, subcuenta410: true } } },
  });
  if (!f) return null;
  const acreedor = TIPO_GASTO_INFO[esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA'].acreedor;
  return (acreedor === '400' ? f.supplier.subcuenta400 : f.supplier.subcuenta410) ?? null;
}

/** Nombre del apunte del tercero: el del plan si es una subcuenta propia; con la generica, `generico`. */
async function nombreDeCuentaTercero(tx: Tx, companyId: string, codigo: string, generico: string): Promise<string> {
  if (esSubcuentaGenerica(codigo)) return generico;
  const c = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo }, select: { nombre: true } });
  return c?.nombre ?? generico;
}

/** Vive en periodos.service (la usan tambien el motor contable y las facturas). */
export { comprobarFechaAbierta };

/**
 * Cuenta de tesoreria: la de la cuenta bancaria indicada, caja, o la primera
 * cuenta bancaria activa. `moneda` es la de la cuenta bancaria (null en caja:
 * la de cuenta).
 *
 * La subcuenta de la cuenta bancaria tiene que ser de bancos (una 572 por debajo
 * de las de agrupacion): las dadas de alta antes de comprobarlo pueden tener
 * otra cosa (por ejemplo «0001») y el asiento iria a una cuenta que no es de
 * bancos. Si es una 572 que aun no esta en el plan, se da de alta al apuntar
 * (`altaEnPlan`, con el nombre del banco).
 *
 * `t`: los textos de lo que se apunta (en un abono, la devolucion), para los avisos.
 */
async function resolverTesoreria(
  companyId: string,
  datos: DatosCobro,
  tipo: TipoDocumento,
  t: { cobro: string } = TXT[tipo],
): Promise<{ cuenta: string; bankAccountId: string | null; nombre: string; moneda: string | null; altaEnPlan: string | null }> {
  if (datos.caja) return { cuenta: CUENTA_CAJA, bankAccountId: null, nombre: 'Caja', moneda: null, altaEnPlan: null };
  let c;
  if (datos.cuentaBancariaId) {
    c = await prisma.bankAccount.findFirst({ where: { id: datos.cuentaBancariaId, companyId } });
    if (!c) throw badRequest('La cuenta bancaria no existe en esta empresa.');
    if (!c.activa) throw badRequest('La cuenta bancaria está desactivada.');
  } else {
    c = await prisma.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } });
    if (!c) {
      throw badRequest(
        `No hay ninguna cuenta bancaria activa para apuntar ${conArticulo(t)}. Créala en Tesorería > Cuentas bancarias (con su subcuenta 572), o indica que es en efectivo (caja).`,
      );
    }
  }
  exigirSubcuentaDeBanco(c, `registrar ${conArticulo(t)}`);
  return { cuenta: c.subcuentaCodigo, bankAccountId: c.id, nombre: c.bancoNombre || c.iban, moneda: c.moneda, altaEnPlan: nombreSubcuentaBanco(c.bancoNombre, c.iban) };
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
  // Con tx: dentro de la transaccion, el cliente global se quedaba esperando
  // conexion (en produccion hay una sola) y el cobro daba 500 a los 30 s.
  await exigirFechaContabilizable(companyId, p.fecha, tx);
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

// conReintento (utils/reintento): si dos asientos a la vez sacan el mismo numero
// o la misma subcuenta (indice unico), se repite la transaccion.

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
  const compensado = tipo === 'GASTO' ? await compensadoDe(prisma, companyId, invoiceId) : 0;
  const cobrado = round2(activos.reduce((s, p) => s + (p.importeDoc ?? p.importe), 0) + compensado);
  const cobradoCuenta = round2(activos.reduce((s, p) => s + p.importe, 0) + compensado);
  // Venta por sustitucion: lo cobrado a la original cuenta en la S; la original sustituida ya no se cobra.
  const sust = tipo === 'INGRESO' ? await sustitucionVenta(prisma, companyId, invoiceId) : SIN_SUSTITUCION;
  const conOriginal = round2(cobrado + sust.cobradoOriginal.doc);
  const conOriginalCuenta = round2(cobradoCuenta + sust.cobradoOriginal.cuenta);
  const enDoc = { totalFactura: f.totalDoc, fechaVencimiento: f.fechaVencimiento };
  const estado =
    tipo === 'INGRESO'
      ? cobradaSinCobros(tipo, f.estado, conOriginal)
        ? 'PAID'
        : estadoTrasCobros(tipo, enDoc, conOriginal)
      : estadoTrasCobros(tipo, enDoc, cobrado);
  const pendiente = (total: number, c: number, conO: number) =>
    sust.sustituidaPor ? 0 : sust.original ? Math.max(0, calcularPendiente(tipo, total, f.estado, conO)) : calcularPendiente(tipo, total, f.estado, c);
  return {
    invoiceId: f.id,
    tipo,
    numeroFactura: f.numeroCompleto,
    moneda: f.moneda ?? monedaCuenta,
    monedaCuenta,
    totalFactura: f.totalDoc,
    importeCobrado: cobrado,
    importeCompensado: compensado,
    esAbono: aCentimos(f.totalFactura) < 0,
    ...(tipo === 'INGRESO' && aCentimos(f.totalFactura) < 0 ? { aFavor: (await aFavorDeAbonos(prisma, companyId, [invoiceId])).get(invoiceId) ?? 0 } : {}),
    importePendiente: pendiente(f.totalDoc, cobrado, conOriginal),
    totalFacturaCuenta: f.totalFactura,
    importeCobradoCuenta: cobradoCuenta,
    importePendienteCuenta: pendiente(f.totalFactura, cobradoCuenta, conOriginalCuenta),
    estado,
    cuentaTercero: await cuentaTerceroParaVer(companyId, tipo, invoiceId),
    ...(sust.sustituidaPor ? { sustituidaPor: sust.sustituidaPor } : {}),
    ...(sust.original ? { cobradoEnOriginal: { ...sust.original, importe: sust.cobradoOriginal.doc, importeCuenta: sust.cobradoOriginal.cuenta } } : {}),
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
    // Sin el BCE de esa fecha, con el ultimo guardado o uno orientativo: un tipo invertido o absurdo no pasa.
    const ref = await referenciaParaComprobar(monedaCuenta, moneda, fecha);
    comprobarTipoManual(tipoCambio, ref?.tipoCambio ?? null, monedaCuenta, moneda, { aproximado: ref?.aproximado });
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
  const f = await cargarFactura(prisma, companyId, tipo, invoiceId);
  // Abono (total < 0): lo que se registra es la devolucion (recibida del
  // proveedor en gastos; al cliente en ventas, hasta lo que queda a su favor).
  const esAbono = aCentimos(f.totalFactura) < 0;
  const devolucionCliente = esAbono && tipo === 'INGRESO';
  const t = esAbono ? textosAbono(tipo) : TXT[tipo];
  // Factura de 2026 que la gestoria trajo pendiente: se cobra (o se paga) contra su partida, no dos veces.
  const enlazada = await partidaDeFactura(companyId, tipo, invoiceId);
  if (enlazada) {
    throw conflict(`Esta factura está entre las pendientes de 2026 que trajo la gestoría (${enlazada.numeroDocumento}): ${conArticulo(t)} se apunta desde allí.`, { codigo: 'FACTURA_CON_PARTIDA_2026', partidaId: enlazada.id });
  }
  // Venta sustituida por una rectificativa por sustitucion: lo que se debe es la sustituta.
  const sustAntes = tipo === 'INGRESO' && !esAbono ? await sustitucionVenta(prisma, companyId, invoiceId) : SIN_SUSTITUCION;
  if (sustAntes.sustituidaPor) {
    const otra = sustAntes.sustituidaPor.numeroCompleto ?? 'rectificativa que la sustituye';
    throw conflict(`La factura ${f.numeroCompleto ?? ''} está sustituida por la ${otra}: ${conArticulo(t)} se apunta en la ${otra}.`, {
      codigo: 'FACTURA_SUSTITUIDA',
      facturaId: sustAntes.sustituidaPor.id,
    });
  }
  if (!esAbono && aCentimos(f.totalFactura) <= 0) {

    throw badRequest(`La factura tiene importe cero o negativo (rectificativa): no admite ${t.cobro}s desde aquí.`);
  }
  const fecha = validarFecha(datos.fecha);
  if (fecha < f.fechaEmision) throw badRequest(`La fecha ${delArticulo(t)} no puede ser anterior a la de la factura (${fechaTexto(f.fechaEmision)}).`);
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
  const tesoreria = await resolverTesoreria(companyId, datos, tipo, t);
  const nota = datos.nota?.trim() ? datos.nota.trim().slice(0, 1000) : null;
  const numero = f.numeroCompleto ?? f.id;

  // El tipo del dia se resuelve ANTES de la transaccion (puede consultar al BCE).
  const delDia = enDivisa && !hay(datos.importeRecibido) ? await tipoDelCobro(monedaCuenta, moneda, fecha, datos.tipoCambio) : null;
  // Con lo recibido en el banco, el tipo que sale de ahi se compara con el de
  // referencia de la fecha del cobro (como un tipo manual): una cifra en otra
  // moneda o con un cero de mas daria una diferencia de cambio desorbitada.
  const refRecibido = enDivisa && hay(datos.importeRecibido) ? await referenciaParaComprobar(monedaCuenta, moneda, fecha) : null;
  // 768, 668 y 626 en el plan de las empresas que ya existian.
  if (enDivisa) await asegurarPlanContableEmpresa(companyId);

  const id = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await bloquearFactura(tx, tipo, invoiceId);
      const actual = await cargarFactura(tx, companyId, tipo, invoiceId);
      const propio = await sumaActivos(tx, companyId, tipo, invoiceId);
      // Rectificativa de venta por sustitucion: lo cobrado a su original cuenta como cobrado.
      const sust = tipo === 'INGRESO' && !esAbono ? await sustitucionVenta(tx, companyId, invoiceId) : SIN_SUSTITUCION;
      const cobrado = { doc: round2(propio.doc + sust.cobradoOriginal.doc), cuenta: round2(propio.cuenta + sust.cobradoOriginal.cuenta) };
      // En un abono todo va con el signo cambiado: lo pendiente es lo que queda a tu favor.
      const s = esAbono ? -1 : 1;
      // Abono de venta: solo lo que no han descontado sus originales (aFavor, ya sin lo devuelto).
      const aFavor = devolucionCliente ? ((await aFavorDeAbonos(tx, companyId, [invoiceId])).get(invoiceId) ?? 0) : null;
      const pendiente = aFavor ?? s * calcularPendiente(tipo, actual.totalDoc, actual.estado, cobrado.doc);
      const simbolo = moneda === 'EUR' ? '€' : moneda;
      if (aCentimos(pendiente) <= 0) {
        throw badRequest(
          devolucionCliente
            ? `No queda nada a favor del cliente en el abono ${numero}: se ha descontado de lo que debía o ya está devuelto.`
            : esAbono
              ? `No queda nada a tu favor en el abono ${numero}: ya está devuelto o aplicado.`
              : `La factura ${numero} ya está ${t.cobrado}: no queda nada pendiente.`,
          devolucionCliente ? { codigo: 'DEVOLUCION_EXCEDE', campo: 'importe' } : undefined,
        );
      }
      const importeDoc = solicitado === undefined ? pendiente : round2(solicitado);
      if (aCentimos(importeDoc) <= 0) throw badRequest('El importe tiene que ser mayor que cero.');
      if (aCentimos(importeDoc) > aCentimos(pendiente)) {
        throw badRequest(
          devolucionCliente
            ? `El importe (${importeDoc.toFixed(2).replace('.', ',')} ${simbolo}) supera lo que queda a favor del cliente (${pendiente.toFixed(2).replace('.', ',')} ${simbolo}).`
            : esAbono
              ? `El importe (${importeDoc.toFixed(2)} ${simbolo}) supera lo que queda a tu favor en el abono (${pendiente.toFixed(2)} ${simbolo}).`
              : `El importe (${importeDoc.toFixed(2)} ${simbolo}) supera lo pendiente de la factura (${pendiente.toFixed(2)} ${simbolo}).`,
          devolucionCliente ? { codigo: 'DEVOLUCION_EXCEDE', campo: 'importe' } : undefined,
        );
      }
      // Lo que queda a favor del cliente, en la moneda de cuenta (al tipo de la factura).
      const aFavorCuenta =
        aFavor === null ? null : aCentimos(actual.totalDoc) === aCentimos(actual.totalFactura) ? aFavor : round2((aFavor * actual.totalFactura) / actual.totalDoc);

      // La devolucion de un abono de proveedor son los apuntes de un cobro (banco
      // al debe, proveedor al haber); la de un abono de venta, los de un pago
      // (cliente al debe, banco al haber).
      const calculo = calcularCobroDivisa({
        tipo: devolucionCliente ? 'GASTO' : esAbono ? 'INGRESO' : tipo,
        moneda,
        monedaCuenta,
        monedaTesoreria: tesoreria.moneda ?? monedaCuenta,
        totalCuenta: aFavorCuenta ?? s * actual.totalFactura,
        totalDoc: aFavor ?? s * actual.totalDoc,
        cobradoCuenta: aFavor === null ? s * cobrado.cuenta : 0,
        cobradoDoc: aFavor === null ? s * cobrado.doc : 0,
        importeDoc,
        importeRecibido: hay(datos.importeRecibido) ? Number(datos.importeRecibido) : null,
        tipoCambio: delDia?.tipoCambio ?? null,
        fuenteTipoCambio: delDia?.fuente ?? null,
        comisionBancaria: hay(datos.comisionBancaria) ? Number(datos.comisionBancaria) : null,
      });
      if (calculo.fuenteTipoCambio === 'BANCO') {
        comprobarTipoManual(calculo.tipoCambio, refRecibido?.tipoCambio ?? null, monedaCuenta, moneda, {
          aproximado: refRecibido?.aproximado,
          origen: 'banco',
        });
      }

      const divisa = enDivisa
        ? ` [${importeConMoneda(calculo.importeDoc, moneda)}; ${textoTipo(monedaCuenta, moneda, calculo.tipoCambio)}]`
        : '';
      const descripcion = `${t.Cobro} ${esAbono ? 'del abono' : 'factura'} ${numero} - ${actual.tercero}${divisa}${nota ? ` (${nota})` : ''}`;
      // La subcuenta del tercero que uso la factura (o la suya, si aun no tiene asiento).
      const tercero = await cuentaTerceroDeFactura(tx, companyId, tipo, invoiceId);
      if (tesoreria.altaEnPlan) await asegurarSubcuentaBancoEnPlan(tx, companyId, tesoreria.cuenta, tesoreria.altaEnPlan);
      const apuntes = apuntesDeCobro(calculo.apuntes, {
        tesoreria: { cuenta: tesoreria.cuenta, nombre: tesoreria.nombre },
        tercero: { cuenta: tercero.codigo, nombre: tercero.nombre },
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
          // La devolucion de un abono se guarda en negativo (el signo de la factura): total - aplicado sigue dando lo pendiente.
          importe: s * calculo.importe,
          moneda,
          importeDoc: s * calculo.importeDoc,
          importeTesoreria: s * calculo.importeTesoreria,
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
  const pago = await prisma.invoicePayment.findFirst({ where: { id: cobroId, companyId, invoiceType: tipo, invoiceId } });
  const t = pago && pago.importe < 0 ? textosAbono(tipo) : TXT[tipo];
  if (!pago) throw notFound(`${t.Cobro} no encontrado.`);
  if (pago.estado !== 'ACTIVO') throw badRequest(yaAnulado(t));
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
      if (r.count !== 1) throw badRequest(yaAnulado(t));
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
  // Gastos: pagos, devoluciones de abonos y compensaciones (lo aplicado).
  if (tipo === 'GASTO') return aplicadoPorFactura(companyId, undefined, hasta);
  const filas = await prisma.invoicePayment.groupBy({
    by: ['invoiceId'],
    where: { companyId, invoiceType: tipo, estado: 'ACTIVO', ...(hasta ? { fecha: { lte: hasta } } : {}) },
    _sum: { importe: true },
  });
  return new Map(filas.map((r) => [r.invoiceId, round2(Number(r._sum.importe ?? 0))]));
}

/**
 * Lo aplicado a cada factura de GASTO (con fecha <= hasta): pagos activos
 * (las devoluciones de un abono van en negativo, con el signo de la factura)
 * mas las compensaciones activas, en positivo en la factura que recibe el
 * abono y en negativo en el abono que se aplica. Pendiente = total - aplicado,
 * con signo: en un abono de -121 aplicado entero, -121 - (-121) = 0.
 */
export async function aplicadoPorFactura(companyId: string, ids?: string[], hasta?: string, db: Tx | typeof prisma = prisma): Promise<Map<string, number>> {
  if (ids && !ids.length) return new Map();
  const fecha = hasta ? { fecha: { lte: hasta } } : {};
  const [pagos, recibidas, aplicadas] = await Promise.all([
    db.invoicePayment.groupBy({
      by: ['invoiceId'],
      where: { companyId, invoiceType: 'GASTO', estado: 'ACTIVO', ...fecha, ...(ids ? { invoiceId: { in: ids } } : {}) },
      _sum: { importe: true },
    }),
    db.compensacionGasto.groupBy({
      by: ['facturaId'],
      where: { companyId, estado: 'ACTIVO', ...fecha, ...(ids ? { facturaId: { in: ids } } : { facturaId: { not: null } }) },
      _sum: { importe: true },
    }),
    db.compensacionGasto.groupBy({
      by: ['abonoId'],
      where: { companyId, estado: 'ACTIVO', ...fecha, ...(ids ? { abonoId: { in: ids } } : {}) },
      _sum: { importe: true },
    }),
  ]);
  const c = new Map<string, number>();
  const sumar = (id: string | null, euros: unknown, signo: 1 | -1) => {
    if (!id) return;
    c.set(id, (c.get(id) ?? 0) + signo * aCentimos(Number(euros ?? 0)));
  };
  for (const p of pagos) sumar(p.invoiceId, p._sum.importe, 1);
  for (const r of recibidas) sumar(r.facturaId, r._sum.importe, 1);
  for (const a of aplicadas) sumar(a.abonoId, a._sum.importe, -1);
  return new Map([...c].map(([id, cent]) => [id, cent / 100]));
}

/** Suma de los cobros/pagos activos con fecha entre `desde` y `hasta` (ambas incluidas). */
export async function totalCobradoEntre(companyId: string, tipo: TipoDocumento, desde: string, hasta: string, invoiceIds?: string[]): Promise<number> {
  const r = await prisma.invoicePayment.aggregate({
    // Con invoiceIds, solo los cobros o pagos de esas facturas (las de un cliente o un proveedor).
    // Sin las devoluciones de abonos (importe < 0): no son pagos a proveedores.
    where: { companyId, invoiceType: tipo, estado: 'ACTIVO', importe: { gt: 0 }, fecha: { gte: desde, lte: hasta }, ...(invoiceIds ? { invoiceId: { in: invoiceIds } } : {}) },
    _sum: { importe: true },
  });
  return round2(Number(r._sum.importe ?? 0));
}

/** Hay cobros activos en la factura (para no "desmarcar" una factura cobrada con asientos). */
export async function tieneCobrosActivos(companyId: string, tipo: TipoDocumento, invoiceId: string): Promise<boolean> {
  return (await prisma.invoicePayment.count({ where: { companyId, invoiceType: tipo, invoiceId, estado: 'ACTIVO' } })) > 0;
}
