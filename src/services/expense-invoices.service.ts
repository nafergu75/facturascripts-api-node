import { Prisma } from '@prisma/client';
import { prisma, type TransaccionBD } from '../config/database';
import { badRequest, conflict, HttpError, notFound } from '../utils/http-errors';
import { aCentimos } from '../utils/money';
import { hoyEspana, vencimientoPorDefecto } from '../utils/fechas';
import { PGC_BASE } from '../domain/pgc-model';
import {
  ESTADOS_SIN_CONTABILIZAR,
  TIPO_GASTO_INFO,
  cabeceraTipos,
  desgloseRetencionGasto,
  esTipoGasto,
  esVencida,
  fechaContableGasto,
  normalizarNumeroProveedor,
  textoEstadoGasto,
  textoEstadoPago,
  tipoRetencionLibro,
  type TipoGasto,
} from '../domain/factura-gasto.model';
import { esFechaReal, validarFacturaGasto, type FacturaGastoBody } from '../schemas/factura-gasto.schemas';
import { fechaIvaGasto, r2GastoConSigno } from '../domain/rectificativa-gasto.model';
import { contabilizarFacturaGasto, desgloseIvaPorTipo } from './accounting-engine.service';
import { autoliquidacionPorTipo, clasificarCompra } from './impuestosCalculo.service';
import {
  columnasRectificativa,
  comprobarSinRectificativas,
  datosRectificativaDeFicha,
  guardarEnlaces,
  prepararRectificativa,
  type PlanRectificativa,
} from './rectificativasGasto.service';
import { asegurarPlanContableEmpresa } from './chart-of-accounts.service';
import { aplicadoPorFactura, tieneCobrosActivos } from './cobrosPagos.service';
import { anularCompensacionesAuto, comprobarCompensaciones, compensacionesDe, crearCompensacionesAuto, type CompensacionResp } from './compensacionesGasto.service';
import { comprobarFechaAbierta, periodoNoAbierto } from './periodos.service';
import { archivarGastoSinRomper } from './archivoFacturas.service';
import { perfilEmpresa } from './perfilEmpresa.service';
import { registrarAuditoria } from './auditoria.service';
import { datosProveedor, type DatosProveedor } from './proveedores.service';
import { logCreate } from './suppliers/supplierAudit.service';
import { asignarSubcuentasProveedor, conReintentoSubcuenta, crearProveedorConSubcuenta, INDICES_SUBCUENTA, subcuentaProveedorParaApunte } from './terceros/subcuentas';
import { esSubcuentaGenerica } from './terceros/numeracion';
import { nombresDeCuentas, problemaCuentasLinea } from './cuentasLinea.service';
import { logger } from '../config/logger';

/**
 * DTOs para creación y manipulación de facturas de gasto
 */

export interface CrearProveedorNuevoDTO {
  nombreFiscal: string;
  nifCif: string;
  direccion?: string;
  pais?: string;
  provincia?: string;
  municipio?: string;
  cp?: string;
  email?: string;
  telefono?: string;
}

export interface CrearLineaGastoDTO {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  tipoIva?: number; // 0, 4, 10, 21
  descuentoPorcentaje?: number;
  tipoRetencion?: number; // IRPF: 0, 7, 15, 19
  /**
   * Cuota fijada (interno, nunca llega del cliente): las lineas de diferencia
   * de una rectificativa por sustitucion llevan la cuota calculada por tipo con
   * los totales de las dos facturas, no la que sale de su base.
   */
  ivaFijado?: number;
}

export interface CrearFacturaGastoDTO {
  companyId: string;
  provider: { id?: string; nuevo?: CrearProveedorNuevoDTO };
  serie: string;
  numero?: number;
  fechaEmision?: string; // YYYY-MM-DD
  fechaVencimiento?: string;
  tipoGasto?: string; // COMPRA, SERVICIO_PROFESIONAL, ALQUILER, SUMINISTROS
  lineas?: CrearLineaGastoDTO[];
  observaciones?: string;
  /** Numero que puso el proveedor (opcional en este camino interno). */
  numeroFacturaProveedor?: string;
  fechaRegistro?: string;
  // Legacy fields (para compatibilidad con OCR/extractores)
  baseAmount?: number;
  base?: number;
  ivaPercentage?: number;
  iva?: number;
  description?: string;
  concepto?: string;
}

export interface ExpenseInvoiceResp {
  id: string;
  companyId: string;
  supplierId: string;
  serie: string;
  numero: number;
  numeroCompleto: string;
  fechaEmision: string;
  fechaVencimiento: string;
  estado: string;
  /** Estado de pago: PENDIENTE | PARCIAL | PAGADA (ver cobrosPagos.service). */
  estadoPago: string;
  supplier?: { id: string; nombreFiscal: string; nifCif: string };
  tipoGasto: string;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  observaciones?: string;
  createdAt: Date;
  updatedAt: Date;
  lineas: Array<{
    id: string;
    descripcion: string;
    cantidad: number;
    precioUnitario: number;
    baseLine: number;
    descuentoPorcentaje: number;
    descuentoImporte: number;
    tipoIva: number;
    ivaImporte: number;
    tipoRetencion: number;
    retencionImporte: number;
  }>;
}

/** Ficha completa de una factura de gasto (GET /:id y respuesta de alta, edicion y estado). */
export interface GastoDetalle extends ExpenseInvoiceResp {
  numeroFacturaProveedor: string | null;
  fechaRegistro: string | null;
  estadoTexto: string;
  estadoPagoTexto: string;
  vencida: boolean;
  tipoGastoTexto: string;
  /** La cuenta de gasto de las lineas si todas tienen la misma. */
  cuentaGasto: string | null;
  tipoIva: number;
  tipoRetencion: number;
  importePagado: number;
  importePendiente: number;
  monedaCuenta: string;
  supplier: { id: string; nombreFiscal: string; nifCif: string; pais: string };
  lineas: Array<ExpenseInvoiceResp['lineas'][number] & { accountCode: string | null }>;
  asiento: { id: string; numeroAsiento: string; estado: string; fecha: string } | null;
  anulacion: { fecha: string; motivo: string; contraasientoId: string | null } | null;
  acciones: {
    editar: { permitido: boolean; motivo?: string };
    anular: { permitido: boolean; motivo?: string; conContraasiento: boolean };
    /** Factura anterior sin contabilizar y sin asiento: se contabiliza con el boton. */
    contabilizar: boolean;
  };
  /** Abono o rectificativa de proveedor (importes con signo). */
  esRectificativa: boolean;
  /** En una rectificativa: que rectifica, tipo, causa y donde va su IVA. */
  rectificativa: Awaited<ReturnType<typeof datosRectificativaDeFicha>>['rectificativa'];
  /** En una original: sus rectificativas vigentes. */
  rectificativas: Awaited<ReturnType<typeof datosRectificativaDeFicha>>['rectificativas'];
  /** La original, si es una sola de la app (como en ventas). */
  facturaOriginalId: string | null;
  /** Avisos del alta o la correccion que no la impiden. */
  avisos?: string[];
  /** Aplicaciones del abono a otras facturas, o de abonos a esta factura. */
  compensaciones: CompensacionResp[];
  /** Pendiente con signo (total - pagos - compensaciones): en un abono, lo que queda a tu favor en negativo. */
  pendiente: number;
  /** Solo en los abonos: lo que queda a favor de la empresa (en positivo). */
  aFavor?: number;
}

export interface FiltrosGastos {
  page?: unknown;
  limit?: unknown;
  q?: unknown;
  estado?: unknown;
  pago?: unknown;
  /** facturas | abonos (abonos y rectificativas). */
  tipo?: unknown;
  supplierId?: unknown;
  desde?: unknown;
  hasta?: unknown;
}

export interface ListadoGastos {
  items: Array<{
    id: string;
    numeroCompleto: string;
    numeroFacturaProveedor: string | null;
    fechaEmision: string;
    fechaRegistro: string | null;
    fechaVencimiento: string;
    supplier: { id: string; nombreFiscal: string; nifCif: string };
    supplierNombre: string;
    tipoGasto: string;
    tipoGastoTexto: string;
    estado: string;
    estadoTexto: string;
    estadoPago: string;
    estadoPagoTexto: string;
    vencida: boolean;
    baseTotal: number;
    ivaTotal: number;
    retencionTotal: number;
    totalFactura: number;
    importePendiente: number;
    esRectificativa: boolean;
    /** Abono (total < 0). */
    esAbono: boolean;
  }>;
  total: number;
  page: number;
  limit: number;
  paginas: number;
  contadores: {
    todas: number;
    sinContabilizar: number;
    pendientesRevision: number;
    contabilizadas: number;
    anuladas: number;
    pendientesPago: number;
    vencidas: number;
    /** Abonos con algo a favor de la empresa. */
    abonosAFavor: number;
  };
  totales: {
    base: number;
    iva: number;
    retencion: number;
    total: number;
    /** Pendiente de pago de las facturas (sin los abonos). */
    pendiente: number;
    /** Suma de lo que queda a favor en los abonos (en positivo). */
    aFavor: number;
  };
  monedaCuenta: string;
}

/**
 * Redondea a 2 decimales (como round2 en income-invoices).
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Resuelve el proveedor:
 * - Si hay provider.id, verifica que existe y pertenece a esta empresa.
 * - Si hay provider.nuevo, crea un proveedor nuevo.
 */
async function resolverProveedor(
  companyId: string,
  providerData: CrearFacturaGastoDTO['provider'],
): Promise<string> {
  if (providerData.id) {
    // Verificar que existe y pertenece a esta empresa (MULTITENANCY)
    const exists = await prisma.supplier.findFirst({
      where: { id: providerData.id, companyId },
    });
    if (!exists) throw badRequest('Proveedor no encontrado.');
    return providerData.id;
  }

  // Crear proveedor nuevo
  if (!providerData.nuevo?.nombreFiscal || !providerData.nuevo?.nifCif) {
    throw badRequest('Indica provider.id o provider.nuevo con nombreFiscal y nifCif.');
  }

  const p = providerData.nuevo;
  // Con sus subcuentas 400N y 410N asignadas en la misma transaccion que el alta.
  const supplier = await crearProveedorConSubcuenta({
    companyId,
    nombreFiscal: p.nombreFiscal,
    nifCif: p.nifCif,
    direccion: p.direccion,
    pais: p.pais || 'ES',
    provincia: p.provincia,
    municipio: p.municipio,
    cp: p.cp,
    email: p.email,
    telefono: p.telefono,
  });

  return supplier.id;
}

/** Proveedor nuevo dentro de la transaccion de la factura, con sus subcuentas 400N y 410N asignadas. */
async function crearProveedorEnTx(tx: TransaccionBD, companyId: string, nuevo: DatosProveedor): Promise<ProveedorBasico> {
  const s = await tx.supplier.create({ data: { companyId, ...nuevo } as Prisma.SupplierUncheckedCreateInput });
  await asignarSubcuentasProveedor(tx, companyId, s);
  return s;
}

/**
 * Resuelve el siguiente número de factura para una serie (gasto).
 */
async function resolverNumeroFactura(companyId: string, serie: string, numeroSugerido?: number): Promise<number> {
  if (numeroSugerido) {
    const exists = await prisma.expenseInvoice.findFirst({
      where: { companyId, serie, numero: numeroSugerido },
    });
    if (exists) throw badRequest(`Factura de gasto ${serie}-${numeroSugerido} ya existe.`);
    return numeroSugerido;
  }

  const ultima = await prisma.expenseInvoice.findFirst({
    where: { companyId, serie },
    orderBy: { numero: 'desc' },
  });

  return (ultima?.numero ?? 0) + 1;
}

/**
 * Calcula totales a partir de las líneas de gasto. Redondeo por linea con
 * r2GastoConSigno: el de siempre en positivo y, en las lineas en negativo de
 * un abono, el espejo exacto (-10,125 da -10,13, como 10,125 da 10,13).
 */
