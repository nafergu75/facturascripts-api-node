/**
 * Facturas de 2026 pendientes de cobro o de pago a 31-12 (partidas
 * pendientes de «Traer la contabilidad de 2026»).
 *
 * Su saldo ya esta en la apertura del 1-1-2027: no generan asiento ni IVA.
 * Cuando se cobran o se pagan en 2027, el asiento va de tesoreria (572 o 570)
 * contra la subcuenta de la partida (430, 400 o 410 del tercero), con la
 * comision del banco a la 626 si la hay. La liquidacion se guarda en
 * InvoicePayment con invoiceType 'PARTIDA' (invoiceId = id de la partida),
 * y el asiento lleva invoiceType 'PARTIDA' con el mismo id.
 *
 * Una partida de importe negativo (anticipo de un cliente, abono de un
 * proveedor pendiente de aplicar) se liquida con importes negativos: el
 * asiento sale con las columnas al reves.
 *
 * Por ahora solo en euros: una partida en otra moneda no se liquida desde
 * aqui (no hay su contravalor a 31-12 para calcular la diferencia de cambio).
 */
import { prisma, type TransaccionBD } from '../../config/database';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { aCentimos, importeTexto } from '../../utils/money';
import { hoyEspana } from '../../utils/fechas';
import { conReintento } from '../../utils/reintento';
import { registrarAuditoria } from '../auditoria.service';
import { asegurarPlanContableEmpresa } from '../chart-of-accounts.service';
import { comprobarFechaAbierta, exigirFechaContabilizable } from '../periodos.service';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const CUENTA_CAJA = '570';
const CUENTA_COMISION = '626';

export type TipoPartida = 'COBRO' | 'PAGO';
export type EstadoPartida = 'PENDIENTE' | 'PARCIAL' | 'LIQUIDADA' | 'ANULADA';

const TXT = {
  COBRO: { cobro: 'cobro', Cobro: 'Cobro', prefijo: 'COBRO', cobrada: 'cobrada' },
  PAGO: { cobro: 'pago', Cobro: 'Pago', prefijo: 'PAGO', cobrada: 'pagada' },
} as const;

export interface LiquidacionVista {
  id: string;
  fecha: string;
  importe: number;
  comision: number;
  cuentaTesoreria: string;
  estado: 'ACTIVO' | 'ANULADO';
  asiento: string | null;
  nota: string | null;
}

export interface PartidaVista {
  id: string;
  tipo: TipoPartida;
  subcuenta: string;
  tercero: string;
  customerId: string | null;
  supplierId: string | null;
  incomeInvoiceId: string | null;
  expenseInvoiceId: string | null;
  numeroDocumento: string;
  fechaDocumento: string | null;
  fechaVencimiento: string | null;
  importeOriginal: number | null;
  /** Pendiente a 31-12 (lo que vino de la gestoria). */
  importeInicial: number;
  /** Cobrado o pagado en el ejercicio (liquidaciones activas y abonos del proveedor aplicados). */
  liquidado: number;
  /** De lo liquidado, lo que se ha descontado con abonos del proveedor (sin movimiento de dinero). */
  compensado: number;
  /** Lo que queda. */
  pendiente: number;
  moneda: string;
  sinDetalle: boolean;
  estado: EstadoPartida;
  vencida: boolean;
}

type Db = TransaccionBD | typeof prisma;
type FilaPartida = Awaited<ReturnType<typeof prisma.partidaPendiente.findFirstOrThrow>>;

/** Estado a partir de lo liquidado (con el signo de la partida). */
export function estadoPartida(inicial: number, liquidado: number): EstadoPartida {
  if (aCentimos(liquidado) === 0) return 'PENDIENTE';
  return Math.abs(aCentimos(liquidado)) >= Math.abs(aCentimos(inicial)) ? 'LIQUIDADA' : 'PARCIAL';
}

/**
 * Apuntes de la liquidacion de una partida (funcion pura). Importe y comision
 * con el signo de la partida; un apunte negativo pasa a la otra columna.
 *  - Cobro: tesoreria al debe (importe - comision), 626 al debe, tercero al haber.
 *  - Pago: tercero al debe, 626 al debe, tesoreria al haber (importe + comision).
 */
export function apuntesLiquidacion(
  tipo: TipoPartida,
  importe: number,
  comision: number,
  cuentas: { tesoreria: { cuenta: string; nombre: string }; tercero: { cuenta: string; nombre: string } },
): Array<{ cuenta: string; nombre: string; debe: number; haber: number }> {
  const brutos: Array<{ cuenta: string; nombre: string; saldo: number }> =
    tipo === 'COBRO'
      ? [
          { ...cuentas.tesoreria, saldo: r2(importe - comision) },
          { cuenta: CUENTA_COMISION, nombre: 'Servicios bancarios y similares', saldo: comision },
          { ...cuentas.tercero, saldo: -importe },
        ]
      : [
          { ...cuentas.tercero, saldo: importe },
          { cuenta: CUENTA_COMISION, nombre: 'Servicios bancarios y similares', saldo: comision },
          { ...cuentas.tesoreria, saldo: r2(-(importe + comision)) },
        ];
  return brutos
    .filter((b) => aCentimos(b.saldo) !== 0)
    .map((b) => ({ cuenta: b.cuenta, nombre: b.nombre, debe: b.saldo > 0 ? r2(b.saldo) : 0, haber: b.saldo < 0 ? r2(-b.saldo) : 0 }));
}

