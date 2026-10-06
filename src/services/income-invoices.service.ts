import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../utils/http-errors';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import { obtenerOCrearSerie, obtenerSeriePorDefecto, resolverCodSerieFactura } from './series.service';
import { listarCobros, registrarCobroFactura, tieneCobrosActivos, type DatosCobro } from './cobrosPagos.service';

/**
 * Facturas de venta.
 *
 * Ciclo de vida (como pide Verifactu):
 *  - BORRADOR: sin numero, editable y borrable. No cuenta para impuestos,
 *    informes ni contabilidad.
 *  - FINAL: numerada en su serie (orden correlativo, sin huecos) y con sus
 *    datos fiscales congelados. Ya no se edita ni se borra: los errores se
 *    corrigen con una factura rectificativa en su propia serie.
 *
 * Aparte va `estado`, que es el estado de COBRO (PENDING, PAID, OVERDUE...).
 */

export const ESTADO_BORRADOR = 'BORRADOR';
export const ESTADO_FINAL = 'FINAL';

/** Tipos de factura de Verifactu: F1 completa, F2 simplificada, R1-R5 rectificativas. */
export const TIPOS_FACTURA = ['F1', 'F2', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type TipoFactura = (typeof TIPOS_FACTURA)[number];

/** Formas de pago que se imprimen en la factura. */
export const FORMAS_PAGO = ['TRANSFERENCIA', 'GIRO', 'CONTADO'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

/** Estados de cobro que se pueden poner a mano en una factura final. */
export const ESTADOS_COBRO = ['PENDING', 'PAID', 'OVERDUE'] as const;

/**
 * DTO para crear una factura de ingreso.
 * Soporta cliente existente (id) o nuevo (nuevo con datos).
 */
export interface CrearFacturaIngresoDTO {
  companyId: string;
  customer: {
    id?: string; // Cliente existente
    nuevo?: {
      nombreFiscal: string;
      nifCif: string;
      direccion?: string;
      pais?: string;
      provincia?: string;
      municipio?: string;
      cp?: string;
      email?: string;
    };
  };
  /** Codigo de la serie. Si no se indica, la serie de facturas por defecto. */
  serie?: string;
  /**
   * Solo para facturas YA emitidas fuera de la app (lector de facturas):
   * se registran con su numero original. Al crear una factura nueva no se indica.
   */
  numero?: number;
  fechaEmision?: string; // YYYY-MM-DD, defecto: hoy
  fechaVencimiento?: string; // YYYY-MM-DD, defecto: fechaEmision + 15 días
  lineas: CrearLineaIngresoDTO[];
  plantillaId?: string; // Defecto: "default"
  observaciones?: string;
  /** true: se guarda como borrador, sin numero. Por defecto se emite (final). */
  borrador?: boolean;
  tipoFactura?: TipoFactura;
  /** Transferencia bancaria (defecto), giro (recibo domiciliado) o contado. */
  formaPago?: FormaPago;
  facturaOriginalId?: string; // Si es rectificativa
  tipoRectificativa?: 'S' | 'I';
  motivoRectificacion?: string;
}

export interface CrearLineaIngresoDTO {
  descripcion: string;
  cantidad: number;
  precioUnitario: number;
  descuentoPorcentaje?: number;
  tipoIva?: number; // 0, 4, 10, 21 (defecto 21)
  tipoRetencion?: number; // 0, 7, 15, 19 (defecto 0)
  productoServicioId?: string;
}

/** Cambios admitidos en un borrador (todo opcional). */
export type ActualizarBorradorDTO = Partial<
  Pick<
    CrearFacturaIngresoDTO,
    | 'customer'
    | 'serie'
    | 'fechaEmision'
    | 'fechaVencimiento'
    | 'lineas'
    | 'observaciones'
    | 'tipoFactura'
    | 'plantillaId'
    | 'formaPago'
  >
>;

export interface IncomeInvoiceResp {
  id: string;
  companyId: string;
  customerId: string;
  serie: string;
  numero: number | null;
  numeroCompleto: string | null;
  estadoDocumento: string;
  tipoFactura: string;
  formaPago: string;
  tipoRectificativa?: string;
  motivoRectificacion?: string;
  finalizadaEn?: Date;
  fechaEmision: string;
  fechaVencimiento: string;
  estado: string;
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  plantillaId: string;
  observaciones?: string;
  esRectificativa: boolean;
  facturaOriginalId?: string;
  esRecurrente: boolean;
  createdAt: Date;
  updatedAt: Date;
  lineas: LineaIngresoResp[];
}

export interface LineaIngresoResp {
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
  productoServicioId?: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const hoyISO = (): string => new Date().toISOString().slice(0, 10);
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_IVA = [0, 4, 5, 10, 21];

// Tipos del cliente con extensiones: los importes ya llegan como number.
type FacturaConLineas = NonNullable<Awaited<ReturnType<typeof buscarConLineas>>>;
const buscarConLineas = (companyId: string, id: string) =>
  prisma.incomeInvoice.findFirst({ where: { id, companyId }, include: { lineas: true } });

function aRespuesta(f: FacturaConLineas): IncomeInvoiceResp {
  return {
    id: f.id,
    companyId: f.companyId,
    customerId: f.customerId,
    serie: f.serie,
    numero: f.numero,
    numeroCompleto: f.numeroCompleto,
    estadoDocumento: f.estadoDocumento,
    tipoFactura: f.tipoFactura,
    formaPago: f.formaPago,
    tipoRectificativa: f.tipoRectificativa ?? undefined,
    motivoRectificacion: f.motivoRectificacion ?? undefined,
    finalizadaEn: f.finalizadaEn ?? undefined,
    fechaEmision: f.fechaEmision,
    fechaVencimiento: f.fechaVencimiento,
    estado: f.estado,
    baseTotal: f.baseTotal,
    ivaTotal: f.ivaTotal,
    retencionTotal: f.retencionTotal,
    totalFactura: f.totalFactura,
    plantillaId: f.plantillaId,
    observaciones: f.observaciones ?? undefined,
    esRectificativa: f.esRectificativa,
    facturaOriginalId: f.facturaOriginalId ?? undefined,
    esRecurrente: f.esRecurrente,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    lineas: f.lineas.map((l) => ({
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
      productoServicioId: l.productoServicioId ?? undefined,
    })),
  };
}

/**
 * Resuelve o crea el cliente. Retorna el customerId.
 */
async function resolverCliente(
  companyId: string,
  customerData: CrearFacturaIngresoDTO['customer'] | undefined,
): Promise<string> {
  if (customerData?.id) {
    // Verificar que existe y pertenece a esta empresa
    const exists = await prisma.customer.findFirst({
      where: { id: customerData.id, companyId },
    });
    if (!exists) throw badRequest('Cliente no encontrado.');
    return customerData.id;
  }

  // Crear cliente nuevo
  if (!customerData?.nuevo?.nombreFiscal || !customerData?.nuevo?.nifCif) {
    throw badRequest('Elige un cliente o indica el nombre fiscal y el NIF del cliente nuevo.');
  }

  const n = customerData.nuevo;
  const customer = await prisma.customer.create({
    data: {
      companyId,
      nombreFiscal: n.nombreFiscal,
      nifCif: n.nifCif.replace(/[\s-]/g, '').toUpperCase(),
      direccion: n.direccion,
      pais: n.pais || 'ES',
      provincia: n.provincia,
      municipio: n.municipio,
      cp: n.cp,
      email: n.email,
    },
  });

  return customer.id;
}

/** Comprueba las lineas antes de guardarlas: una factura con datos absurdos no se emite. */
function validarLineas(lineas: CrearLineaIngresoDTO[] | undefined): CrearLineaIngresoDTO[] {
  if (!Array.isArray(lineas) || lineas.length === 0) {
    throw badRequest('La factura necesita al menos una línea.');
  }
  lineas.forEach((l, i) => {
    const n = i + 1;
    if (!l || !String(l.descripcion ?? '').trim()) throw badRequest(`Línea ${n}: falta la descripción.`);
    if (!Number.isFinite(Number(l.cantidad)) || Number(l.cantidad) === 0) {
      throw badRequest(`Línea ${n}: la cantidad debe ser un número distinto de cero.`);
    }
    if (!Number.isFinite(Number(l.precioUnitario))) throw badRequest(`Línea ${n}: el precio no es un número.`);
    const iva = l.tipoIva ?? 21;
    if (!TIPOS_IVA.includes(Number(iva))) {
      throw badRequest(`Línea ${n}: el IVA debe ser uno de ${TIPOS_IVA.join(', ')} %.`);
    }
    const desc = l.descuentoPorcentaje ?? 0;
    if (!Number.isFinite(Number(desc)) || desc < 0 || desc > 100) {
      throw badRequest(`Línea ${n}: el descuento debe estar entre 0 y 100 %.`);
    }
    const ret = l.tipoRetencion ?? 0;
    if (!Number.isFinite(Number(ret)) || ret < 0 || ret > 50) {
      throw badRequest(`Línea ${n}: la retención de IRPF no es válida.`);
    }
  });
  return lineas.map((l) => ({
    ...l,
    descripcion: String(l.descripcion).trim(),
    cantidad: Number(l.cantidad),
    precioUnitario: Number(l.precioUnitario),
    descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
    tipoIva: Number(l.tipoIva ?? 21),
    tipoRetencion: Number(l.tipoRetencion ?? 0),
  }));
}

/**
 * Calcula totales a partir de las líneas.
 */
function calcularTotales(lineas: CrearLineaIngresoDTO[]): {
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  lineasConTotales: Array<CrearLineaIngresoDTO & { baseLine: number; ivaImporte: number; retencionImporte: number; descuentoImporte: number }>;
} {
  let baseTotal = 0;
  let ivaTotal = 0;
  let retencionTotal = 0;

  const lineasConTotales = lineas.map((l) => {
    const tipoIva = l.tipoIva ?? 21;
    const tipoRetencion = l.tipoRetencion ?? 0;
    const descuentoPorcentaje = l.descuentoPorcentaje ?? 0;

    // Cálculo: cantidad × precio unitario
    const pvpSinDescuento = round2(l.cantidad * l.precioUnitario);
    const descuentoImporte = round2((pvpSinDescuento * descuentoPorcentaje) / 100);
    const baseLine = round2(pvpSinDescuento - descuentoImporte);

    const ivaImporte = round2((baseLine * tipoIva) / 100);
    const retencionImporte = round2((baseLine * tipoRetencion) / 100);

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

/** Datos de las lineas listos para `lineas: { create }`, y los totales de cabecera. */
function lineasYTotales(lineas: CrearLineaIngresoDTO[]) {
  const { baseTotal, ivaTotal, retencionTotal, totalFactura, lineasConTotales } = calcularTotales(lineas);
  return {
    totales: { baseTotal, ivaTotal, retencionTotal, totalFactura },
    crear: lineasConTotales.map((l) => ({
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
      productoServicioId: l.productoServicioId,
    })),
  };
}

/**
 * Determina el estado de la factura según la fecha de vencimiento.
 */
function determinarEstado(fechaVencimiento: string): string {
  return fechaVencimiento < hoyISO() ? 'OVERDUE' : 'PENDING';
}

function validarFecha(fecha: string, campo: string): string {
  const f = fecha.slice(0, 10);
  if (!FECHA_RE.test(f) || Number.isNaN(new Date(`${f}T00:00:00Z`).getTime())) {
    throw badRequest(`La ${campo} no es una fecha válida (AAAA-MM-DD).`);
  }
  return f;
}

function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function validarTipoFactura(tipo: string | undefined, porDefecto: TipoFactura): TipoFactura {
  const t = (tipo ?? porDefecto).toUpperCase();
  if (!(TIPOS_FACTURA as readonly string[]).includes(t)) {
    throw badRequest(`Tipo de factura no válido. Usa: ${TIPOS_FACTURA.join(', ')}.`);
  }
  return t as TipoFactura;
}

function validarFormaPago(forma: string | undefined): FormaPago {
  const f = (forma ?? 'TRANSFERENCIA').toUpperCase();
  if (!(FORMAS_PAGO as readonly string[]).includes(f)) {
    throw badRequest(`Forma de pago no válida. Usa: ${FORMAS_PAGO.join(', ')}.`);
  }
  return f as FormaPago;
}

/** Serie elegida en el DTO (o la por defecto), creandola si es un codigo antiguo. */
async function resolverSerie(companyId: string, codigo: string | undefined, esRectificativa: boolean): Promise<string> {
  if (esRectificativa && !codigo) {
    const r = await obtenerSeriePorDefecto(companyId, 'RECTIFICATIVA');
    if (!r) throw badRequest('No hay serie de rectificativas configurada.');
    return r.codigo;
  }
  if (!codigo) return resolverCodSerieFactura(companyId, {});
  const serie = await obtenerOCrearSerie(companyId, String(codigo).trim());
  if (!serie.activa) throw badRequest(`La serie ${serie.codigo} está desactivada.`);
  if (esRectificativa && serie.tipoDocumento !== 'RECTIFICATIVA') {
    throw badRequest('Las rectificativas van en una serie propia de rectificativas, no en la de facturas.');
  }
  if (!esRectificativa && serie.tipoDocumento === 'RECTIFICATIVA') {
    throw badRequest(`La serie ${serie.codigo} es solo para rectificativas.`);
  }
  return serie.codigo;
}

/**
 * Asigna el siguiente numero de la serie DENTRO de la transaccion.
 *
 * El UPDATE ... SET ultimoNumero = ultimoNumero + 1 bloquea la fila de la serie
 * hasta el final de la transaccion: dos facturas que se finalizan a la vez
 * reciben numeros seguidos, y si algo falla despues el numero se devuelve
 * (rollback), asi que no quedan huecos.
 *
 * La fecha de emision no puede ser anterior a la de la ultima factura de la
 * serie: la numeracion tiene que ir en el mismo orden que las fechas.
 */
async function asignarNumero(tx: Tx, companyId: string, serie: string, fechaEmision: string): Promise<number> {
  // Facturas anteriores a la tabla de series: el contador arranca en el mayor numero que ya exista.
  const max = await tx.incomeInvoice.aggregate({ where: { companyId, serie }, _max: { numero: true } });
  const mayorExistente = max._max.numero ?? 0;
  await tx.invoiceSeries.updateMany({
    where: { companyId, codigo: serie, ultimoNumero: { lt: mayorExistente } },
    data: { ultimoNumero: mayorExistente },
  });

  const s = await tx.invoiceSeries.update({
    where: { companyId_codigo: { companyId, codigo: serie } },
    data: { ultimoNumero: { increment: 1 } },
  });
  if (s.ultimaFecha && fechaEmision < s.ultimaFecha) {
    throw badRequest(
      `La fecha de emisión (${fechaEmision}) no puede ser anterior a la de la última factura de la serie ${serie} (${s.ultimaFecha}).`,
    );
  }
  await tx.invoiceSeries.update({ where: { id: s.id }, data: { ultimaFecha: fechaEmision } });
  return s.ultimoNumero;
}

/** Carga una factura de la empresa con sus lineas, o 404. */
async function cargar(companyId: string, id: string): Promise<FacturaConLineas> {
  const factura = await buscarConLineas(companyId, id);
  if (!factura) throw notFound('Factura no encontrada.');
  return factura;
}

function exigirBorrador(f: FacturaConLineas, accion: string): void {
  if (f.estadoDocumento !== ESTADO_BORRADOR) {
    throw badRequest(
      `La factura ${f.numeroCompleto ?? ''} ya está emitida y no se puede ${accion}. Para corregirla, haz una factura rectificativa.`,
    );
  }
}

export const incomeInvoicesService = {
  /**
   * Crear factura de venta: como borrador (sin numero) o ya emitida.
   */
  async crearIngreso(dto: CrearFacturaIngresoDTO): Promise<IncomeInvoiceResp> {
    const lineas = validarLineas(dto.lineas);
    const esRectificativa = !!dto.facturaOriginalId;
    const tipoFactura = validarTipoFactura(dto.tipoFactura, esRectificativa ? 'R1' : 'F1');
    if (esRectificativa !== tipoFactura.startsWith('R')) {
      throw badRequest('Una factura rectificativa debe ser de tipo R1 a R5, y solo las rectificativas pueden serlo.');
    }

    const customerId = await resolverCliente(dto.companyId, dto.customer);
    const serie = await resolverSerie(dto.companyId, dto.serie, esRectificativa);

    const fechaEmision = validarFecha(dto.fechaEmision ?? hoyISO(), 'fecha de emisión');
    const fechaVencimiento = validarFecha(dto.fechaVencimiento ?? sumarDias(fechaEmision, 15), 'fecha de vencimiento');
    if (fechaVencimiento < fechaEmision) throw badRequest('El vencimiento no puede ser anterior a la fecha de emisión.');

    const { totales, crear } = lineasYTotales(lineas);
    const comunes = {
      companyId: dto.companyId,
      customerId,
      serie,
      fechaEmision,
      fechaVencimiento,
      tipoFactura,
      formaPago: validarFormaPago(dto.formaPago),
      ...totales,
      plantillaId: dto.plantillaId || 'default',
      observaciones: dto.observaciones,
      esRectificativa,
      facturaOriginalId: dto.facturaOriginalId,
      tipoRectificativa: esRectificativa ? (dto.tipoRectificativa ?? 'I') : null,
      motivoRectificacion: esRectificativa ? dto.motivoRectificacion : null,
      lineas: { create: crear },
    };

    // Borrador: sin numero, no cuenta para nada hasta que se finalice.
    if (dto.borrador) {
      const factura = await prisma.incomeInvoice.create({
        data: { ...comunes, estadoDocumento: ESTADO_BORRADOR, estado: 'DRAFT' },
        include: { lineas: true },
      });
      return aRespuesta(factura);
    }

    // Factura emitida fuera de la app (lector): conserva su numero original.
    if (dto.numero) {
      const existe = await prisma.incomeInvoice.findFirst({ where: { companyId: dto.companyId, serie, numero: dto.numero } });
      if (existe) throw badRequest(`La factura ${serie}-${dto.numero} ya existe.`);
      const factura = await prisma.incomeInvoice.create({
        data: {
          ...comunes,
          numero: dto.numero,
          numeroCompleto: `${serie}-${dto.numero}`,
          estadoDocumento: ESTADO_FINAL,
          finalizadaEn: new Date(),
          estado: determinarEstado(fechaVencimiento),
        },
        include: { lineas: true },
      });
      await prisma.invoiceSeries.updateMany({
        where: { companyId: dto.companyId, codigo: serie, ultimoNumero: { lt: dto.numero } },
        data: { ultimoNumero: dto.numero },
      });
      return aRespuesta(factura);
    }

    // Emision directa: numero de la serie en la misma transaccion.
    const factura = await prisma.$transaction(async (tx) => {
      const numero = await asignarNumero(tx, dto.companyId, serie, fechaEmision);
      return tx.incomeInvoice.create({
        data: {
          ...comunes,
          numero,
          numeroCompleto: `${serie}-${numero}`,
          estadoDocumento: ESTADO_FINAL,
          finalizadaEn: new Date(),
          estado: determinarEstado(fechaVencimiento),
        },
        include: { lineas: true },
      });
    });
    return aRespuesta(factura);
  },

  /** Modifica un borrador. Una factura emitida no se toca. */
  async actualizarBorrador(companyId: string, id: string, dto: ActualizarBorradorDTO): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirBorrador(actual, 'modificar');

    const data: Prisma.IncomeInvoiceUncheckedUpdateInput = {};
    if (dto.customer) data.customerId = await resolverCliente(companyId, dto.customer);
    if (dto.serie !== undefined) data.serie = await resolverSerie(companyId, dto.serie, actual.esRectificativa);
    if (dto.tipoFactura !== undefined) {
      const t = validarTipoFactura(dto.tipoFactura, 'F1');
      if (actual.esRectificativa !== t.startsWith('R')) throw badRequest('El tipo no corresponde a esta factura.');
      data.tipoFactura = t;
    }
    if (dto.observaciones !== undefined) data.observaciones = dto.observaciones;
    if (dto.formaPago !== undefined) data.formaPago = validarFormaPago(dto.formaPago);
    if (dto.plantillaId !== undefined) data.plantillaId = dto.plantillaId;
    const fechaEmision = dto.fechaEmision ? validarFecha(dto.fechaEmision, 'fecha de emisión') : actual.fechaEmision;
    const fechaVencimiento = dto.fechaVencimiento
      ? validarFecha(dto.fechaVencimiento, 'fecha de vencimiento')
      : actual.fechaVencimiento;
    if (fechaVencimiento < fechaEmision) throw badRequest('El vencimiento no puede ser anterior a la fecha de emisión.');
    data.fechaEmision = fechaEmision;
    data.fechaVencimiento = fechaVencimiento;

    const factura = await prisma.$transaction(async (tx) => {
      if (dto.lineas) {
        const { totales, crear } = lineasYTotales(validarLineas(dto.lineas));
        await tx.incomeInvoiceLine.deleteMany({ where: { invoiceId: id } });
        Object.assign(data, totales, { lineas: { create: crear } });
      }
      return tx.incomeInvoice.update({ where: { id }, data, include: { lineas: true } });
    });
    return aRespuesta(factura);
  },

  /** Borra un borrador. Las facturas emitidas no se borran nunca. */
  async eliminarBorrador(companyId: string, id: string): Promise<void> {
    const actual = await cargar(companyId, id);
    exigirBorrador(actual, 'borrar');
    await prisma.incomeInvoice.delete({ where: { id } });
  },

  /**
   * Emite un borrador: le da el siguiente numero de su serie y congela sus datos.
   * La fecha de emision es la indicada o, si no, hoy.
   */
  async finalizar(companyId: string, id: string, opciones: { fechaEmision?: string } = {}): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirBorrador(actual, 'volver a emitir');
    // Art. 6 RD 1619/2012: la factura lleva el nombre y el NIF del emisor.
    const emisor = await prisma.legalConfig.findUnique({ where: { companyId } });
    if (!emisor?.nif?.trim() || !emisor?.denominacion?.trim()) {
      throw badRequest(
        'Antes de emitir facturas rellena la denominación y el NIF de tu empresa en Registro Mercantil > Datos para la memoria.',
      );
    }
    if (actual.lineas.length === 0) throw badRequest('La factura no tiene líneas.');
    if (actual.esRectificativa && !actual.motivoRectificacion?.trim()) {
      throw badRequest('Indica el motivo de la rectificación antes de emitirla.');
    }

    const fechaEmision = validarFecha(opciones.fechaEmision ?? hoyISO(), 'fecha de emisión');
    // Se mantienen los dias de plazo que tenia el borrador.
    const plazo = Math.max(
      0,
      Math.round(
        (new Date(`${actual.fechaVencimiento}T00:00:00Z`).getTime() - new Date(`${actual.fechaEmision}T00:00:00Z`).getTime()) /
          86_400_000,
      ),
    );
    const fechaVencimiento = sumarDias(fechaEmision, plazo);

    const factura = await prisma.$transaction(async (tx) => {
      const numero = await asignarNumero(tx, companyId, actual.serie, fechaEmision);
      // Solo se finaliza si sigue en borrador (otra peticion podria haberse adelantado).
      const r = await tx.incomeInvoice.updateMany({
        where: { id, estadoDocumento: ESTADO_BORRADOR },
        data: {
          numero,
          numeroCompleto: `${actual.serie}-${numero}`,
          estadoDocumento: ESTADO_FINAL,
          finalizadaEn: new Date(),
          fechaEmision,
          fechaVencimiento,
          estado: determinarEstado(fechaVencimiento),
        },
      });
      if (r.count !== 1) throw badRequest('La factura ya se había emitido.');
      return tx.incomeInvoice.findUniqueOrThrow({ where: { id }, include: { lineas: true } });
    });
    return aRespuesta(factura);
  },

  /** Copia una factura (emitida o no) en un borrador nuevo, con fecha de hoy. */
  async duplicar(companyId: string, id: string): Promise<IncomeInvoiceResp> {
    const o = await cargar(companyId, id);
    if (o.esRectificativa) throw badRequest('Las rectificativas no se duplican; crea una nueva desde la factura original.');
    const plazo = Math.max(
      0,
      Math.round(
        (new Date(`${o.fechaVencimiento}T00:00:00Z`).getTime() - new Date(`${o.fechaEmision}T00:00:00Z`).getTime()) / 86_400_000,
      ),
    );
    const hoy = hoyISO();
    return this.crearIngreso({
      companyId,
      customer: { id: o.customerId },
      serie: o.serie,
      fechaEmision: hoy,
      fechaVencimiento: sumarDias(hoy, plazo),
      tipoFactura: o.tipoFactura as TipoFactura,
      formaPago: o.formaPago as FormaPago,
      plantillaId: o.plantillaId,
      observaciones: o.observaciones ?? undefined,
      borrador: true,
      lineas: o.lineas.map((l) => ({
        descripcion: l.descripcion,
        cantidad: l.cantidad,
        precioUnitario: l.precioUnitario,
        descuentoPorcentaje: l.descuentoPorcentaje,
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
        productoServicioId: l.productoServicioId ?? undefined,
      })),
    });
  },

  /**
   * Listar facturas de ingreso con filtros.
   */
  async listar(
    companyId: string,
    filtros?: {
      estado?: string;
      estadoDocumento?: string;
      customerId?: string;
      desde?: string;
      hasta?: string;
      skip?: number;
      take?: number;
    },
  ) {
    const skip = filtros?.skip ?? 0;
    const take = filtros?.take ?? 20;

    const where: Prisma.IncomeInvoiceWhereInput = { companyId };
    if (filtros?.estado) where.estado = filtros.estado;
    if (filtros?.estadoDocumento) where.estadoDocumento = filtros.estadoDocumento;
    if (filtros?.customerId) where.customerId = filtros.customerId;
    if (filtros?.desde || filtros?.hasta) {
      where.fechaEmision = {
        ...(filtros.desde ? { gte: filtros.desde } : {}),
        ...(filtros.hasta ? { lte: filtros.hasta } : {}),
      };
    }

    const [items, total] = await Promise.all([
      prisma.incomeInvoice.findMany({
        where,
        include: { customer: true },
        // Los borradores primero (no tienen numero), luego por fecha y numero.
        orderBy: [{ estadoDocumento: 'asc' }, { fechaEmision: 'desc' }, { numero: 'desc' }],
        skip,
        take,
      }),
      prisma.incomeInvoice.count({ where }),
    ]);

    return {
      items: items.map((f) => ({
        id: f.id,
        companyId: f.companyId,
        customerId: f.customerId,
        customerNombre: f.customer.nombreFiscal,
        serie: f.serie,
        numero: f.numero,
        numeroCompleto: f.numeroCompleto,
        estadoDocumento: f.estadoDocumento,
        tipoFactura: f.tipoFactura,
        formaPago: f.formaPago,
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        estado: f.estado,
        baseTotal: f.baseTotal,
        ivaTotal: f.ivaTotal,
        retencionTotal: f.retencionTotal,
        totalFactura: f.totalFactura,
        esRectificativa: f.esRectificativa,
        facturaOriginalId: f.facturaOriginalId,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
      total,
      skip,
      take,
    };
  },

  /**
   * Obtener una factura por ID.
   */
  async obtenerPorId(companyId: string, id: string): Promise<IncomeInvoiceResp> {
    return aRespuesta(await cargar(companyId, id));
  },

  /**
   * Cambiar el estado de COBRO de una factura emitida (PENDING, PAID, OVERDUE).
   * Emitir un borrador es `finalizar`, no un cambio de estado.
   *
   * PAID registra un cobro de verdad (con su asiento) por lo pendiente: con la
   * fecha, cuenta bancaria o caja y nota que vengan, o con fecha de hoy y la
   * primera cuenta bancaria activa. Volver a PENDING/OVERDUE solo se puede si
   * no hay cobros registrados (si los hay, se anulan desde la factura).
   */
  async cambiarEstado(companyId: string, id: string, nuevoEstado: string, datosCobro: DatosCobro = {}): Promise<IncomeInvoiceResp> {
    if (!(ESTADOS_COBRO as readonly string[]).includes(nuevoEstado)) {
      throw badRequest(`Estado no válido. Usa: ${ESTADOS_COBRO.join(', ')}.`);
    }
    const factura = await cargar(companyId, id);
    if (factura.estadoDocumento !== ESTADO_FINAL) {
      throw badRequest('La factura está en borrador: emítela antes de marcar el cobro.');
    }
    if (nuevoEstado === 'PAID') {
      const { importePendiente } = await listarCobros(companyId, 'INGRESO', id);
      if (importePendiente > 0) {
        await registrarCobroFactura(companyId, 'INGRESO', id, { ...datosCobro, importe: undefined });
      }
      return aRespuesta(await cargar(companyId, id));
    }
    if (await tieneCobrosActivos(companyId, 'INGRESO', id)) {
      throw badRequest('La factura tiene cobros registrados: para dejarla pendiente, anula esos cobros desde la ficha de la factura.');
    }
    const actualizada = await prisma.incomeInvoice.update({
      where: { id },
      data: { estado: nuevoEstado },
      include: { lineas: true },
    });
    return aRespuesta(actualizada);
  },

  /**
   * Crear factura rectificativa de una factura emitida, en la serie de
   * rectificativas. Por defecto es "por diferencias" (I) y anula la original
   * entera (lineas en negativo); con `lineas` se rectifica solo una parte.
   */
  async crearRectificativa(
    companyId: string,
    facturaOriginalId: string,
    opciones: {
      motivo?: string;
      lineas?: CrearLineaIngresoDTO[];
      tipoFactura?: TipoFactura;
      tipoRectificativa?: 'S' | 'I';
      serie?: string;
      borrador?: boolean;
    } = {},
  ): Promise<IncomeInvoiceResp> {
    const original = await cargar(companyId, facturaOriginalId);
    if (original.estadoDocumento !== ESTADO_FINAL) {
      throw badRequest('Un borrador no se rectifica: modifícalo directamente.');
    }
    const motivo = opciones.motivo?.trim();
    if (!motivo) throw badRequest('Indica el motivo de la rectificación.');
    const tipoRectificativa = opciones.tipoRectificativa ?? 'I';
    if (!['S', 'I'].includes(tipoRectificativa)) throw badRequest('Tipo de rectificativa no válido: S (sustitución) o I (diferencias).');
    if (tipoRectificativa === 'S' && !opciones.lineas?.length) {
      throw badRequest('Una rectificativa por sustitución necesita las líneas correctas de la factura.');
    }

    const lineas =
      opciones.lineas ??
      original.lineas.map((l) => ({
        descripcion: l.descripcion,
        cantidad: -l.cantidad,
        precioUnitario: l.precioUnitario,
        descuentoPorcentaje: l.descuentoPorcentaje,
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
        productoServicioId: l.productoServicioId ?? undefined,
      }));

    return this.crearIngreso({
      companyId,
      customer: { id: original.customerId },
      serie: opciones.serie,
      lineas,
      tipoFactura: opciones.tipoFactura ?? 'R1',
      formaPago: original.formaPago as FormaPago,
      tipoRectificativa,
      motivoRectificacion: motivo,
      observaciones: `Rectifica la factura ${original.numeroCompleto} de ${original.fechaEmision}. Motivo: ${motivo}`,
      facturaOriginalId: original.id,
      borrador: opciones.borrador,
    });
  },

  /**
   * Obtener resumen de ingresos por período (para el dashboard).
   * Solo facturas emitidas: los borradores no son ventas todavía.
   */
  async resumenPorPeriodo(companyId: string, desde?: string, hasta?: string) {
    const where: Prisma.IncomeInvoiceWhereInput = { companyId, estadoDocumento: ESTADO_FINAL };
    if (desde || hasta) {
      where.fechaEmision = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) };
    }

    const facturas = await prisma.incomeInvoice.findMany({
      where,
      select: {
        estado: true,
        baseTotal: true,
        ivaTotal: true,
        retencionTotal: true,
        totalFactura: true,
      },
    });

    let baseCobrada = 0;
    let basePendiente = 0;
    let baseVencida = 0;
    let ivaTotal = 0;
    let retencionTotal = 0;

    facturas.forEach((f) => {
      if (f.estado === 'PAID') baseCobrada += f.baseTotal;
      // ACCOUNTED: facturas contabilizadas antes de que el estado de cobro se
      // separara de la contabilidad; siguen pendientes de cobro.
      else if (f.estado === 'PENDING' || f.estado === 'ACCOUNTED') basePendiente += f.baseTotal;
      else if (f.estado === 'OVERDUE') baseVencida += f.baseTotal;
      ivaTotal += f.ivaTotal;
      retencionTotal += f.retencionTotal;
    });

    return {
      totalFacturas: facturas.length,
      baseCobrada: round2(baseCobrada),
      basePendiente: round2(basePendiente),
      baseVencida: round2(baseVencida),
      ivaTotal: round2(ivaTotal),
      ivaAIngresar: baseCobrada > 0 ? round2(ivaTotal) : 0,
      ivaADevolver: baseCobrada === 0 && ivaTotal < 0 ? round2(Math.abs(ivaTotal)) : 0,
      irpfTotal: round2(retencionTotal),
    };
  },
};