export function calcularTotales(lineas: CrearLineaGastoDTO[]): {
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  lineasConTotales: Array<CrearLineaGastoDTO & { baseLine: number; ivaImporte: number; retencionImporte: number; descuentoImporte: number }>;
} {
  let baseTotal = 0;
  let ivaTotal = 0;
  let retencionTotal = 0;

  const lineasConTotales = lineas.map((l) => {
    const tipoIva = l.tipoIva ?? 21;
    const tipoRetencion = l.tipoRetencion ?? 0;
    const descuentoPorcentaje = l.descuentoPorcentaje ?? 0;

    const pvpSinDescuento = r2GastoConSigno(l.cantidad * l.precioUnitario);
    const descuentoImporte = r2GastoConSigno((pvpSinDescuento * descuentoPorcentaje) / 100);
    const baseLine = r2GastoConSigno(pvpSinDescuento - descuentoImporte);

    const ivaImporte = l.ivaFijado !== undefined ? r2GastoConSigno(l.ivaFijado) : r2GastoConSigno((baseLine * tipoIva) / 100);
    const retencionImporte = r2GastoConSigno((baseLine * tipoRetencion) / 100);

    baseTotal = round2(baseTotal + baseLine);
    ivaTotal = round2(ivaTotal + ivaImporte);
    retencionTotal = round2(retencionTotal + retencionImporte);

    return {
      ...l,
      baseLine,
      ivaImporte,
      retencionImporte,
      descuentoImporte,
    };
  });

  const totalFactura = round2(baseTotal + ivaTotal - retencionTotal);

  return {
    baseTotal,
    ivaTotal,
    retencionTotal,
    totalFactura,
    lineasConTotales,
  };
}

/**
 * Determina el estado de una factura de gasto según su fecha de vencimiento.
 */
function determinarEstado(fechaVencimiento: string): string {
  const hoy = new Date().toISOString().slice(0, 10);
  return fechaVencimiento < hoy ? 'OVERDUE' : 'PENDING';
}

/** Fecha de la factura (hoy si no viene) y vencimiento (por defecto, 30 dias despues). */
function resolverFechasGasto(dto: { fechaEmision?: string; fechaVencimiento?: string }): { fechaEmision: string; fechaVencimiento: string } {
    // 3) Resolver fechas
    const fechaEmision = (dto.fechaEmision ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    // Mismo plazo por defecto que las facturas de venta (en UTC: sin saltos de dia).
    const fechaVencimiento = (dto.fechaVencimiento ?? vencimientoPorDefecto(fechaEmision)).slice(0, 10);
    return { fechaEmision, fechaVencimiento };
}

// ---------------------------------------------------------------------------
// Ayudas del alta, la edicion y la anulacion
// ---------------------------------------------------------------------------

const OPCIONES_TX = { timeout: 60_000, maxWait: 15_000 };

/** Linea guardada (los importes se leen como number: ver config/decimales.ts). */
interface LineaGuardada {
  id: string;
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  baseLine: number;
  descuentoPorcentaje: number;
  descuentoImporte: number;
  tipoIva: number;
  ivaImporte: number;
  tipoRetencion: number;
  retencionImporte: number;
  accountCode: string | null;
}
/** Lo que el asiento necesita de una factura guardada. */
interface FacturaConLineas {
  numeroCompleto: string;
  numeroFacturaProveedor: string | null;
  fechaEmision: string;
  fechaRegistro: string | null;
  tipoGasto: string;
  tipoIva: number;
  tipoRetencion: number;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  lineas: LineaGuardada[];
}
type ProveedorBasico = { id: string; nombreFiscal: string; nifCif: string; pais: string };

/** Error P2002 (indice unico) cuyo indice menciona `campo`. */
function esDuplicado(e: unknown, campo: string): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  return String((e.meta as { target?: unknown } | undefined)?.target ?? '').includes(campo);
}

const ddmmaaaa = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/** Asiento vigente de la factura (el ultimo de origen FACTURA_GASTO que no esta REVERSED, sin el contraasiento). */
async function asientoVigente(db: TransaccionBD | typeof prisma, companyId: string, invoiceId: string, excluir?: string | null) {
  return db.journalEntry.findFirst({
    where: { companyId, invoiceId, origen: 'FACTURA_GASTO', estado: { not: 'REVERSED' }, ...(excluir ? { id: { not: excluir } } : {}) },
    orderBy: { createdAt: 'desc' },
  });
}

/** Retencion de la factura para buscar el modelo presentado: 111 (profesionales) o 115 (alquileres). */
export const retencionDe = (f: { retencionTotal: number; tipoGasto: string }) =>
  aCentimos(Number(f.retencionTotal) || 0) !== 0 ? tipoRetencionLibro(f.tipoGasto) : null;

/** Por que no se puede tocar una factura de gasto en una fecha (bloqueoPeriodoGasto). */
export interface BloqueoPeriodo {
  /** «El 303 del 1T de 2027 ya está presentado», «El periodo de 03/2026 está bloqueado»... */
  motivo: string;
  /** El modelo presentado; null si el mes esta bloqueado o el ejercicio cerrado. */
  modelo: '303' | '111' | '115' | null;
  ejercicio: number;
  /** Periodo del modelo presentado ('1T' o '04'); null si es un periodo cerrado. */
  periodo: string | null;
}

/**
 * null si se puede tocar la contabilidad de esa fecha; si no, por que: el mes
 * o el ejercicio estan cerrados (comprobarFechaAbierta, con la fecha contable),
 * el 111/115 del periodo de la fecha contable esta presentado (si hay
 * retencion) o lo esta el 303 del periodo de `fechaIva`. `fechaIva` es la que
 * cuenta en el IVA (fechaIvaGasto): la contable salvo en una ERROR_IVA que
 * reduce, que va al periodo de la original. Que ese periodo este cerrado no
 * frena nada: solo se mira si su 303 esta presentado.
 */
export async function bloqueoPeriodoGasto(
  companyId: string,
  fecha: string,
  retencion: 'PROFESIONAL' | 'ARRENDAMIENTO' | null,
  fechaIva: string = fecha,
): Promise<BloqueoPeriodo | null> {
  try {
    await comprobarFechaAbierta(companyId, fecha);
  } catch (e) {
    if (e instanceof HttpError) return { motivo: e.message.replace(/: no se pueden añadir asientos con esa fecha\.?$/, ''), modelo: null, ejercicio: Number(fecha.slice(0, 4)), periodo: null };
    throw e;
  }
  const presentadoEn = async (codigo: '303' | '111' | '115', f: string): Promise<BloqueoPeriodo | null> => {
    const ejercicio = Number(f.slice(0, 4));
    const mes = f.slice(5, 7);
    const presentado = await prisma.modeloImpuesto.findFirst({
      where: { companyId, codigo, ejercicio, periodo: { in: [`${Math.ceil(Number(mes) / 3)}T`, mes] }, estado: 'presentado' },
      select: { periodo: true },
    });
    return presentado ? { motivo: `El ${codigo} del ${presentado.periodo} de ${ejercicio} ya está presentado`, modelo: codigo, ejercicio, periodo: presentado.periodo } : null;
  };
  const retenciones = retencion === 'PROFESIONAL' ? await presentadoEn('111', fecha) : retencion === 'ARRENDAMIENTO' ? await presentadoEn('115', fecha) : null;
  return retenciones ?? presentadoEn('303', fechaIva);
}

/** El motivo de bloqueoPeriodoGasto, o null si se puede tocar. */
export async function motivoPeriodoBloqueado(
  companyId: string,
  fecha: string,
  retencion: 'PROFESIONAL' | 'ARRENDAMIENTO' | null,
  fechaIva: string = fecha,
): Promise<string | null> {
  return (await bloqueoPeriodoGasto(companyId, fecha, retencion, fechaIva))?.motivo ?? null;
}

/** Pantalla del 303, para el enlace del 409 rectificar_303. */
const ENLACE_303 = '/dashboard/fiscal/modelo-303';

/** details del 409 de un abono que reduce el IVA de un 303 ya presentado. */
export const detallesRectificar303 = (b: BloqueoPeriodo, campo: string) => ({
  campo,
  motivo: 'rectificar_303',
  modelo: '303',
  ejercicio: b.ejercicio,
  periodo: b.periodo,
  enlace: ENLACE_303,
});

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** «el 1T de 2027» o «abril de 2027». */
const periodoTexto = (b: BloqueoPeriodo) => (/^\d{2}$/.test(b.periodo ?? '') ? `${MESES[Number(b.periodo) - 1]} de ${b.ejercicio}` : `el ${b.periodo} de ${b.ejercicio}`);

/** Aviso del alta (o de la aprobacion) de un abono registrado en un 303 ya presentado. */
export const avisoRectificar303 = (b: BloqueoPeriodo) =>
  `Registrada en ${periodoTexto(b)}, que ya está presentado: prepara la autoliquidación rectificativa de ese 303. ` +
  'En la contabilidad, apunta a mano la regularización del IVA (472 y 4750), el recargo (678) y los intereses de demora (669) cuando los pagues.';

/**
 * Marca en AuditLog de un abono que se registra (o se aprueba) en un 303 ya
 * presentado: recuerda la rectificativa del 303 y los asientos que hay que
 * hacer a mano (seccion 11 de la especificacion).
 */
export async function marcarRectificar303(companyId: string, facturaId: string, b: BloqueoPeriodo, cuota: number, userId?: string): Promise<void> {
  await registrarAuditoria({
    userId: userId ?? 'SYSTEM',
    companyId,
    action: 'RECTIFICAR_303_PENDIENTE',
    resourceType: 'ExpenseInvoice',
    resourceId: facturaId,
    meta: { modelo: '303', ejercicio: b.ejercicio, periodo: b.periodo, cuota, aviso: avisoRectificar303(b) },
  });
}

/**
 * Mensaje de una factura que caeria en un periodo ya declarado: se registra
 * con la fecha en que se recibio (art. 99 LIVA), que es la que cuenta en el IVA.
 */
export const textoPeriodoPresentado = (motivo: string) =>
  `${motivo}: si la recibiste más tarde, indica en «¿La recibiste más tarde?» la fecha en que te llegó, de un periodo sin presentar.`;

/**
 * La cuenta de gasto de cada linea (la suya o la de la factura) tiene que ser
 * del grupo 6 y estar activa en el plan de la empresa (o en el plan base). El
 * error apunta a la linea si la cuenta es suya y, si no, a la de la factura.
 */
async function comprobarCuentas(companyId: string, v: FacturaGastoBody, cuentas: Array<string | null>): Promise<void> {
  const problema = await problemaCuentasLinea(companyId, 'gasto', cuentas);
  if (!problema) return;
  const i = problema.indice;
  throw badRequest(problema.mensaje, { campo: v.lineas[i]?.cuenta ? `lineas.${i}.cuenta` : 'cuentaGasto' });
}

/**
 * Si la empresa lleva las nominas en la app (tiene trabajadores dados de alta).
 * Solo entonces una nomina, un RLC o una cuenta 640-642 tienen que ir por
 * Nominas: una empresa sin trabajadores (p. ej. una SL cuyo administrador paga
 * su cuota de autonomos) registra el recibo de la Seguridad Social como gasto.
 */
export async function empresaConNominas(companyId: string): Promise<boolean> {
  const db = prisma as unknown as { empleado?: { count?: unknown } };
  if (typeof db.empleado?.count !== 'function') return false;
  try {
    return (await prisma.empleado.count({ where: { companyId } })) > 0;
  } catch {
    return false; // sin la tabla de nominas (esquema sin aplicar): como antes de existir
  }
}

export const MENSAJE_CUENTAS_NOMINA =
  'Las cuentas 640, 641 y 642 son de nóminas: con trabajadores dados de alta, se registran en Nóminas, no como facturas de gasto.';

/**
 * Con trabajadores dados de alta, ninguna linea puede ir a la 640-642 (se
 * duplicarian las nominas): en el alta, el lector y la edicion, tanto con la
 * cuenta de la factura como con la de una linea.
 */