/** Numero de factura para casar el de una partida con el que se escribio en un abono: sin espacios y en mayusculas. */
export const numeroComparable = (n: string | null | undefined): string => (n ?? '').replace(/\s+/g, '').toUpperCase();

type FilaEnlace = { id: string; tipo: string; supplierId: string | null; expenseInvoiceId: string | null; numeroDocumento: string; cargaId: string };

/** Primer dia del ejercicio de destino de cada carga (lo de antes ya esta en lo pendiente a 31-12). */
async function aperturaPorCarga(db: Db, companyId: string, cargaIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(cargaIds)];
  const cargas = ids.length ? await db.cargaArranque.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, ejercicio: true } }) : [];
  return new Map(cargas.map((c) => [c.id, `${c.ejercicio}-01-01`]));
}

/**
 * Lo aplicado con abonos de proveedor a cada partida de pago: compensaciones
 * activas con fecha desde la apertura (las de antes ya estan en lo pendiente
 * que dio la gestoria).
 *  - Las que recibe la factura de la app enlazada a la partida, en positivo.
 *  - Las de un abono aplicado a una factura «de fuera de la app» del mismo
 *    proveedor con el numero de la partida, en positivo.
 *  - Si la factura enlazada es un abono, las suyas aplicadas a otras, en negativo.
 * Asi un abono de 2027 sobre una factura de 2026 rebaja una sola vez lo que
 * queda por pagar de esa factura.
 */
async function compensadoPorPartida(db: Db, companyId: string, filas: FilaEnlace[]): Promise<Map<string, number>> {
  const pagos = filas.filter((f) => f.tipo === 'PAGO');
  const out = new Map<string, number>();
  if (!pagos.length) return out;
  const apertura = await aperturaPorCarga(db, companyId, pagos.map((f) => f.cargaId));
  const desde = [...apertura.values()].sort()[0] ?? '0000-01-01';
  const enlazadas = pagos.map((f) => f.expenseInvoiceId).filter((x): x is string => !!x);
  const proveedores = [...new Set(pagos.filter((f) => !f.expenseInvoiceId).map((f) => f.supplierId).filter((x): x is string => !!x))];
  const abonosProveedor = proveedores.length
    ? await db.expenseInvoice.findMany({ where: { companyId, supplierId: { in: proveedores }, totalFactura: { lt: 0 } }, select: { id: true, supplierId: true } })
    : [];
  const proveedorDeAbono = new Map(abonosProveedor.map((a) => [a.id, a.supplierId]));
  const condiciones = [
    ...(enlazadas.length ? [{ facturaId: { in: enlazadas } }, { abonoId: { in: enlazadas } }] : []),
    ...(abonosProveedor.length ? [{ facturaId: null, abonoId: { in: abonosProveedor.map((a) => a.id) } }] : []),
  ];
  if (!condiciones.length) return out;
  const cs = await db.compensacionGasto.findMany({
    where: { companyId, estado: 'ACTIVO', fecha: { gte: desde }, OR: condiciones },
    select: { abonoId: true, facturaId: true, numeroFuera: true, fecha: true, importe: true },
  });
  for (const f of pagos) {
    const inicio = apertura.get(f.cargaId) ?? desde;
    let cent = 0;
    for (const c of cs) {
      if (c.fecha < inicio) continue;
      const importe = aCentimos(Number(c.importe));
      if (f.expenseInvoiceId) {
        if (c.facturaId === f.expenseInvoiceId) cent += importe;
        else if (c.abonoId === f.expenseInvoiceId) cent -= importe;
      } else if (!c.facturaId && f.supplierId && proveedorDeAbono.get(c.abonoId) === f.supplierId && numeroComparable(c.numeroFuera) === numeroComparable(f.numeroDocumento)) {
        cent += importe;
      }
    }
    if (cent) out.set(f.id, cent / 100);
  }
  return out;
}

/** Lo aplicado con abonos de proveedor a cada partida (parte de lo liquidado). */
async function soloCompensado(db: Db, companyId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const enlace = await db.partidaPendiente.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, tipo: true, supplierId: true, expenseInvoiceId: true, numeroDocumento: true, cargaId: true } });
  return compensadoPorPartida(db, companyId, enlace);
}