async function comprobarCuentasNomina(companyId: string, v: FacturaGastoBody, cuentas: Array<string | null>): Promise<void> {
  const i = cuentas.findIndex((c) => /^64[012]/.test(c ?? ''));
  if (i < 0 || !(await empresaConNominas(companyId))) return;
  throw badRequest(MENSAJE_CUENTAS_NOMINA, { campo: v.lineas[i]?.cuenta ? `lineas.${i}.cuenta` : 'cuentaGasto' });
}

/** 409 si ya hay otra factura vigente del mismo proveedor con ese numero. */
async function comprobarDuplicado(companyId: string, supplierId: string, numeroActivo: string, excluirId?: string): Promise<void> {
  const otra = await prisma.expenseInvoice.findFirst({
    where: { companyId, supplierId, numeroProveedorActivo: numeroActivo, ...(excluirId ? { id: { not: excluirId } } : {}) },
    include: { supplier: { select: { nombreFiscal: true } } },
  });
  if (otra) throw errorDuplicada(otra);
}

const errorDuplicada = (f: { id: string; numeroCompleto: string; numeroFacturaProveedor: string | null; supplier: { nombreFiscal: string } }) =>
  conflict(`Esta factura ya está registrada: ${f.supplier.nombreFiscal}, nº ${f.numeroFacturaProveedor} (registro ${f.numeroCompleto}).`, {
    campo: 'numeroFacturaProveedor',
    facturaId: f.id,
  });

/** Busca la factura que choca por el indice unico del numero del proveedor (tras un P2002). */
async function duplicadaTrasCarrera(companyId: string, supplierId: string | null, numeroActivo: string): Promise<HttpError> {
  const otra = supplierId
    ? await prisma.expenseInvoice.findFirst({
        where: { companyId, supplierId, numeroProveedorActivo: numeroActivo },
        include: { supplier: { select: { nombreFiscal: true } } },
      })
    : null;
  return otra ? errorDuplicada(otra) : conflict('Esta factura ya está registrada.', { campo: 'numeroFacturaProveedor' });
}

interface ProveedorPreparado {
  existente: ProveedorBasico | null;
  nuevo: (DatosProveedor & { nombreFiscal: string; nifCif: string; pais: string }) | null;
  pais: string | null;
}

/**
 * Proveedor de la factura: el elegido (de esta empresa; si no, 404) o los
 * datos validados del nuevo (409 si su NIF ya existe en la empresa). Si el
 * cuerpo no trae proveedor, el esquema dara el error.
 */
async function prepararProveedor(companyId: string, proveedor: unknown): Promise<ProveedorPreparado> {
  const p = (proveedor ?? {}) as { id?: unknown; nuevo?: unknown };
  if (typeof p.id === 'string' && p.id.trim() && p.nuevo === undefined) {
    const s = await prisma.supplier.findFirst({
      where: { id: p.id.trim(), companyId },
      select: { id: true, nombreFiscal: true, nifCif: true, pais: true },
    });
    if (!s) throw notFound('Proveedor no encontrado.');
    return { existente: s, nuevo: null, pais: s.pais };
  }
  if (p.nuevo && typeof p.nuevo === 'object' && p.id === undefined) {
    let d: DatosProveedor;
    try {
      d = datosProveedor(p.nuevo as Record<string, unknown>);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 400) {
        const campo = (e.details as { campo?: string } | undefined)?.campo;
        throw badRequest(e.message, { campo: `proveedor.${campo ?? 'nuevo'}` });
      }
      throw e;
    }
    const ya = await prisma.supplier.findFirst({ where: { companyId, nifCif: d.nifCif! }, select: { id: true, nombreFiscal: true } });
    if (ya) throw conflict(`Ya existe un proveedor con ese NIF: ${ya.nombreFiscal}`, { campo: 'proveedor.nifCif', proveedorId: ya.id });
    const nuevo = { ...d, nombreFiscal: d.nombreFiscal!, nifCif: d.nifCif!, pais: d.pais ?? 'ES' };
    return { existente: null, nuevo, pais: nuevo.pais };
  }
  return { existente: null, nuevo: null, pais: null };
}

/** Lineas para guardar (con su cuenta: la propia, la de la factura o ninguna) y totales. */
function lineasParaGuardar(v: FacturaGastoBody) {
  const calculo = calcularTotales(v.lineas);
  const lineas = calculo.lineasConTotales.map((l, i) => ({
    descripcion: l.descripcion,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    baseLine: l.baseLine,
    descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
    descuentoImporte: l.descuentoImporte,
    tipoIva: l.tipoIva ?? 21,
    ivaImporte: l.ivaImporte,
    tipoRetencion: l.tipoRetencion ?? 0,
    retencionImporte: l.retencionImporte,
    accountCode: v.lineas[i].cuenta ?? v.cuentaGasto ?? null,
  }));
  return { ...calculo, lineas, cabecera: cabeceraTipos(lineas) };
}

const NOMBRE_CUENTA = new Map(PGC_BASE.map((n) => [n.code, n.name]));

/** Lo que el asiento lleva de una rectificativa (descripcion y libro de IVA). */
interface DatosRectificativaAsiento {
  rectifica?: string;
  fechaLibroIva?: string | null;
  observacionesLibroIva?: string;
}

/** Datos del asiento de una rectificativa a partir de su plan (vacio si no lo es). */
const extraRectificativa = (p: PlanRectificativa | null): DatosRectificativaAsiento & { cuentaAcreedor?: string | null } =>
  p ? { cuentaAcreedor: p.cuentaAcreedor, rectifica: p.rectifica, fechaLibroIva: p.fechaImputacionIva, observacionesLibroIva: p.observacionesLibro } : {};

/**
 * Esta rectificativa reduce el IVA deducido de un periodo cuyo 303 ya esta
 * presentado (seccion 11 de la especificacion de abonos).
 */
const RECARGO_303 = 'saldrá más a ingresar y fuera de plazo, con el recargo y, en su caso, los intereses de demora (arts. 26 y 27 LGT).';

/**
 * 409 de un abono que reduce el IVA de un 303 ya presentado. Por el art. 80
 * (devolucion, descuento...) se declara en el periodo en que se recibe; una
 * ERROR_IVA que reduce, en el de la factura que corrige (art. 114 LIVA). En
 * los dos casos hay recargo e intereses de demora (arts. 26 y 27 LGT, por el
 * art. 114.Dos.2.º LIVA, comprobado en el BOE: version vigente desde el 31-10-2012).
 */
export const textoRectificar303 = (motivo: string, deLaOriginal: boolean) =>
  deLaOriginal
    ? `Esta rectificativa corrige un IVA mal aplicado y reduce el que dedujiste: se declara en el periodo de la factura que corrige. ${motivo}. Regístrala igualmente y presenta una autoliquidación rectificativa de ese 303: ${RECARGO_303}`
    : `Esta rectificativa reduce el IVA que dedujiste y se declara en el periodo en que la recibiste. ${motivo}. Si la recibiste en ese periodo, regístrala igualmente y presenta una autoliquidación rectificativa de ese 303: ${RECARGO_303} Si te llegó más tarde, pon la fecha en que te llegó.`;

/**
 * Con el periodo bloqueado (bloqueoPeriodoGasto): si es un abono que reduce el
 * IVA de un 303 presentado y esta confirmado (confirmaRectificar303, o ya lo
 * estaba para ese mismo periodo), devuelve el bloqueo para guardar la marca;
 * sin confirmar, el 409 rectificar_303. Lo demas (un cargo, un 111/115
 * presentado, un periodo cerrado) lanza el 409 de siempre (`otroError`).
 */
async function comprobarRectificar303(
  b: BloqueoPeriodo,
  p: {
    rect: { fechaImputacionIva: string | null } | null;
    ivaTotal: number;
    confirma: boolean;
    otroError?: (b: BloqueoPeriodo) => Promise<HttpError> | HttpError;
  },
): Promise<BloqueoPeriodo> {
  const reduce = !!p.rect && b.modelo === '303' && aCentimos(p.ivaTotal) < 0;
  if (!reduce) throw p.otroError ? await p.otroError(b) : conflict(textoPeriodoPresentado(b.motivo), { campo: 'fechaRegistro' });
  const deLaOriginal = !!p.rect?.fechaImputacionIva;
  if (!p.confirma) throw conflict(textoRectificar303(b.motivo, deLaOriginal), detallesRectificar303(b, deLaOriginal ? 'rectificativa' : 'fechaRegistro'));
  return b;
}

/**
 * Datos del motor contable a partir de la factura guardada y su proveedor: la
 * fecha de registro, la cuenta de cada linea y la base de las lineas con
 * retencion. Lo usan el alta, la edicion y el boton Contabilizar.
 */
export function datosContablesGasto(
  f: FacturaConLineas,
  s: { id: string; nifCif: string; nombreFiscal: string; pais?: string | null },
  extra: {
    estadoAsiento: 'POSTED' | 'DRAFT';
    numeroAsiento?: string;
    cuentaAcreedor?: string | null;
    nombreCuentaAcreedor?: string | null;
    /** Nombre de las cuentas de gasto en el plan de la empresa (sus subcuentas: 6280001 «Luz oficina»). */
    nombresCuentas?: Map<string, string>;
  } & DatosRectificativaAsiento,
): Parameters<typeof contabilizarFacturaGasto>[2] {
  const tipo: TipoGasto = esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA';
  const porCuenta = new Map<string, number>();
  for (const l of f.lineas) {
    const c = l.accountCode ?? TIPO_GASTO_INFO[tipo].cuenta;
    porCuenta.set(c, (porCuenta.get(c) ?? 0) + aCentimos(Number(l.baseLine)));
  }
  return {
    baseTotal: Number(f.baseTotal),
    ivaTotal: Number(f.ivaTotal),
    ivaRate: f.tipoIva,
    retencionTotal: Number(f.retencionTotal),
    retencionRate: f.tipoRetencion,
    totalFactura: Number(f.totalFactura),
    fechaEmision: fechaContableGasto(f),
    fechaExpedicion: f.fechaEmision,
    numeroFactura: f.numeroCompleto,
    numeroFacturaProveedor: f.numeroFacturaProveedor ?? null,
    proveedorId: s.id,
    proveedorNif: s.nifCif,
    proveedorNombre: s.nombreFiscal,
    tipoGasto: tipo,
    desgloseIva: f.lineas.length ? desgloseIvaPorTipo(f.lineas.map((l) => ({ tipoIva: l.tipoIva, baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte) }))) : undefined,
    gastoPorCuenta: f.lineas.length
      ? [...porCuenta].map(([cuenta, centimos]) => ({ cuenta, nombre: extra.nombresCuentas?.get(cuenta) ?? NOMBRE_CUENTA.get(cuenta) ?? 'Gastos', base: centimos / 100 }))
      : undefined,
    desgloseRetencion: desgloseRetencionGasto({
      baseTotal: Number(f.baseTotal),
      retencionTotal: Number(f.retencionTotal),
      tipoRetencion: f.tipoRetencion,
      lineas: f.lineas.map((l) => ({ tipoRetencion: l.tipoRetencion, baseLine: Number(l.baseLine), retencionImporte: Number(l.retencionImporte) })),
    }),
    // Adquisicion intracomunitaria (misma clasificacion que el 303 en su fecha
    // contable): el IVA que autoliquida la empresa va a la 472 y a la 477.
    ...(clasificarCompra(fechaContableGasto(f), s.pais, s.nifCif) === 'intracomunitaria'
      ? { autoliquidacion: autoliquidacionPorTipo(f.lineas.map((l) => ({ tipoIva: l.tipoIva, baseLine: Number(l.baseLine), ivaImporte: Number(l.ivaImporte) }))) }
      : {}),
    estadoAsiento: extra.estadoAsiento,
    ...(extra.rectifica !== undefined ? { rectifica: extra.rectifica } : {}),
    ...(extra.fechaLibroIva ? { fechaLibroIva: extra.fechaLibroIva } : {}),
    ...(extra.observacionesLibroIva ? { observacionesLibroIva: extra.observacionesLibroIva } : {}),
    ...(extra.numeroAsiento ? { numeroAsiento: extra.numeroAsiento } : {}),
    ...(extra.cuentaAcreedor ? { cuentaAcreedor: extra.cuentaAcreedor } : {}),
    ...(extra.nombreCuentaAcreedor ? { nombreCuentaAcreedor: extra.nombreCuentaAcreedor } : {}),
  };
}