/** Cobrado o pagado de cada partida: sus liquidaciones activas mas lo aplicado con abonos de proveedor. */
async function liquidadoPorPartida(db: Db, companyId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const [filas, compensado] = await Promise.all([
    db.invoicePayment.groupBy({
      by: ['invoiceId'],
      where: { companyId, invoiceType: 'PARTIDA', estado: 'ACTIVO', invoiceId: { in: ids } },
      _sum: { importe: true },
    }),
    soloCompensado(db, companyId, ids),
  ]);
  const out = new Map(filas.map((f) => [f.invoiceId, r2(Number(f._sum.importe ?? 0))]));
  for (const [id, euros] of compensado) out.set(id, r2((out.get(id) ?? 0) + euros));
  return out;
}

/** Lo que queda de cada partida: lo pendiente a 31-12 menos lo liquidado (pagos y abonos aplicados). */
export async function pendientePorPartida(db: Db, companyId: string, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const [filas, liquidado] = await Promise.all([
    db.partidaPendiente.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, importePendiente: true } }),
    liquidadoPorPartida(db, companyId, ids),
  ]);
  return new Map(filas.map((f) => [f.id, r2(Number(f.importePendiente) - (liquidado.get(f.id) ?? 0))]));
}

/**
 * Partidas de pago vivas que recibe una compensacion de abono: la enlazada a
 * cada factura de la app (por su id) y, para una factura de fuera de la app,
 * la del mismo proveedor con ese numero. Se bloquean (FOR UPDATE, en orden de
 * id) para que un pago de la partida a la vez no se cruce con la compensacion.
 */
export async function partidasDeCompensacion(
  tx: TransaccionBD,
  companyId: string,
  q: { facturaIds?: string[]; fuera?: { supplierId: string; numero: string } },
): Promise<Array<{ id: string; expenseInvoiceId: string | null; numeroDocumento: string }>> {
  const ids = (q.facturaIds ?? []).filter(Boolean);
  if (!ids.length && !q.fuera) return [];
  const candidatas = await tx.partidaPendiente.findMany({
    where: {
      companyId,
      tipo: 'PAGO',
      estado: { not: 'ANULADA' },
      OR: [...(ids.length ? [{ expenseInvoiceId: { in: ids } }] : []), ...(q.fuera ? [{ supplierId: q.fuera.supplierId, expenseInvoiceId: null }] : [])],
    },
    select: { id: true, expenseInvoiceId: true, numeroDocumento: true },
  });
  const elegidas = candidatas.filter((p) =>
    p.expenseInvoiceId ? ids.includes(p.expenseInvoiceId) : !!q.fuera && numeroComparable(p.numeroDocumento) === numeroComparable(q.fuera.numero),
  );
  for (const p of [...elegidas].sort((a, b) => (a.id < b.id ? -1 : 1))) await tx.$queryRaw`SELECT id FROM PartidaPendiente WHERE id = ${p.id} FOR UPDATE`;
  return elegidas;
}

/** Vuelve a calcular el estado guardado de unas partidas (tras aplicar o anular un abono). */
export async function recalcularEstadoPartidas(tx: TransaccionBD, companyId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const filas = await tx.partidaPendiente.findMany({ where: { companyId, id: { in: ids }, estado: { not: 'ANULADA' } }, select: { id: true, importePendiente: true, estado: true } });
  const liquidado = await liquidadoPorPartida(tx, companyId, filas.map((f) => f.id));
  for (const f of filas) {
    const estado = estadoPartida(Number(f.importePendiente), liquidado.get(f.id) ?? 0);
    if (estado !== f.estado) await tx.partidaPendiente.update({ where: { id: f.id }, data: { estado } });
  }
}

async function nombresTerceros(companyId: string, filas: FilaPartida[]): Promise<Map<string, string>> {
  const clientes = [...new Set(filas.map((f) => f.customerId).filter((x): x is string => !!x))];
  const proveedores = [...new Set(filas.map((f) => f.supplierId).filter((x): x is string => !!x))];
  const subcuentas = [...new Set(filas.filter((f) => !f.customerId && !f.supplierId).map((f) => f.subcuenta))];
  const [cs, ps, cuentas] = await Promise.all([
    clientes.length ? prisma.customer.findMany({ where: { companyId, id: { in: clientes } }, select: { id: true, nombreFiscal: true } }) : [],
    proveedores.length ? prisma.supplier.findMany({ where: { companyId, id: { in: proveedores } }, select: { id: true, nombreFiscal: true } }) : [],
    subcuentas.length ? prisma.chartOfAccounts.findMany({ where: { companyId, codigo: { in: subcuentas } }, select: { codigo: true, nombre: true } }) : [],
  ]);
  const m = new Map<string, string>();
  for (const c of cs) m.set(`c:${c.id}`, c.nombreFiscal);
  for (const p of ps) m.set(`p:${p.id}`, p.nombreFiscal);
  for (const k of cuentas) m.set(`s:${k.codigo}`, k.nombre);
  return m;
}