/**
 * datosContablesGasto con la subcuenta del proveedor: la 400N (compras) o la
 * 410N (servicios) segun el tipo de gasto, asignada y dada de alta en el plan
 * si falta. Si la factura ya tiene pagos, la cuenta que usaron (`cuentaAcreedor`,
 * de cuentaAcreedorDePagos): asi pago y deuda casan; si fue la generica (pagos
 * anteriores a las subcuentas), se respeta y queda un aviso en el log.
 */
export async function datosContablesGastoConSubcuenta(
  tx: TransaccionBD,
  companyId: string,
  f: FacturaConLineas,
  s: { id: string; nifCif: string; nombreFiscal: string; pais?: string | null },
  extraSinNombres: { estadoAsiento: 'POSTED' | 'DRAFT'; numeroAsiento?: string; cuentaAcreedor?: string | null } & DatosRectificativaAsiento,
): Promise<Parameters<typeof contabilizarFacturaGasto>[2]> {
  // Cuentas de gasto con el nombre del plan (las subcuentas propias llevan el suyo).
  const tipo: TipoGasto = esTipoGasto(f.tipoGasto) ? f.tipoGasto : 'COMPRA';
  const nombresCuentas = await nombresDeCuentas(tx, companyId, f.lineas.map((l) => l.accountCode ?? TIPO_GASTO_INFO[tipo].cuenta));
  const extra = { ...extraSinNombres, nombresCuentas };
  if (extra.cuentaAcreedor) {
    if (esSubcuentaGenerica(extra.cuentaAcreedor)) {
      logger.warn('gasto contabilizado contra la cuenta generica de sus pagos anteriores', { companyId, factura: f.numeroCompleto, cuenta: extra.cuentaAcreedor });
      return datosContablesGasto(f, s, extra);
    }
    const enPlan = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo: extra.cuentaAcreedor }, select: { nombre: true } });
    return datosContablesGasto(f, s, { ...extra, nombreCuentaAcreedor: enPlan?.nombre ?? s.nombreFiscal });
  }
  const sub = await subcuentaProveedorParaApunte(tx, companyId, s.id, f.tipoGasto);
  return datosContablesGasto(f, s, { ...extra, cuentaAcreedor: sub.codigo, nombreCuentaAcreedor: sub.nombre });
}

/**
 * Cuenta del proveedor (40x/41x) que cargaron los pagos activos de una factura
 * aun sin asiento (null si no tiene pagos). Al contabilizarla, el abono va a
 * esa misma cuenta: si no, el pago queda en la 400 y la deuda en la 410.
 */
export async function cuentaAcreedorDePagos(companyId: string, invoiceId: string): Promise<string | null> {
  const pagos = await prisma.invoicePayment.findMany({
    where: { companyId, invoiceType: 'GASTO', invoiceId, estado: 'ACTIVO', journalEntryId: { not: null } },
    select: { journalEntryId: true },
    orderBy: { createdAt: 'asc' },
  });
  const ids = pagos.map((p) => p.journalEntryId).filter((x): x is string => !!x);
  if (!ids.length) return null;
  // Por la cuenta, sin mirar el lado (la devolucion de un abono lleva el proveedor al haber).
  const lineas = await prisma.journalEntryLine.findMany({
    where: { companyId, entryId: { in: ids } },
    select: { accountCode: true },
  });
  return lineas.find((l) => /^4[01]/.test(l.accountCode))?.accountCode ?? null;
}

const mensajeCambiada = 'La factura ha cambiado mientras la modificabas: vuelve a abrirla.';

/**
 * Bloquea la factura (SELECT ... FOR UPDATE) y comprueba que sigue como se
 * leyo antes de la transaccion: el mismo estado y updatedAt, sin pagos activos
 * y el mismo asiento vigente. Si otra pestana u otro usuario la ha modificado,
 * anulado o pagado entretanto, 409 y no se toca nada (antes quedaban dos
 * asientos en firme o una anulada que seguia contando).
 */
async function bloquearSinCambios(
  tx: TransaccionBD,
  companyId: string,
  id: string,
  antes: { estado: string; updatedAt: Date },
  asiento: { id: string; estado: string } | null,
  textoPagos: string,
): Promise<void> {
  const [fila] = await tx.$queryRaw<Array<{ estado: string; updatedAt: Date }>>`SELECT estado, updatedAt FROM ExpenseInvoice WHERE id = ${id} FOR UPDATE`;
  if (!fila) throw notFound('Factura de gasto no encontrada.');
  if (fila.estado === 'ANULADA' && antes.estado !== 'ANULADA') throw conflict('La factura ya está anulada.');
  const pagos = await tx.invoicePayment.count({ where: { companyId, invoiceType: 'GASTO', invoiceId: id, estado: 'ACTIVO' } });
  const vigente = await asientoVigente(tx, companyId, id);
  const cambiada =
    fila.estado !== antes.estado ||
    new Date(fila.updatedAt).getTime() !== antes.updatedAt.getTime() ||
    (vigente?.id ?? null) !== (asiento?.id ?? null) ||
    (vigente?.estado ?? null) !== (asiento?.estado ?? null);
  // motivo: la pantalla ofrece volver a abrirla en vez de solo ensenar el texto.
  if (cambiada) throw conflict(mensajeCambiada, { motivo: 'factura_cambiada' });
  if (pagos > 0) throw conflict(textoPagos);
}

/** Borra el libro de IVA y el de retenciones de un asiento. */
async function borrarLibrosDeAsiento(tx: TransaccionBD, companyId: string, asientoId: string): Promise<void> {
  await tx.vATBook.deleteMany({ where: { companyId, asientoId } });
  await tx.retentionBook.deleteMany({ where: { companyId, asientoId } });
}

/** Lo aplicado (pagos, devoluciones y compensaciones activos) y cuantos pagos activos tiene una factura. */
async function pagosDe(companyId: string, invoiceId: string): Promise<{ pagado: number; activos: number }> {
  const [aplicado, activos] = await Promise.all([
    aplicadoPorFactura(companyId, [invoiceId]),
    prisma.invoicePayment.count({ where: { companyId, invoiceType: 'GASTO', invoiceId, estado: 'ACTIVO' } }),
  ]);
  return { pagado: round2(aplicado.get(invoiceId) ?? 0), activos };
}

/** Lo aplicado por factura (pagos, devoluciones y compensaciones activos) de un conjunto de facturas. */
async function pagadoPorFacturas(companyId: string, ids: string[]): Promise<Map<string, number>> {
  return aplicadoPorFactura(companyId, ids);
}

const mensajeConPagos = 'La factura tiene pagos registrados: anúlalos antes de modificarla.';

/**
 * La factura ya cuenta en los modelos: con su asiento en firme o, sin asiento,
 * si es una anterior sin contabilizar (entra en el 303 por su fecha).
 */
const cuentaEnModelos = (estado: string, asiento: { estado: string } | null) =>
  asiento ? asiento.estado === 'POSTED' : ESTADOS_SIN_CONTABILIZAR.includes(estado);

const textoNoModificable = (motivo: string) =>
  `${motivo}: esta factura ya no se puede modificar. Anúlala (se hará un contraasiento con fecha de hoy) y vuelve a registrarla.`;

/** Factura anterior sin asiento de un periodo declarado: primero se contabiliza; despues se anula con contraasiento. */
const textoAnteriorDeclarada = (motivo: string, accion: 'modificar' | 'anular') =>
  `${motivo}: esta factura ya cuenta en lo presentado y no se puede ${accion} así. Contabilízala y, si hace falta, anúlala después (se hará un contraasiento).`;

const mayuscula = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Por que no se puede modificar o anular una factura anterior sin asiento y
 * que hacer. Si su mes esta bloqueado o cerrado (o su ejercicio cerrado),
 * contabilizarla tampoco se puede: se dice como abrirlo, sin mandar a
 * Contabilizar (si no, Contabilizar mandaba a modificarla y al reves). Si es
 * por un modelo presentado, contabilizarla y anularla despues con contraasiento.
 */
async function bloqueoAnterior(
  companyId: string,
  fecha: string,
  motivo: string,
  accion: 'modificar' | 'anular',
): Promise<{ texto: string; details: Record<string, unknown> }> {
  const p = await periodoNoAbierto(companyId, fecha);
  if (p) {
    return {
      texto: `${mayuscula(p.situacion)}: esta factura cuenta en ese periodo y no se puede ${accion} mientras siga así. ${p.queHacer}`,
      details: { motivo: p.motivo, enlace: p.enlace },
    };
  }
  return { texto: textoAnteriorDeclarada(motivo, accion), details: { accion: 'contabilizar' } };
}

// ---------------------------------------------------------------------------
// Alta (manual con asiento firme o desde el lector con asiento en borrador)
// ---------------------------------------------------------------------------

export interface OpcionesAlta {
  /** POSTED: alta manual (factura ACCOUNTED). DRAFT: lector (factura y asiento en borrador). */
  contabilizar?: 'POSTED' | 'DRAFT';
  /** Email del usuario, para el historial del proveedor si se crea. */
  usuarioEmail?: string;
  userId?: string;
  /** Texto que va delante de las observaciones (p. ej. la confianza del lector). */
  prefijoObservaciones?: string;
}

export interface ResultadoAlta {
  factura: GastoDetalle;
  asientoId: string;
  proveedorCreado: boolean;
}

/**
 * Alta de una factura de gasto con su asiento en la misma transaccion: la
 * factura, el proveedor nuevo (si lo hay), el asiento, el libro de IVA y el de
 * retenciones, o nada. Con POSTED la factura queda ACCOUNTED; con DRAFT
 * (lector) la factura y el asiento quedan en borrador hasta aprobarlo.
 */
export async function registrarGasto(companyId: string, cuerpo: unknown, opciones: OpcionesAlta & { contabilizar: 'POSTED' | 'DRAFT' }): Promise<ResultadoAlta> {
  const bruto = { ...((cuerpo ?? {}) as Record<string, unknown>) };
  if (bruto.proveedor === undefined && bruto.provider !== undefined) bruto.proveedor = bruto.provider;

  const prov = await prepararProveedor(companyId, bruto.proveedor);
  // Empresa no establecida en Espana: sin IVA español ni retenciones (como en ventas).
  const { espanola } = await perfilEmpresa(companyId);
  const v = validarFacturaGasto(bruto, { paisProveedor: prov.pais, permitirSerie: true, empresaEspanola: espanola });
  // Abono o rectificativa: enlaces con lo que rectifica y herencia de la original (puede cambiar las lineas y el tipo de gasto).
  const rect = v.rectificativa ? await prepararRectificativa(companyId, v, prov.existente?.id ?? null) : null;
  const { lineas, baseTotal, ivaTotal, retencionTotal, totalFactura, cabecera } = lineasParaGuardar(v);
  await comprobarCuentas(companyId, v, lineas.map((l) => l.accountCode));
  await comprobarCuentasNomina(companyId, v, lineas.map((l) => l.accountCode));

  const numeroActivo = normalizarNumeroProveedor(v.numeroFacturaProveedor);
  if (prov.existente) await comprobarDuplicado(companyId, prov.existente.id, numeroActivo);

  const fechaContable = v.fechaRegistro ?? v.fechaEmision;
  await comprobarFechaAbierta(companyId, fechaContable);
  // Presentar el 303 (o el 111/115) no cierra el mes: sin esto la factura
  // entraria en un trimestre ya declarado y su IVA no se deduciria en ninguno.
  // El 303 se mira en el periodo de su IVA (el de la original en una ERROR_IVA que reduce).
  const retencion = aCentimos(retencionTotal) !== 0 ? tipoRetencionLibro(v.tipoGasto) : null;
  const presentado = await bloqueoPeriodoGasto(companyId, fechaContable, retencion, rect?.fechaImputacionIva ?? fechaContable);
  // Un abono que reduce el IVA de un 303 presentado se registra si se confirma (seccion 11).
  const confirmado303 = presentado ? await comprobarRectificar303(presentado, { rect, ivaTotal, confirma: v.rectificativa?.confirmaRectificar303 === true }) : null;
  await asegurarPlanContableEmpresa(companyId);

  const { fechaEmision, fechaVencimiento } = resolverFechasGasto({ fechaEmision: v.fechaEmision, fechaVencimiento: v.fechaVencimiento });
  const serie = v.serie ?? 'G';
  const observaciones = [opciones.prefijoObservaciones, v.observaciones?.trim()].filter(Boolean).join(' ') || null;
  const estado = opciones.contabilizar === 'POSTED' ? 'ACCOUNTED' : 'DRAFT';

  let resultado: { id: string; asientoId: string; supplierId: string } | null = null;
  for (let intento = 1; !resultado; intento++) {
    try {
      resultado = await prisma.$transaction(async (tx) => {
        const supplier: ProveedorBasico = prov.existente ?? (await crearProveedorEnTx(tx, companyId, prov.nuevo!));
        const ultima = await tx.expenseInvoice.findFirst({ where: { companyId, serie }, orderBy: { numero: 'desc' }, select: { numero: true } });
        const numero = (ultima?.numero ?? 0) + 1;
        const f = await tx.expenseInvoice.create({
          data: {
            companyId,
            supplierId: supplier.id,
            serie,
            numero,
            numeroCompleto: `${serie}-${numero}`,
            numeroFacturaProveedor: v.numeroFacturaProveedor,
            numeroProveedorActivo: numeroActivo,
            fechaEmision,
            fechaRegistro: v.fechaRegistro && v.fechaRegistro !== fechaEmision ? v.fechaRegistro : null,
            fechaVencimiento,
            estado,
            estadoPago: 'PENDIENTE',
            tipoGasto: v.tipoGasto,
            baseTotal,
            ivaTotal,
            tipoIva: cabecera.tipoIva,
            retencionTotal,
            tipoRetencion: cabecera.tipoRetencion,
            totalFactura,
            observaciones,
            ...columnasRectificativa(rect),
            ...(confirmado303 ? { rectificar303ConfirmadoEn: new Date().toISOString() } : {}),
            lineas: { create: lineas },
          },
          include: { lineas: true },
        });
        if (rect) await guardarEnlaces(tx, companyId, f.id, rect.enlaces);
        const datos = await datosContablesGastoConSubcuenta(tx, companyId, f, supplier, { estadoAsiento: opciones.contabilizar, ...extraRectificativa(rect) });
        const { asientoId } = await contabilizarFacturaGasto(companyId, f.id, datos, tx);
        // Un abono en firme resta de lo pendiente de su original (las del lector, al aprobar el asiento).
        if (rect && opciones.contabilizar === 'POSTED') await crearCompensacionesAuto(tx, companyId, f.id, { fuera: rect.compensarFuera, userId: opciones.userId });
        return { id: f.id, asientoId, supplierId: supplier.id };
      }, OPCIONES_TX);
    } catch (e) {
      if (esDuplicado(e, 'numeroProveedorActivo')) throw await duplicadaTrasCarrera(companyId, prov.existente?.id ?? null, numeroActivo);
      if (esDuplicado(e, 'nifCif')) {
        const ya = await prisma.supplier.findFirst({ where: { companyId, nifCif: prov.nuevo?.nifCif ?? '' }, select: { id: true, nombreFiscal: true } });
        throw conflict(`Ya existe un proveedor con ese NIF: ${ya?.nombreFiscal ?? ''}`.trim(), { campo: 'proveedor.nifCif', proveedorId: ya?.id });
      }
      // Dos altas a la vez con el mismo numero interno (o la misma subcuenta de proveedor): se reintenta.
      const numeroRepetido = esDuplicado(e, 'serie') || esDuplicado(e, 'numeroCompleto') || INDICES_SUBCUENTA.some((i) => esDuplicado(e, i));
      if (!numeroRepetido || intento >= 5) throw e;
    }
  }

  const proveedorCreado = !prov.existente;
  if (proveedorCreado) await logCreate(resultado.supplierId, opciones.usuarioEmail, 'Proveedor creado al registrar una factura de gasto');
  // Queda registrada en el archivo de su trimestre (sin original). No bloqueante.
  await archivarGastoSinRomper(companyId, resultado.id);
  await registrarAuditoria({
    userId: opciones.userId ?? 'SYSTEM',
    companyId,
    action: opciones.contabilizar === 'POSTED' ? 'ALTA_FACTURA_GASTO' : 'ALTA_FACTURA_GASTO_LECTOR',
    resourceType: 'ExpenseInvoice',
    resourceId: resultado.id,
    meta: { asientoId: resultado.asientoId, proveedorCreado, ...(rect ? { rectificativa: { tipo: rect.tipo, causa: rect.causa, rectifica: rect.rectifica } } : {}) },
  });
  if (confirmado303) await marcarRectificar303(companyId, resultado.id, confirmado303, ivaTotal, opciones.userId);
  const factura = await obtenerDetalle(companyId, resultado.id);
  const avisos = [...(rect?.avisos ?? v.avisos ?? []), ...(confirmado303 ? [avisoRectificar303(confirmado303)] : [])];
  return { factura: avisos.length ? { ...factura, avisos } : factura, asientoId: resultado.asientoId, proveedorCreado };
}

/**
 * Alta interna de siempre (sin asiento): la usan los tests de cobros y de
 * archivo y otros llamadores internos. Guarda ademas la cabecera tipoIva y
 * tipoRetencion (la de la mayor base) y los campos nuevos si vienen.
 */
async function crearGastoSinAsiento(dto: CrearFacturaGastoDTO): Promise<ExpenseInvoiceResp> {
    // En desarrollo, si no hay líneas, crear una automáticamente
    let lineas = dto.lineas;
    if (!lineas || lineas.length === 0) {
      const anyDto = dto as any;
      const descripcion = anyDto.description || anyDto.concepto || 'Gasto general';
      const baseAmount = anyDto.baseAmount || anyDto.base || 0;
      const ivaPercentage = anyDto.ivaPercentage || anyDto.iva || 21;

      if (baseAmount > 0) {
        lineas = [{
          descripcion,
          cantidad: 1,
          precioUnitario: baseAmount,
          tipoIva: ivaPercentage,
        }];
      } else {
        throw badRequest('La factura necesita al menos una línea o baseAmount.');
      }
    }

    // 1) Resolver proveedor (con validación multitenancy)
    const supplierId = await resolverProveedor(dto.companyId, dto.provider);

    // 2) Resolver numeración
    const numero = await resolverNumeroFactura(dto.companyId, dto.serie, dto.numero);
    const numeroCompleto = `${dto.serie}-${numero}`;

    // 3) Resolver fechas
    const { fechaEmision, fechaVencimiento } = resolverFechasGasto(dto);

    // 4) Calcular totales
    const { baseTotal, ivaTotal, retencionTotal, totalFactura, lineasConTotales } = calcularTotales(lineas);
    const cabecera = cabeceraTipos(lineasConTotales.map((l) => ({ tipoIva: l.tipoIva ?? 21, tipoRetencion: l.tipoRetencion ?? 0, baseLine: l.baseLine })));

    // 5) Crear factura en BD
    const factura = await prisma.expenseInvoice.create({
      data: {
        companyId: dto.companyId,
        supplierId,
        serie: dto.serie,
        numero,
        numeroCompleto,
        fechaEmision,
        fechaVencimiento,
        estado: determinarEstado(fechaVencimiento),
        tipoGasto: dto.tipoGasto || 'COMPRA',
        baseTotal,
        ivaTotal,
        tipoIva: cabecera.tipoIva,
        retencionTotal,
        tipoRetencion: cabecera.tipoRetencion,
        totalFactura,
        observaciones: dto.observaciones,
        ...(dto.numeroFacturaProveedor?.trim()
          ? { numeroFacturaProveedor: dto.numeroFacturaProveedor.trim(), numeroProveedorActivo: normalizarNumeroProveedor(dto.numeroFacturaProveedor) }
          : {}),
        ...(dto.fechaRegistro ? { fechaRegistro: dto.fechaRegistro } : {}),
        lineas: {
          create: lineasConTotales.map((l) => ({
            descripcion: l.descripcion,
            cantidad: l.cantidad,
            precioUnitario: l.precioUnitario,
            baseLine: l.baseLine,
            descuentoPorcentaje: l.descuentoPorcentaje ?? 0,
            descuentoImporte: l.descuentoImporte,
            tipoIva: l.tipoIva ?? 21,
            ivaImporte: l.ivaImporte,
            tipoRetencion: l.tipoRetencion ?? 0,
            retencionImporte: l.retencionImporte,
          })),
        },
      },
      include: { lineas: true },
    });

    // 6) Mapear respuesta
    return {
      id: factura.id,
      companyId: factura.companyId,
      supplierId: factura.supplierId,
      serie: factura.serie,
      numero: factura.numero,
      numeroCompleto: factura.numeroCompleto,
      fechaEmision: factura.fechaEmision,
      fechaVencimiento: factura.fechaVencimiento,
      estado: factura.estado,
      estadoPago: factura.estadoPago,
      tipoGasto: factura.tipoGasto,
      baseTotal: factura.baseTotal,
      ivaTotal: factura.ivaTotal,
      retencionTotal: factura.retencionTotal,
      totalFactura: factura.totalFactura,
      observaciones: factura.observaciones ?? undefined,
      createdAt: factura.createdAt,
      updatedAt: factura.updatedAt,
      lineas: factura.lineas.map((l) => ({
        id: l.id,
        descripcion: l.descripcion,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario,
        baseLine: l.baseLine,
        descuentoPorcentaje: l.descuentoPorcentaje,
        descuentoImporte: l.descuentoImporte,
        tipoIva: l.tipoIva,
        ivaImporte: l.ivaImporte,
        tipoRetencion: l.tipoRetencion,
        retencionImporte: l.retencionImporte,
      })),
    };
}

/**
 * Crear factura de gasto. Sin `opciones.contabilizar`, el alta interna de
 * siempre (sin asiento). Con ella (controlador HTTP y lector), el alta
 * validada con su asiento (ver registrarGasto) y la ficha completa.
 */
function crearGasto(dto: CrearFacturaGastoDTO): Promise<ExpenseInvoiceResp>;
function crearGasto(dto: unknown, opciones: OpcionesAlta & { contabilizar: 'POSTED' | 'DRAFT' }): Promise<GastoDetalle>;
function crearGasto(dto: unknown, opciones: OpcionesAlta = {}): Promise<ExpenseInvoiceResp | GastoDetalle> {
  if (opciones.contabilizar) {
    const companyId = String((dto as { companyId?: unknown })?.companyId ?? '');
    return registrarGasto(companyId, dto, { ...opciones, contabilizar: opciones.contabilizar }).then((r) => r.factura);
  }
  return crearGastoSinAsiento(dto as CrearFacturaGastoDTO);
}

// ---------------------------------------------------------------------------
// Corregir (PUT) y anular
// ---------------------------------------------------------------------------

/**
 * Modifica una factura de gasto. Sin pagos activos y con el periodo abierto:
 * se rehacen las lineas, la cabecera y su asiento (POSTED: el anterior pasa a
 * REVERSED y se crea uno nuevo -R{n}; borrador: se rehace con el mismo numero)
 * con sus libros. Con el periodo cerrado o el modelo presentado: 409, se anula.
 */