function aVista(f: FilaPartida, liquidado: number, nombres: Map<string, string>, hoy: string, compensado = 0): PartidaVista {
  const inicial = Number(f.importePendiente);
  const pendiente = f.estado === 'ANULADA' ? 0 : r2(inicial - liquidado);
  const tercero = (f.customerId && nombres.get(`c:${f.customerId}`)) || (f.supplierId && nombres.get(`p:${f.supplierId}`)) || nombres.get(`s:${f.subcuenta}`) || f.subcuenta;
  return {
    id: f.id,
    tipo: f.tipo as TipoPartida,
    subcuenta: f.subcuenta,
    tercero,
    customerId: f.customerId,
    supplierId: f.supplierId,
    incomeInvoiceId: f.incomeInvoiceId,
    expenseInvoiceId: f.expenseInvoiceId,
    numeroDocumento: f.numeroDocumento,
    fechaDocumento: f.fechaDocumento,
    fechaVencimiento: f.fechaVencimiento,
    importeOriginal: f.importeOriginal === null ? null : Number(f.importeOriginal),
    importeInicial: inicial,
    liquidado,
    compensado,
    pendiente,
    moneda: f.moneda,
    sinDetalle: f.sinDetalle,
    estado: f.estado as EstadoPartida,
    vencida: aCentimos(pendiente) !== 0 && !!f.fechaVencimiento && f.fechaVencimiento < hoy,
  };
}

export interface FiltrosPartidas {
  tipos: TipoPartida[];
  estado?: unknown;
  tercero?: unknown;
  q?: unknown;
}

/**
 * Lista de partidas (las anuladas no salen salvo que se pidan). `tercero` es el
 * id de un cliente o proveedor, o una subcuenta.
 */
export async function listarPartidas(companyId: string, f: FiltrosPartidas) {
  const estados = ['PENDIENTE', 'PARCIAL', 'LIQUIDADA', 'ANULADA'];
  const estado = typeof f.estado === 'string' && f.estado ? f.estado.toUpperCase() : null;
  if (estado && estado !== 'ABIERTAS' && !estados.includes(estado)) throw badRequest('El estado tiene que ser PENDIENTE, PARCIAL, LIQUIDADA, ANULADA o ABIERTAS.');
  const tercero = typeof f.tercero === 'string' && f.tercero.trim() ? f.tercero.trim() : null;
  const q = typeof f.q === 'string' && f.q.trim() ? f.q.trim().slice(0, 60) : null;
  const filas = await prisma.partidaPendiente.findMany({
    where: {
      companyId,
      tipo: { in: f.tipos },
      estado: estado === 'ABIERTAS' ? { in: ['PENDIENTE', 'PARCIAL'] } : estado ? estado : { not: 'ANULADA' },
      ...(tercero ? { OR: [{ customerId: tercero }, { supplierId: tercero }, { subcuenta: tercero }] } : {}),
      ...(q ? { numeroDocumento: { contains: q } } : {}),
    },
    orderBy: [{ fechaVencimiento: 'asc' }, { numeroDocumento: 'asc' }],
    take: 2000,
  });
  const [liquidado, compensado, nombres] = await Promise.all([
    liquidadoPorPartida(prisma, companyId, filas.map((x) => x.id)),
    compensadoPorPartida(prisma, companyId, filas),
    nombresTerceros(companyId, filas),
  ]);
  const hoy = hoyEspana();
  const partidas = filas.map((x) => aVista(x, liquidado.get(x.id) ?? 0, nombres, hoy, compensado.get(x.id) ?? 0));
  const total = (tipo: TipoPartida) => {
    const abiertas = partidas.filter((p) => p.tipo === tipo && (p.estado === 'PENDIENTE' || p.estado === 'PARCIAL'));
    return { abiertas: abiertas.length, pendiente: r2(abiertas.reduce((s, p) => s + p.pendiente, 0)) };
  };
  return { partidas, totales: { cobros: total('COBRO'), pagos: total('PAGO') } };
}

/** Lo pendiente de 2026 por tipo, para los resumenes (Carmen, panel): numero de partidas abiertas e importe. */
export async function resumenPendiente(companyId: string): Promise<{ cobros: { abiertas: number; pendiente: number }; pagos: { abiertas: number; pendiente: number } }> {
  const filas = await prisma.partidaPendiente.findMany({
    where: { companyId, estado: { in: ['PENDIENTE', 'PARCIAL'] } },
    select: { id: true, tipo: true, importePendiente: true },
  });
  const liquidado = await liquidadoPorPartida(prisma, companyId, filas.map((x) => x.id));
  const out = { cobros: { abiertas: 0, pendiente: 0 }, pagos: { abiertas: 0, pendiente: 0 } };
  for (const p of filas) {
    const t = p.tipo === 'COBRO' ? out.cobros : out.pagos;
    t.abiertas += 1;
    t.pendiente = r2(t.pendiente + Number(p.importePendiente) - (liquidado.get(p.id) ?? 0));
  }
  return out;
}