export async function editarGasto(
  companyId: string,
  id: string,
  cuerpo: unknown,
  ctx: { userId?: string; usuarioEmail?: string } = {},
): Promise<GastoDetalle> {
  const actual = await prisma.expenseInvoice.findFirst({ where: { id, companyId }, include: { lineas: true } });
  if (!actual) throw notFound('Factura de gasto no encontrada.');
  if (actual.estado === 'ANULADA') throw conflict('La factura está anulada: no se puede modificar.');
  if (await tieneCobrosActivos(companyId, 'GASTO', id)) throw conflict(mensajeConPagos);

  const asiento = await asientoVigente(prisma, companyId, id);
  const enModelos = cuentaEnModelos(actual.estado, asiento);
  const bloqueo = async (motivo: string, fecha: string) => {
    if (asiento) return conflict(textoNoModificable(motivo), { accion: 'anular' });
    const b = await bloqueoAnterior(companyId, fecha, motivo, 'modificar');
    return conflict(b.texto, b.details);
  };
  // Un abono confirmado en un 303 ya presentado (seccion 11) se puede corregir sin volver a frenar.
  const bloqueoActual = enModelos ? await bloqueoPeriodoGasto(companyId, fechaContableGasto(actual), retencionDe(actual), fechaIvaGasto(actual)) : null;
  const confirmadoAntes = bloqueoActual?.modelo === '303' && !!actual.rectificar303ConfirmadoEn ? bloqueoActual : null;
  if (bloqueoActual && !confirmadoAntes) throw await bloqueo(bloqueoActual.motivo, fechaContableGasto(actual));

  const bruto = { ...((cuerpo ?? {}) as Record<string, unknown>) };
  if (bruto.proveedor === undefined && bruto.provider !== undefined) bruto.proveedor = bruto.provider;
  if (bruto.rectificativa === null) delete bruto.rectificativa;
  if (actual.esRectificativa !== (bruto.rectificativa !== undefined)) {
    throw badRequest(
      actual.esRectificativa
        ? 'Es un abono o una rectificativa: envía también el bloque «rectificativa». Para convertirla en una factura normal, anúlala y regístrala de nuevo.'
        : 'Una factura no se convierte en abono: registra el abono aparte (Compras › Nueva › Abono o rectificativa).',
      { campo: 'rectificativa' },
    );
  }
  const prov = await prepararProveedor(companyId, bruto.proveedor);
  const { espanola } = await perfilEmpresa(companyId);
  const v = validarFacturaGasto(bruto, { paisProveedor: prov.pais, permitirSerie: false, empresaEspanola: espanola });
  const rect = v.rectificativa ? await prepararRectificativa(companyId, v, prov.existente?.id ?? null, { excluirId: id }) : null;
  const { lineas, baseTotal, ivaTotal, retencionTotal, totalFactura, cabecera } = lineasParaGuardar(v);
  // Con rectificativas vigentes, sus importes y su proveedor no cambian (los demas datos, si).
  const cambiaImportes =
    prov.existente?.id !== actual.supplierId ||
    [
      [baseTotal, actual.baseTotal],
      [ivaTotal, actual.ivaTotal],
      [retencionTotal, actual.retencionTotal],
      [totalFactura, actual.totalFactura],
    ].some(([a, b]) => aCentimos(Number(a)) !== aCentimos(Number(b)));
  if (cambiaImportes) await comprobarSinRectificativas(companyId, id, 'corregir');
  // Lo compensado con abonos cuenta como pagado: el total no puede bajar de ahi; un abono aplicado a mano no se corrige.
  await comprobarCompensaciones(prisma, companyId, id, { totalNuevo: totalFactura });
  await comprobarCuentas(companyId, v, lineas.map((l) => l.accountCode));
  await comprobarCuentasNomina(companyId, v, lineas.map((l) => l.accountCode));
  const numeroActivo = normalizarNumeroProveedor(v.numeroFacturaProveedor);
  if (prov.existente) await comprobarDuplicado(companyId, prov.existente.id, numeroActivo, id);

  const fechaNueva = v.fechaRegistro ?? v.fechaEmision;
  await comprobarFechaAbierta(companyId, fechaNueva);
  let confirmado303: BloqueoPeriodo | null = null;
  if (enModelos) {
    const retencionNueva = aCentimos(retencionTotal) !== 0 ? tipoRetencionLibro(v.tipoGasto) : null;
    const b = await bloqueoPeriodoGasto(companyId, fechaNueva, retencionNueva, rect?.fechaImputacionIva ?? fechaNueva);
    if (b) {
      // Ya confirmado para ese mismo 303: no se vuelve a pedir.
      const mismo303 = !!confirmadoAntes && confirmadoAntes.ejercicio === b.ejercicio && confirmadoAntes.periodo === b.periodo;
      confirmado303 = await comprobarRectificar303(b, {
        rect,
        ivaTotal,
        confirma: mismo303 || v.rectificativa?.confirmaRectificar303 === true,
        otroError: (x) => bloqueo(x.motivo, fechaNueva),
      });
    }
  }
  // La marca solo sigue si el abono sigue en un 303 presentado; con otra fecha, se quita.
  // Un borrador del lector la conserva: se vuelve a mirar al aprobar el asiento.
  const marca303 = !actual.esRectificativa || !enModelos
    ? undefined
    : !confirmado303
      ? null
      : confirmadoAntes && confirmadoAntes.ejercicio === confirmado303.ejercicio && confirmadoAntes.periodo === confirmado303.periodo
        ? actual.rectificar303ConfirmadoEn
        : new Date().toISOString();
  if (asiento) await asegurarPlanContableEmpresa(companyId);

  const { fechaEmision, fechaVencimiento } = resolverFechasGasto({ fechaEmision: v.fechaEmision, fechaVencimiento: v.fechaVencimiento });
  const estado = actual.estado === 'PENDING' || actual.estado === 'OVERDUE' ? determinarEstado(fechaVencimiento) : actual.estado;

  let r: { asientoNuevo: string | null; supplierId: string };
  try {
    r = await conReintentoSubcuenta(() => prisma.$transaction(async (tx) => {
      // Lo comprobado arriba se vuelve a mirar con la factura bloqueada.
      await bloquearSinCambios(tx, companyId, id, actual, asiento, mensajeConPagos);
      const supplier: ProveedorBasico = prov.existente ?? (await crearProveedorEnTx(tx, companyId, prov.nuevo!));
      await tx.expenseInvoiceLine.deleteMany({ where: { invoiceId: id } });
      const f = await tx.expenseInvoice.update({
        where: { id },
        data: {
          supplierId: supplier.id,
          // El inmueble del 180 es del arrendador: con otro proveedor deja de valer (el 180 lo vuelve a proponer o pedir).
          ...(actual.supplierId !== supplier.id ? { inmuebleArrendadoId: null } : {}),
          numeroFacturaProveedor: v.numeroFacturaProveedor,
          numeroProveedorActivo: numeroActivo,
          fechaEmision,
          fechaRegistro: v.fechaRegistro && v.fechaRegistro !== fechaEmision ? v.fechaRegistro : null,
          fechaVencimiento,
          estado,
          tipoGasto: v.tipoGasto,
          baseTotal,
          ivaTotal,
          tipoIva: cabecera.tipoIva,
          retencionTotal,
          tipoRetencion: cabecera.tipoRetencion,
          totalFactura,
          observaciones: v.observaciones?.trim() || null,
          ...columnasRectificativa(rect),
          ...(marca303 !== undefined ? { rectificar303ConfirmadoEn: marca303 } : {}),
          lineas: { create: lineas },
        },
        include: { lineas: true },
      });
      if (rect) await guardarEnlaces(tx, companyId, id, rect.enlaces);
      if (!asiento) return { asientoNuevo: null, supplierId: supplier.id };

      await borrarLibrosDeAsiento(tx, companyId, asiento.id);
      if (asiento.estado === 'POSTED') {
        await tx.journalEntry.update({ where: { id: asiento.id }, data: { estado: 'REVERSED' } });
        // Las compensaciones AUTO de un abono se rehacen con sus importes nuevos (despues del asiento).
        if (actual.esRectificativa) await anularCompensacionesAuto(tx, companyId, id);
        const previos = await tx.journalEntry.count({ where: { companyId, invoiceId: id, origen: 'FACTURA_GASTO' } });
        // Con el proveedor o el tipo de gasto nuevos: su subcuenta (400N o 410N).
        const nuevo = await contabilizarFacturaGasto(
          companyId,
          id,
          await datosContablesGastoConSubcuenta(tx, companyId, f, supplier, {
            estadoAsiento: 'POSTED',
            numeroAsiento: `FAC-GAST-${f.numeroCompleto}-R${previos}`,
            ...extraRectificativa(rect),
          }),
          tx,
        );
        if (rect) await crearCompensacionesAuto(tx, companyId, id, { fuera: rect.compensarFuera, userId: ctx.userId });
        return { asientoNuevo: nuevo.asientoId, supplierId: supplier.id };
      }
      // Borrador (o pendiente de revisar): se rehace con el mismo numero y estado.
      await tx.journalEntry.delete({ where: { id: asiento.id } });
      const nuevo = await contabilizarFacturaGasto(
        companyId,
        id,
        await datosContablesGastoConSubcuenta(tx, companyId, f, supplier, { estadoAsiento: 'DRAFT', numeroAsiento: asiento.numeroAsiento, ...extraRectificativa(rect) }),
        tx,
      );
      if (asiento.estado !== 'DRAFT') await tx.journalEntry.update({ where: { id: nuevo.asientoId }, data: { estado: asiento.estado } });
      return { asientoNuevo: nuevo.asientoId, supplierId: supplier.id };
    }, OPCIONES_TX));
  } catch (e) {
    if (esDuplicado(e, 'numeroProveedorActivo')) throw await duplicadaTrasCarrera(companyId, prov.existente?.id ?? null, numeroActivo);
    if (esDuplicado(e, 'nifCif')) throw conflict('Ya existe un proveedor con ese NIF.', { campo: 'proveedor.nifCif' });
    throw e;
  }

  if (!prov.existente) await logCreate(r.supplierId, ctx.usuarioEmail, 'Proveedor creado al modificar una factura de gasto');
  await registrarAuditoria({
    userId: ctx.userId ?? 'SYSTEM',
    companyId,
    action: 'EDITAR_FACTURA_GASTO',
    resourceType: 'ExpenseInvoice',
    resourceId: id,
    meta: { asientoAnterior: asiento?.id ?? null, asientoNuevo: r.asientoNuevo },
  });
  // Confirmado ahora (no lo estaba para ese 303): marca en AuditLog y aviso, como en el alta.
  const nuevaMarca = confirmado303 && marca303 !== actual.rectificar303ConfirmadoEn ? confirmado303 : null;
  if (nuevaMarca) await marcarRectificar303(companyId, id, nuevaMarca, ivaTotal, ctx.userId);
  const detalle = await obtenerDetalle(companyId, id);
  const avisos = [...(rect?.avisos ?? v.avisos ?? []), ...(nuevaMarca ? [avisoRectificar303(nuevaMarca)] : [])];
  return avisos.length ? { ...detalle, avisos } : detalle;
}

/**
 * Anula una factura de gasto. Con el periodo abierto (o el asiento en
 * borrador) el asiento pasa a REVERSED y se borran sus libros. Con el periodo
 * cerrado o el modelo presentado, contraasiento POSTED con fecha de hoy (o la
 * indicada) y filas negativas en el libro de IVA y en el de retenciones: cada
 * periodo sigue cuadrando con el 303.
 */
export async function anularGasto(
  companyId: string,
  id: string,
  datos: { motivo?: unknown; fecha?: unknown },
  ctx: { userId?: string } = {},
): Promise<{ factura: GastoDetalle; contraasiento: boolean; asientoAnulacionId: string | null }> {
  const f = await prisma.expenseInvoice.findFirst({ where: { id, companyId }, include: { supplier: { select: { nombreFiscal: true } } } });
  if (!f) throw notFound('Factura de gasto no encontrada.');
  if (f.estado === 'ANULADA') throw conflict('La factura ya está anulada.');
  if (await tieneCobrosActivos(companyId, 'GASTO', id)) throw conflict('La factura tiene pagos registrados: anúlalos antes de anularla.');
  await comprobarSinRectificativas(companyId, id, 'anular');
  await comprobarCompensaciones(prisma, companyId, id);

  const motivo = typeof datos.motivo === 'string' ? datos.motivo.trim() : '';
  if (motivo.length < 3) throw badRequest('Indica el motivo de la anulación.', { campo: 'motivo' });
  if (motivo.length > 500) throw badRequest('El motivo es demasiado largo (500 caracteres como mucho).', { campo: 'motivo' });
  if (datos.fecha !== undefined && datos.fecha !== null && datos.fecha !== '') {
    if (typeof datos.fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(datos.fecha)) throw badRequest('La fecha tiene que ser AAAA-MM-DD.', { campo: 'fecha' });
    // new Date('2026-06-31') es el 1 de julio: el contraasiento caeria en otro trimestre.
    if (!esFechaReal(datos.fecha)) throw badRequest('Esa fecha no existe.', { campo: 'fecha' });
  }
  const fechaPedida = typeof datos.fecha === 'string' && datos.fecha ? datos.fecha : null;

  const asiento = await asientoVigente(prisma, companyId, id);
  // El 303 con la fecha de su IVA: una ERROR_IVA imputada a un 303 presentado se anula con
  // contraasiento. Aunque se confirmara al registrarla (rectificar303ConfirmadoEn), manda lo presentado.
  const declarada = cuentaEnModelos(f.estado, asiento) ? await motivoPeriodoBloqueado(companyId, fechaContableGasto(f), retencionDe(f), fechaIvaGasto(f)) : null;
  // Una factura anterior sin asiento ya cuenta en los modelos: si su periodo
  // esta declarado, anularla sin contraasiento cambiaria lo presentado.
  if (declarada && !asiento) {
    const b = await bloqueoAnterior(companyId, fechaContableGasto(f), declarada, 'anular');
    throw conflict(b.texto, b.details);
  }
  const conContraasiento = asiento?.estado === 'POSTED' && declarada !== null;
  const fechaAnulacion = fechaPedida ?? hoyEspana();
  if (conContraasiento && fechaAnulacion < fechaContableGasto(f)) {
    throw badRequest(`La fecha de anulación no puede ser anterior a la de registro de la factura (${ddmmaaaa(fechaContableGasto(f))}).`, { campo: 'fecha' });
  }
  if (conContraasiento) {
    await comprobarFechaAbierta(companyId, fechaAnulacion);
    const m = await motivoPeriodoBloqueado(companyId, fechaAnulacion, retencionDe(f));
    if (m) throw conflict(`${m}: elige una fecha de anulación de un periodo abierto.`, { campo: 'fecha' });
  }

  const contraId = await prisma.$transaction(async (tx) => {
    // Lo comprobado arriba se vuelve a mirar con la factura bloqueada.
    await bloquearSinCambios(tx, companyId, id, f, asiento, 'La factura tiene pagos registrados: anúlalos antes de anularla.');

    let contra: string | null = null;
    // Las compensaciones AUTO del abono se anulan con el (lo que restaba de su original vuelve a estar pendiente).
    if (f.esRectificativa) await anularCompensacionesAuto(tx, companyId, id, conContraasiento ? fechaAnulacion : hoyEspana());
    if (asiento && !conContraasiento) {
      await borrarLibrosDeAsiento(tx, companyId, asiento.id);
      await tx.journalEntry.update({ where: { id: asiento.id }, data: { estado: 'REVERSED' } });
    } else if (asiento && conContraasiento) {
      const original = await tx.journalEntry.findUniqueOrThrow({ where: { id: asiento.id }, include: { lineas: true } });
      const nfp = f.numeroFacturaProveedor ?? f.numeroCompleto;
      const c = await tx.journalEntry.create({
        data: {
          companyId,
          fecha: new Date(fechaAnulacion),
          numeroAsiento: `FAC-GAST-${f.numeroCompleto}-ANUL`,
          descripcion: `Anulación de la factura ${nfp} (registro ${f.numeroCompleto}): ${motivo}`.slice(0, 190),
          origen: 'FACTURA_GASTO',
          estado: 'POSTED',
          invoiceId: id,
          invoiceType: 'GASTO',
        },
      });
      for (const l of original.lineas) {
        await tx.journalEntryLine.create({
          data: { entryId: c.id, accountCode: l.accountCode, accountName: l.accountName, debe: l.haber, haber: l.debe, referencia: l.referencia, companyId },
        });
      }
      const fechaOriginal = fechaContableGasto(f);
      for (const v of await tx.vATBook.findMany({ where: { companyId, asientoId: asiento.id } })) {
        await tx.vATBook.create({
          data: {
            companyId,
            tipoLibro: v.tipoLibro,
            numeroFactura: `${v.numeroFactura}-ANUL`,
            numeroFacturaEmisor: v.numeroFacturaEmisor,
            fechaFactura: new Date(fechaAnulacion),
            nifTercero: v.nifTercero,
            nombreTercero: v.nombreTercero,
            baseImponible: -Number(v.baseImponible),
            tipoIva: v.tipoIva,
            cuotaIva: -Number(v.cuotaIva),
            asientoId: c.id,
            observaciones: `Anulación de la factura del ${ddmmaaaa(fechaOriginal)}`,
          },
        });
      }
      for (const rb of await tx.retentionBook.findMany({ where: { companyId, asientoId: asiento.id } })) {
        await tx.retentionBook.create({
          data: {
            companyId,
            ano: Number(fechaAnulacion.slice(0, 4)),
            mes: Number(fechaAnulacion.slice(5, 7)),
            tipoRetencionNombre: rb.tipoRetencionNombre,
            nifTercero: rb.nifTercero,
            nombreTercero: rb.nombreTercero,
            baseImponible: -Number(rb.baseImponible),
            porcentajeRetencion: rb.porcentajeRetencion,
            cuotaRetencion: -Number(rb.cuotaRetencion),
            asientoId: c.id,
          },
        });
      }
      contra = c.id;
    }
    await tx.expenseInvoice.update({
      where: { id },
      data: {
        estado: 'ANULADA',
        numeroProveedorActivo: null,
        anuladaEn: conContraasiento ? fechaAnulacion : hoyEspana(),
        motivoAnulacion: motivo,
        anulacionAsientoId: contra,
      },
    });
    return contra;
  }, OPCIONES_TX);

  await registrarAuditoria({
    userId: ctx.userId ?? 'SYSTEM',
    companyId,
    action: 'ANULAR_FACTURA_GASTO',
    resourceType: 'ExpenseInvoice',
    resourceId: id,
    meta: { motivo, asientoAnulado: asiento?.id ?? null, contraasiento: contraId },
  });
  return { factura: await obtenerDetalle(companyId, id), contraasiento: !!contraId, asientoAnulacionId: contraId };
}

// ---------------------------------------------------------------------------
// Ficha y listado
// ---------------------------------------------------------------------------

const lineaResp = (l: LineaGuardada) => ({
  id: l.id,
  descripcion: l.descripcion,
  cantidad: l.cantidad,
  precioUnitario: l.precioUnitario,
  baseLine: l.baseLine,
  descuentoPorcentaje: l.descuentoPorcentaje,
  descuentoImporte: l.descuentoImporte,
  tipoIva: l.tipoIva,
  ivaImporte: l.ivaImporte,
  tipoRetencion: l.tipoRetencion,
  retencionImporte: l.retencionImporte,
  accountCode: l.accountCode ?? null,
});