/** Una partida con sus liquidaciones. */
export async function detallePartida(companyId: string, id: string, tipos: TipoPartida[]): Promise<PartidaVista & { liquidaciones: LiquidacionVista[] }> {
  const f = await prisma.partidaPendiente.findFirst({ where: { id, companyId } });
  if (!f || !tipos.includes(f.tipo as TipoPartida)) throw notFound('Factura pendiente no encontrada.');
  const [liquidado, compensado, nombres, pagos] = await Promise.all([
    liquidadoPorPartida(prisma, companyId, [f.id]),
    compensadoPorPartida(prisma, companyId, [f]),
    nombresTerceros(companyId, [f]),
    prisma.invoicePayment.findMany({ where: { companyId, invoiceType: 'PARTIDA', invoiceId: f.id }, orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const asientos = await prisma.journalEntry.findMany({ where: { companyId, id: { in: pagos.map((p) => p.journalEntryId).filter((x): x is string => !!x) } }, select: { id: true, numeroAsiento: true } });
  const numero = new Map(asientos.map((a) => [a.id, a.numeroAsiento]));
  return {
    ...aVista(f, liquidado.get(f.id) ?? 0, nombres, hoyEspana(), compensado.get(f.id) ?? 0),
    liquidaciones: pagos.map((p) => ({
      id: p.id,
      fecha: p.fecha,
      importe: Number(p.importe),
      comision: Number(p.comisionBancaria),
      cuentaTesoreria: p.cuentaTesoreria,
      estado: p.estado as 'ACTIVO' | 'ANULADO',
      asiento: p.journalEntryId ? numero.get(p.journalEntryId) ?? null : null,
      nota: p.nota,
    })),
  };
}

export interface DatosLiquidacion {
  fecha?: unknown;
  /** Con el signo de la partida; sin el, todo lo pendiente. */
  importe?: unknown;
  comision?: unknown;
  cuentaBancariaId?: unknown;
  caja?: unknown;
  nota?: unknown;
}

function numero(v: unknown, campo: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`El ${campo} no es un número.`, { campo });
  return r2(n);
}

async function tesoreriaDe(db: Db, companyId: string, d: { cuentaBancariaId?: unknown; caja?: unknown }, tipo: TipoPartida) {
  if (d.caja === true) return { cuenta: CUENTA_CAJA, bankAccountId: null as string | null, nombre: 'Caja' };
  const id = typeof d.cuentaBancariaId === 'string' && d.cuentaBancariaId ? d.cuentaBancariaId : null;
  const c = id
    ? await db.bankAccount.findFirst({ where: { id, companyId } })
    : await db.bankAccount.findFirst({ where: { companyId, activa: true }, orderBy: { createdAt: 'asc' } });
  if (id && !c) throw badRequest('La cuenta bancaria no existe en esta empresa.', { campo: 'cuentaBancariaId' });
  if (!c) throw badRequest(`No hay ninguna cuenta bancaria activa para apuntar el ${TXT[tipo].cobro}. Créala en Tesorería > Cuentas bancarias, o indica que es en efectivo (caja).`);
  if (!c.activa) throw badRequest('La cuenta bancaria está desactivada.', { campo: 'cuentaBancariaId' });
  if (!c.subcuentaCodigo) throw badRequest('La cuenta bancaria no tiene subcuenta de tesorería (572): ponla en Tesorería > Cuentas bancarias.');
  return { cuenta: c.subcuentaCodigo, bankAccountId: c.id as string | null, nombre: c.bancoNombre || c.iban };
}

async function siguienteNumero(tx: TransaccionBD, companyId: string, prefijo: string): Promise<string> {
  const existentes = await tx.journalEntry.findMany({ where: { companyId, numeroAsiento: { startsWith: `${prefijo}-` } }, select: { numeroAsiento: true } });
  let max = 0;
  for (const e of existentes) {
    const n = Number(e.numeroAsiento.slice(prefijo.length + 1));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefijo}-${String(max + 1).padStart(5, '0')}`;
}

async function asientoTesoreria(
  tx: TransaccionBD,
  companyId: string,
  p: { prefijo: string; fecha: string; descripcion: string; partidaId: string; referencia: string; apuntes: Array<{ cuenta: string; nombre: string; debe: number; haber: number }> },
) {
  const debe = r2(p.apuntes.reduce((s, a) => s + a.debe, 0));
  const haber = r2(p.apuntes.reduce((s, a) => s + a.haber, 0));
  if (aCentimos(debe) !== aCentimos(haber)) throw badRequest(`El asiento no cuadra: Debe ${debe} y Haber ${haber}.`);
  await exigirFechaContabilizable(companyId, p.fecha);
  return tx.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(`${p.fecha}T00:00:00.000Z`),
      numeroAsiento: await siguienteNumero(tx, companyId, p.prefijo),
      descripcion: p.descripcion.slice(0, 190),
      origen: 'TESORERIA',
      estado: 'POSTED',
      invoiceId: p.partidaId,
      invoiceType: 'PARTIDA',
      lineas: { create: p.apuntes.map((a) => ({ accountCode: a.cuenta, accountName: a.nombre.slice(0, 190), debe: a.debe, haber: a.haber, referencia: p.referencia.slice(0, 190), companyId })) },
    },
  });
}

/** Nombre de la subcuenta del tercero en el plan (o el del tercero). */
async function nombreSubcuenta(tx: TransaccionBD, companyId: string, f: FilaPartida): Promise<string> {
  const c = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: f.subcuenta }, select: { nombre: true } });
  return c?.nombre ?? f.subcuenta;
}

async function fechaApertura(companyId: string, cargaId: string): Promise<string> {
  const c = await prisma.cargaArranque.findFirst({ where: { id: cargaId, companyId }, select: { ejercicio: true } });
  return `${c?.ejercicio ?? 2027}-01-01`;
}

/**
 * Cobra o paga (todo o parte) una partida. Opcionalmente desde un movimiento
 * del banco, que queda conciliado (referencia «partida:<id del cobro>»).
 */
export async function liquidarPartida(
  companyId: string,
  partidaId: string,
  datos: DatosLiquidacion,
  userId: string,
  opciones: { tipos?: TipoPartida[]; movimientoId?: string } = {},
): Promise<{ liquidacion: LiquidacionVista; partida: PartidaVista & { liquidaciones: LiquidacionVista[] } }> {
  const f0 = await prisma.partidaPendiente.findFirst({ where: { id: partidaId, companyId } });
  const tipos = opciones.tipos ?? ['COBRO', 'PAGO'];
  if (!f0 || !tipos.includes(f0.tipo as TipoPartida)) throw notFound('Factura pendiente no encontrada.');
  const tipo = f0.tipo as TipoPartida;
  const t = TXT[tipo];
  if (f0.estado === 'ANULADA') throw conflict('Esta factura pendiente está anulada (la carga se repitió o se deshizo).');
  if (f0.moneda !== 'EUR') {
    throw conflict(`Esta factura pendiente está en ${f0.moneda}: por ahora solo se cobran y pagan desde aquí las que están en euros.`, { codigo: 'PARTIDA_EN_DIVISA' });
  }
  const fecha = typeof datos.fecha === 'string' && datos.fecha ? datos.fecha.slice(0, 10) : hoyEspana();
  if (!FECHA_RE.test(fecha) || Number.isNaN(new Date(`${fecha}T00:00:00Z`).getTime())) throw badRequest('La fecha no es válida (AAAA-MM-DD).', { campo: 'fecha' });
  const desde = await fechaApertura(companyId, f0.cargaId);
  if (fecha < desde) throw badRequest(`El ${t.cobro} de una factura de ${Number(desde.slice(0, 4)) - 1} tiene que ir con fecha de ${desde.slice(0, 4)} o posterior.`, { campo: 'fecha' });
  const solicitado = numero(datos.importe, 'importe');
  const comision = numero(datos.comision, 'comisión') ?? 0;
  if (comision < 0) throw badRequest('La comisión no puede ser negativa.', { campo: 'comision' });
  const nota = typeof datos.nota === 'string' && datos.nota.trim() ? datos.nota.trim().slice(0, 1000) : null;
  await comprobarFechaAbierta(companyId, fecha, `apuntar el ${t.cobro}`);
  const tesoreria = await tesoreriaDe(prisma, companyId, datos, tipo);
  if (comision) await asegurarPlanContableEmpresa(companyId);

  const pagoId = await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM PartidaPendiente WHERE id = ${partidaId} FOR UPDATE`;
      const f = await tx.partidaPendiente.findUniqueOrThrow({ where: { id: partidaId } });
      if (f.estado === 'ANULADA') throw conflict('Esta factura pendiente está anulada.');
      const inicial = Number(f.importePendiente);
      const liquidado = (await liquidadoPorPartida(tx, companyId, [f.id])).get(f.id) ?? 0;
      const pendiente = r2(inicial - liquidado);
      if (aCentimos(pendiente) === 0) throw conflict(`La factura ${f.numeroDocumento} ya está ${t.cobrada}: no queda nada pendiente.`);
      const importe = solicitado ?? pendiente;
      if (aCentimos(importe) === 0) throw badRequest('El importe no puede ser cero.', { campo: 'importe' });
      if (Math.sign(importe) !== Math.sign(pendiente)) {
        throw badRequest(
          pendiente > 0 ? 'El importe tiene que ser positivo.' : `Lo pendiente es negativo (${importeTexto(pendiente)}: un anticipo o un abono): el importe también tiene que serlo.`,
          { campo: 'importe' },
        );
      }
      if (Math.abs(aCentimos(importe)) > Math.abs(aCentimos(pendiente))) {
        throw badRequest(`El importe (${importeTexto(importe)}) supera lo pendiente de la factura (${importeTexto(pendiente)}).`, { campo: 'importe' });
      }
      if (comision && aCentimos(comision) >= Math.abs(aCentimos(importe))) throw badRequest('La comisión no puede ser mayor que el importe.', { campo: 'comision' });
      const comisionSigno = r2(comision * Math.sign(importe));

      let movimiento: { id: string; concepto: string } | null = null;
      if (opciones.movimientoId) {
        const m = await tx.bankMovement.findFirst({ where: { id: opciones.movimientoId, companyId } });
        if (!m) throw badRequest('Movimiento bancario no encontrado.');
        const r = await tx.bankMovement.updateMany({ where: { id: m.id, conciliado: false }, data: { conciliado: true } });
        if (r.count !== 1) throw conflict('El movimiento ya está conciliado.');
        movimiento = { id: m.id, concepto: m.concepto };
      }

      const tercero = { cuenta: f.subcuenta, nombre: await nombreSubcuenta(tx, companyId, f) };
      const apuntes = apuntesLiquidacion(tipo, importe, comisionSigno, { tesoreria: { cuenta: tesoreria.cuenta, nombre: tesoreria.nombre }, tercero });
      const asiento = await asientoTesoreria(tx, companyId, {
        prefijo: t.prefijo,
        fecha,
        descripcion: `${t.Cobro} factura ${f.numeroDocumento} de ${Number(desde.slice(0, 4)) - 1} - ${tercero.nombre}${nota ? ` (${nota})` : ''}`,
        partidaId: f.id,
        referencia: f.numeroDocumento,
        apuntes,
      });
      const tesoreriaImporte = tipo === 'COBRO' ? r2(importe - comisionSigno) : r2(importe + comisionSigno);
      const pago = await tx.invoicePayment.create({
        data: {
          companyId,
          invoiceType: 'PARTIDA',
          invoiceId: f.id,
          fecha,
          importe,
          moneda: 'EUR',
          importeDoc: importe,
          importeTesoreria: tesoreriaImporte,
          comisionBancaria: comisionSigno,
          cuentaTesoreria: tesoreria.cuenta,
          bankAccountId: tesoreria.bankAccountId,
          nota: movimiento ? [nota, `Conciliado con el movimiento del banco: ${movimiento.concepto}`].filter(Boolean).join(' · ').slice(0, 1000) : nota,
          journalEntryId: asiento.id,
          createdBy: userId,
        },
      });
      if (movimiento) await tx.bankMovement.update({ where: { id: movimiento.id }, data: { referencia: `partida:${pago.id}` } });
      await tx.partidaPendiente.update({ where: { id: f.id }, data: { estado: estadoPartida(inicial, r2(liquidado + importe)) } });
      return pago.id;
    }),
  );
  await registrarAuditoria({ userId, companyId, action: 'PARTIDA_LIQUIDADA', resourceType: 'PartidaPendiente', resourceId: partidaId, meta: { pagoId, movimientoId: opciones.movimientoId ?? null } });
  const partida = await detallePartida(companyId, partidaId, tipos);
  return { liquidacion: partida.liquidaciones.find((l) => l.id === pagoId)!, partida };
}