/** Ficha completa (GastoDetalle) con lo pagado, el asiento y lo que se puede hacer con ella. */
async function obtenerDetalle(companyId: string, id: string): Promise<GastoDetalle> {
  const f = await prisma.expenseInvoice.findFirst({
    where: { id, companyId },
    include: { lineas: true, supplier: { select: { id: true, nombreFiscal: true, nifCif: true, pais: true } } },
  });
  if (!f) throw notFound('Factura de gasto no encontrada.');

  const [{ pagado, activos }, perfil, rect, compensaciones] = await Promise.all([
    pagosDe(companyId, id),
    perfilEmpresa(companyId),
    datosRectificativaDeFicha(companyId, f),
    compensacionesDe(companyId, id),
  ]);
  // Aplicaciones de abonos que impiden anularla (el mismo texto que el 409 de anularGasto).
  const bloqueoCompensaciones =
    f.estado === 'ANULADA' ? null : await comprobarCompensaciones(prisma, companyId, id).then(() => null, (e: unknown) => (e instanceof HttpError ? e.message : null));
  const pendiente = f.estado === 'ANULADA' ? 0 : round2(Number(f.totalFactura) - pagado);
  const esAbono = aCentimos(Number(f.totalFactura)) < 0;
  // En una anulada se ensena el asiento original (aunque este REVERSED); el contraasiento va en `anulacion`.
  const asiento =
    f.estado === 'ANULADA'
      ? await prisma.journalEntry.findFirst({
          where: { companyId, invoiceId: id, origen: 'FACTURA_GASTO', ...(f.anulacionAsientoId ? { id: { not: f.anulacionAsientoId } } : {}) },
          orderBy: { createdAt: 'desc' },
        })
      : await asientoVigente(prisma, companyId, id);

  const hoy = hoyEspana();
  const vencida = esVencida(f, hoy);
  const cuentas = [...new Set(f.lineas.map((l) => l.accountCode ?? ''))];
  const tipo = esTipoGasto(f.tipoGasto) ? f.tipoGasto : null;

  // Lo que se puede hacer (las mismas reglas que editarGasto y anularGasto, sin lanzar errores).
  const bloqueoModelos = cuentaEnModelos(f.estado, asiento) ? await bloqueoPeriodoGasto(companyId, fechaContableGasto(f), retencionDe(f), fechaIvaGasto(f)) : null;
  const bloqueo = bloqueoModelos?.motivo ?? null;
  // Un abono confirmado en un 303 ya presentado se puede corregir (anularlo sigue con contraasiento).
  const bloqueoEdicion = bloqueoModelos?.modelo === '303' && f.rectificar303ConfirmadoEn ? null : bloqueo;
  const [bloqueoEditar, bloqueoAnular] =
    bloqueo && !asiento
      ? await Promise.all([
          bloqueoAnterior(companyId, fechaContableGasto(f), bloqueo, 'modificar'),
          bloqueoAnterior(companyId, fechaContableGasto(f), bloqueo, 'anular'),
        ])
      : [null, null];
  const editar =
    f.estado === 'ANULADA'
      ? { permitido: false, motivo: 'La factura está anulada: no se puede modificar.' }
      : activos > 0
        ? { permitido: false, motivo: mensajeConPagos }
        : bloqueoEdicion
          ? { permitido: false, motivo: bloqueoEditar ? bloqueoEditar.texto : textoNoModificable(bloqueoEdicion) }
          : { permitido: true };
  const anular =
    f.estado === 'ANULADA'
      ? { permitido: false, motivo: 'La factura ya está anulada.', conContraasiento: false }
      : activos > 0
        ? { permitido: false, motivo: 'La factura tiene pagos registrados: anúlalos antes de anularla.', conContraasiento: false }
        : bloqueoAnular
          ? { permitido: false, motivo: bloqueoAnular.texto, conContraasiento: false }
          : rect.rectificativas.length
            ? {
                permitido: false,
                motivo: `Tiene ${rect.rectificativas.length === 1 ? 'la rectificativa' : 'las rectificativas'} ${rect.rectificativas.map((x) => x.numero ?? x.numeroCompleto).join(', ')}: ${rect.rectificativas.length === 1 ? 'anúlala' : 'anúlalas'} antes de anular la factura.`,
                conContraasiento: false,
              }
            : bloqueoCompensaciones
              ? { permitido: false, motivo: bloqueoCompensaciones, conContraasiento: false }
              : { permitido: true, conContraasiento: !!bloqueo };

  return {
    id: f.id,
    companyId: f.companyId,
    supplierId: f.supplierId,
    serie: f.serie,
    numero: f.numero,
    numeroCompleto: f.numeroCompleto,
    numeroFacturaProveedor: f.numeroFacturaProveedor ?? null,
    fechaEmision: f.fechaEmision,
    fechaRegistro: f.fechaRegistro ?? null,
    fechaVencimiento: f.fechaVencimiento,
    estado: f.estado,
    estadoTexto: textoEstadoGasto(f.estado),
    estadoPago: f.estadoPago,
    estadoPagoTexto: textoEstadoPago(f.estadoPago, vencida),
    vencida,
    tipoGasto: f.tipoGasto,
    tipoGastoTexto: tipo ? TIPO_GASTO_INFO[tipo].texto : f.tipoGasto,
    cuentaGasto: cuentas.length === 1 && cuentas[0] ? cuentas[0] : null,
    tipoIva: f.tipoIva,
    tipoRetencion: f.tipoRetencion,
    baseTotal: f.baseTotal,
    ivaTotal: f.ivaTotal,
    retencionTotal: f.retencionTotal,
    totalFactura: f.totalFactura,
    importePagado: pagado,
    importePendiente: pendiente,
    pendiente,
    ...(esAbono ? { aFavor: round2(-pendiente) || 0 } : {}),
    compensaciones,
    observaciones: f.observaciones ?? undefined,
    monedaCuenta: perfil.monedaCuenta,
    supplier: { id: f.supplier.id, nombreFiscal: f.supplier.nombreFiscal, nifCif: f.supplier.nifCif, pais: f.supplier.pais },
    lineas: f.lineas.map(lineaResp),
    asiento: asiento ? { id: asiento.id, numeroAsiento: asiento.numeroAsiento, estado: asiento.estado, fecha: asiento.fecha.toISOString().slice(0, 10) } : null,
    anulacion: f.estado === 'ANULADA' ? { fecha: f.anuladaEn ?? '', motivo: f.motivoAnulacion ?? '', contraasientoId: f.anulacionAsientoId ?? null } : null,
    acciones: {
      editar,
      anular,
      contabilizar: ESTADOS_SIN_CONTABILIZAR.includes(f.estado) && !asiento,
    },
    esRectificativa: f.esRectificativa,
    ...rect,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

const ESTADOS_FILTRO: Record<string, Prisma.ExpenseInvoiceWhereInput> = {
  sin_contabilizar: { estado: { in: ESTADOS_SIN_CONTABILIZAR } },
  pendiente_revision: { estado: 'DRAFT' },
  contabilizada: { estado: 'ACCOUNTED' },
  anulada: { estado: 'ANULADA' },
};

function filtroPago(pago: string, hoy: string): Prisma.ExpenseInvoiceWhereInput {
  // Los abonos (total < 0) no se pagan ni vencen: tienen su propio filtro (tipo=abonos).
  const noAnulada = { estado: { not: 'ANULADA' }, totalFactura: { gte: 0 } };
  if (pago === 'pendiente') return { ...noAnulada, estadoPago: 'PENDIENTE' };
  // Lo que cuenta el contador «Pendientes de pago»: sin pagar del todo (pendientes y pagadas en parte).
  if (pago === 'por_pagar') return { ...noAnulada, estadoPago: { not: 'PAGADA' } };
  if (pago === 'parcial') return { ...noAnulada, estadoPago: 'PARCIAL' };
  if (pago === 'pagada') return { estadoPago: 'PAGADA', totalFactura: { gte: 0 } };
  if (pago === 'a_favor') return { estado: { not: 'ANULADA' }, totalFactura: { lt: 0 }, estadoPago: { not: 'PAGADA' } };
  return { ...noAnulada, estadoPago: { not: 'PAGADA' }, fechaVencimiento: { lt: hoy } }; // vencida
}

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Listado paginado con filtros, contadores (sin el filtro de estado ni el de
 * pago) y totales del conjunto filtrado completo (sin anuladas).
 */
async function listarGastos(companyId: string, filtros: FiltrosGastos = {}): Promise<ListadoGastos> {
  const page = Math.max(1, Math.floor(Number(filtros.page) || 1));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(filtros.limit) || 25)));
  const q = texto(filtros.q);
  const estado = texto(filtros.estado);
  const pago = texto(filtros.pago);
  const tipo = texto(filtros.tipo);
  const supplierId = texto(filtros.supplierId);
  const desde = texto(filtros.desde);
  const hasta = texto(filtros.hasta);
  if (estado && !ESTADOS_FILTRO[estado]) throw badRequest('Estado no válido: usa sin_contabilizar, pendiente_revision, contabilizada o anulada.');
  if (pago && !['pendiente', 'parcial', 'por_pagar', 'pagada', 'vencida', 'a_favor'].includes(pago)) {
    throw badRequest('Filtro de pago no válido: usa pendiente, parcial, por_pagar, pagada, vencida o a_favor.');
  }
  if (tipo && !['facturas', 'abonos'].includes(tipo)) throw badRequest('Tipo no válido: usa facturas o abonos.');
  for (const [nombre, f] of [['desde', desde], ['hasta', hasta]] as const) {
    if (f && !/^\d{4}-\d{2}-\d{2}$/.test(f)) throw badRequest(`La fecha «${nombre}» tiene que ser AAAA-MM-DD.`);
    if (f && !esFechaReal(f)) throw badRequest(`La fecha «${nombre}» no existe.`);
  }

  const hoy = hoyEspana();
  const comunes: Prisma.ExpenseInvoiceWhereInput[] = [{ companyId }];
  if (supplierId) comunes.push({ supplierId });
  if (tipo) comunes.push({ esRectificativa: tipo === 'abonos' });
  if (q) {
    comunes.push({
      OR: [
        { numeroCompleto: { contains: q } },
        { numeroFacturaProveedor: { contains: q } },
        { supplier: { nombreFiscal: { contains: q } } },
        { supplier: { nifCif: { contains: q } } },
      ],
    });
  }
  if (desde || hasta) {
    const rango = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) };
    comunes.push({ OR: [{ fechaRegistro: rango }, { fechaRegistro: null, fechaEmision: rango }] });
  }
  const whereBase: Prisma.ExpenseInvoiceWhereInput = { AND: comunes };
  const where: Prisma.ExpenseInvoiceWhereInput = {
    AND: [...comunes, ...(estado ? [ESTADOS_FILTRO[estado]] : []), ...(pago ? [filtroPago(pago, hoy)] : [])],
  };
  const sinAnuladas: Prisma.ExpenseInvoiceWhereInput = { AND: [where, { estado: { not: 'ANULADA' } }] };

  const [items, total, porEstado, pendientesPago, vencidas, suma, idsFiltrados, perfil, abonosAFavor] = await Promise.all([
    prisma.expenseInvoice.findMany({
      where,
      include: { supplier: { select: { id: true, nombreFiscal: true, nifCif: true } } },
      orderBy: [{ fechaEmision: 'desc' }, { numero: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.expenseInvoice.count({ where }),
    prisma.expenseInvoice.groupBy({ by: ['estado'], where: whereBase, _count: { _all: true } }),
    prisma.expenseInvoice.count({ where: { AND: [whereBase, filtroPago('por_pagar', hoy)] } }),
    prisma.expenseInvoice.count({ where: { AND: [whereBase, filtroPago('vencida', hoy)] } }),
    prisma.expenseInvoice.aggregate({ where: sinAnuladas, _sum: { baseTotal: true, ivaTotal: true, retencionTotal: true, totalFactura: true } }),
    prisma.expenseInvoice.findMany({ where: sinAnuladas, select: { id: true, totalFactura: true } }),
    perfilEmpresa(companyId),
    prisma.expenseInvoice.count({ where: { AND: [whereBase, filtroPago('a_favor', hoy)] } }),
  ]);

  const pagado = await pagadoPorFacturas(companyId, [...new Set([...items.map((f) => f.id), ...idsFiltrados.map((f) => f.id)])]);
  const cuenta = (estados: string[]) => porEstado.filter((g) => estados.includes(g.estado)).reduce((a, g) => a + g._count._all, 0);
  const totalFiltrado = round2(Number(suma._sum.totalFactura ?? 0));
  // Pendiente de pago (sin los abonos) y a favor (los abonos), por separado.
  const pendienteDe = (f: { id: string; totalFactura: number }) => aCentimos(Number(f.totalFactura)) - aCentimos(pagado.get(f.id) ?? 0);
  const pendienteFiltrado = idsFiltrados.filter((f) => aCentimos(Number(f.totalFactura)) >= 0).reduce((a, f) => a + pendienteDe(f), 0) / 100;
  const aFavorFiltrado = -idsFiltrados.filter((f) => aCentimos(Number(f.totalFactura)) < 0).reduce((a, f) => a + pendienteDe(f), 0) / 100;

  return {
    items: items.map((f) => {
      const vencida = esVencida(f, hoy);
      const tipo = esTipoGasto(f.tipoGasto) ? f.tipoGasto : null;
      return {
        id: f.id,
        numeroCompleto: f.numeroCompleto,
        numeroFacturaProveedor: f.numeroFacturaProveedor ?? null,
        fechaEmision: f.fechaEmision,
        fechaRegistro: f.fechaRegistro ?? null,
        fechaVencimiento: f.fechaVencimiento,
        supplier: f.supplier,
        supplierNombre: f.supplier.nombreFiscal,
        tipoGasto: f.tipoGasto,
        tipoGastoTexto: tipo ? TIPO_GASTO_INFO[tipo].texto : f.tipoGasto,
        estado: f.estado,
        estadoTexto: textoEstadoGasto(f.estado),
        estadoPago: f.estadoPago,
        estadoPagoTexto: textoEstadoPago(f.estadoPago, vencida),
        vencida,
        baseTotal: f.baseTotal,
        ivaTotal: f.ivaTotal,
        retencionTotal: f.retencionTotal,
        totalFactura: f.totalFactura,
        importePendiente: f.estado === 'ANULADA' ? 0 : round2(Number(f.totalFactura) - (pagado.get(f.id) ?? 0)),
        esRectificativa: f.esRectificativa,
        esAbono: aCentimos(Number(f.totalFactura)) < 0,
      };
    }),
    total,
    page,
    limit,
    paginas: Math.max(1, Math.ceil(total / limit)),
    contadores: {
      todas: cuenta(porEstado.map((g) => g.estado)),
      sinContabilizar: cuenta(ESTADOS_SIN_CONTABILIZAR),
      pendientesRevision: cuenta(['DRAFT']),
      contabilizadas: cuenta(['ACCOUNTED']),
      anuladas: cuenta(['ANULADA']),
      pendientesPago,
      vencidas,
      abonosAFavor,
    },
    totales: {
      base: round2(Number(suma._sum.baseTotal ?? 0)),
      iva: round2(Number(suma._sum.ivaTotal ?? 0)),
      retencion: round2(Number(suma._sum.retencionTotal ?? 0)),
      total: totalFiltrado,
      pendiente: round2(pendienteFiltrado),
      aFavor: round2(aFavorFiltrado),
    },
    monedaCuenta: perfil.monedaCuenta,
  };
}

/**
 * Cambio de estado a mano: solo entre los estados de las facturas anteriores
 * sin contabilizar (PENDING, OVERDUE, CONFIRMED). Contabilizar y anular tienen
 * su propio camino.
 */
async function cambiarEstado(companyId: string, id: string, nuevoEstado: unknown): Promise<GastoDetalle> {
  if (typeof nuevoEstado !== 'string' || !ESTADOS_SIN_CONTABILIZAR.includes(nuevoEstado)) {
    throw badRequest('Ese estado no se cambia a mano: para contabilizar usa Contabilizar, y para anular, Anular.', { campo: 'nuevoEstado' });
  }
  const factura = await prisma.expenseInvoice.findFirst({ where: { id, companyId }, select: { estado: true } });
  if (!factura) throw notFound('Factura de gasto no encontrada.');
  if (!ESTADOS_SIN_CONTABILIZAR.includes(factura.estado)) {
    throw conflict(`La factura está ${textoEstadoGasto(factura.estado).toLowerCase()}: su estado no se cambia a mano.`);
  }
  await prisma.expenseInvoice.update({ where: { id }, data: { estado: nuevoEstado } });
  return obtenerDetalle(companyId, id);
}

export const expenseInvoicesService = {
  crearGasto,
  registrarGasto,
  editarGasto,
  anularGasto,
  listarGastos,
  /** Obtener una factura de gasto por ID (ficha completa). */
  obtenerPorId: obtenerDetalle,
  cambiarEstado,
};