/**
 * Anula un cobro o pago de una partida. Con su mes abierto, el asiento pasa a
 * REVERSED; si no, contraasiento con la fecha que se indique (por defecto hoy).
 * Si venia de un movimiento del banco, el movimiento vuelve a estar sin conciliar.
 */
export async function anularLiquidacion(
  companyId: string,
  pagoId: string,
  opciones: { fecha?: unknown; tipos?: TipoPartida[] },
  userId: string,
): Promise<{ partida: PartidaVista & { liquidaciones: LiquidacionVista[] }; contraasiento: boolean }> {
  const pago = await prisma.invoicePayment.findFirst({ where: { id: pagoId, companyId, invoiceType: 'PARTIDA' } });
  if (!pago) throw notFound('Cobro o pago no encontrado.');
  const f = await prisma.partidaPendiente.findFirstOrThrow({ where: { id: pago.invoiceId, companyId } });
  const tipos = opciones.tipos ?? ['COBRO', 'PAGO'];
  if (!tipos.includes(f.tipo as TipoPartida)) throw notFound('Cobro o pago no encontrado.');
  const t = TXT[f.tipo as TipoPartida];
  if (pago.estado !== 'ACTIVO') throw conflict(`El ${t.cobro} ya está anulado.`);

  let abierto = true;
  try {
    await comprobarFechaAbierta(companyId, pago.fecha);
  } catch {
    abierto = false;
  }
  const fechaRaw = typeof opciones.fecha === 'string' && opciones.fecha ? opciones.fecha.slice(0, 10) : hoyEspana();
  if (!abierto && !FECHA_RE.test(fechaRaw)) throw badRequest('La fecha no es válida (AAAA-MM-DD).', { campo: 'fecha' });
  const fechaAnulacion = abierto ? pago.fecha : fechaRaw;
  if (!abierto) await comprobarFechaAbierta(companyId, fechaAnulacion, `anular el ${t.cobro}`);
  const original = pago.journalEntryId ? await prisma.journalEntry.findFirst({ where: { id: pago.journalEntryId, companyId }, include: { lineas: true } }) : null;

  await conReintento(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM PartidaPendiente WHERE id = ${f.id} FOR UPDATE`;
      const r = await tx.invoicePayment.updateMany({ where: { id: pago.id, estado: 'ACTIVO' }, data: { estado: 'ANULADO', anuladoEn: new Date() } });
      if (r.count !== 1) throw conflict(`El ${t.cobro} ya está anulado.`);
      if (original && original.estado !== 'REVERSED') {
        if (abierto) await tx.journalEntry.update({ where: { id: original.id }, data: { estado: 'REVERSED' } });
        else {
          const contra = await asientoTesoreria(tx, companyId, {
            prefijo: t.prefijo,
            fecha: fechaAnulacion,
            descripcion: `Anulación ${t.cobro} factura ${f.numeroDocumento} (${original.numeroAsiento})`,
            partidaId: f.id,
            referencia: `REV-${f.numeroDocumento}`,
            apuntes: original.lineas.map((l) => ({ cuenta: l.accountCode, nombre: l.accountName, debe: Number(l.haber), haber: Number(l.debe) })),
          });
          await tx.invoicePayment.update({ where: { id: pago.id }, data: { anulacionEntryId: contra.id } });
        }
      }
      await tx.bankMovement.updateMany({ where: { companyId, referencia: `partida:${pago.id}` }, data: { conciliado: false, referencia: null } });
      const liquidado = (await liquidadoPorPartida(tx, companyId, [f.id])).get(f.id) ?? 0;
      if (f.estado !== 'ANULADA') await tx.partidaPendiente.update({ where: { id: f.id }, data: { estado: estadoPartida(Number(f.importePendiente), liquidado) } });
    }),
  );
  await registrarAuditoria({ userId, companyId, action: 'PARTIDA_LIQUIDACION_ANULADA', resourceType: 'PartidaPendiente', resourceId: f.id, meta: { pagoId, contraasiento: !abierto } });
  return { partida: await detallePartida(companyId, f.id, tipos), contraasiento: !abierto };
}

/**
 * Concilia un movimiento del banco con una partida: un abono cobra una partida
 * de cobro y un cargo paga una de pago (o devuelve un anticipo, si la partida
 * es negativa). El importe es el del movimiento.
 */
export async function conciliarMovimientoConPartida(companyId: string, movimientoId: string, partidaId: string, userId: string) {
  const m = await prisma.bankMovement.findFirst({ where: { id: movimientoId, companyId } });
  if (!m) throw badRequest('Movimiento bancario no encontrado.');
  if (m.conciliado) throw conflict('El movimiento ya está conciliado.');
  const f = await prisma.partidaPendiente.findFirst({ where: { id: partidaId, companyId } });
  if (!f) throw notFound('Factura pendiente no encontrada.');
  const importeMov = r2(Number(m.importe));
  const entra = importeMov > 0;
  // Cobro positivo o pago de un anticipo: entra dinero. Pago positivo o devolucion de un anticipo: sale.
  const positivo = Number(f.importePendiente) > 0;
  const esperaEntrada = f.tipo === 'COBRO' ? positivo : !positivo;
  if (entra !== esperaEntrada) {
    throw badRequest(
      entra
        ? 'Es un abono (entra dinero): concílialo con una factura pendiente de cobro.'
        : 'Es un cargo (sale dinero): concílialo con una factura pendiente de pago.',
    );
  }
  const importe = positivo ? Math.abs(importeMov) : -Math.abs(importeMov);
  return liquidarPartida(companyId, partidaId, { fecha: m.fecha, importe, cuentaBancariaId: m.cuentaBancariaId }, userId, { movimientoId });
}

/**
 * Partida abierta que esta enlazada a una factura de la app (emitida o
 * recibida en 2026 y que la gestoria tiene pendiente). Su cobro va contra la
 * partida, no contra la factura: asi no se cobra dos veces la misma deuda.
 */
export async function partidaDeFactura(companyId: string, tipo: 'INGRESO' | 'GASTO', invoiceId: string): Promise<{ id: string; numeroDocumento: string } | null> {
  return prisma.partidaPendiente.findFirst({
    where: { companyId, estado: { not: 'ANULADA' }, ...(tipo === 'INGRESO' ? { incomeInvoiceId: invoiceId } : { expenseInvoiceId: invoiceId }) },
    select: { id: true, numeroDocumento: true },
  });
}
