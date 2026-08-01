import { badRequest, notFound } from '../utils/http-errors';
import { prisma } from '../config/database';

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
  serie: string; // Ej: "2024"
  numero?: number; // Opcional, se autoincrementa si no se indica
  fechaEmision?: string; // YYYY-MM-DD, defecto: hoy
  fechaVencimiento?: string; // YYYY-MM-DD, defecto: fechaEmision + 15 días
  lineas: CrearLineaIngresoDTO[];
  plantillaId?: string; // Defecto: "default"
  observaciones?: string;
  facturaOriginalId?: string; // Si es rectificativa
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

export interface IncomeInvoiceResp {
  id: string;
  companyId: string;
  customerId: string;
  serie: string;
  numero: number;
  numeroCompleto: string;
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
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Resuelve o crea el cliente. Retorna el customerId.
 */
async function resolverCliente(
  companyId: string,
  customerData: CrearFacturaIngresoDTO['customer'],
): Promise<string> {
  if (customerData.id) {
    // Verificar que existe
    const exists = await prisma.customer.findUnique({
      where: { id: customerData.id },
    });
    if (!exists) throw badRequest('Cliente no encontrado.');
    return customerData.id;
  }

  // Crear cliente nuevo
  if (!customerData.nuevo?.nombreFiscal || !customerData.nuevo?.nifCif) {
    throw badRequest('Indica customer.id o customer.nuevo con nombreFiscal y nifCif.');
  }

  const n = customerData.nuevo;
  const customer = await prisma.customer.create({
    data: {
      companyId,
      nombreFiscal: n.nombreFiscal,
      nifCif: n.nifCif,
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

/**
 * Resuelve el siguiente número de factura para una serie.
 */
async function resolverNumeroFactura(companyId: string, serie: string, numeroSugerido?: number): Promise<number> {
  if (numeroSugerido) {
    // Verificar que no exista ya
    const exists = await prisma.incomeInvoice.findFirst({
      where: { companyId, serie, numero: numeroSugerido },
    });
    if (exists) throw badRequest(`Factura ${serie}-${numeroSugerido} ya existe.`);
    return numeroSugerido;
  }

  // Autoincremento: buscar el último número de esa serie
  const ultima = await prisma.incomeInvoice.findFirst({
    where: { companyId, serie },
    orderBy: { numero: 'desc' },
  });

  return (ultima?.numero ?? 0) + 1;
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

/**
 * Determina el estado de la factura según la fecha de vencimiento.
 */
function determinarEstado(fechaVencimiento: string): string {
  const hoy = new Date().toISOString().slice(0, 10);
  return fechaVencimiento < hoy ? 'OVERDUE' : 'PENDING';
}

export const incomeInvoicesService = {
  /**
   * Crear factura de ingreso completa.
   */
  async crearIngreso(dto: CrearFacturaIngresoDTO): Promise<IncomeInvoiceResp> {
    // En desarrollo, si no hay líneas, crear una automáticamente del concepto/descripción
    let lineas = dto.lineas;
    if (!lineas || lineas.length === 0) {
      // Buscar si hay datos en el payload para crear línea automáticamente
      const anyDto = dto as any;
      const descripcion = anyDto.description || anyDto.concepto || 'Servicio general';
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

    // 1) Resolver cliente
    const customerId = await resolverCliente(dto.companyId, dto.customer);

    // 2) Resolver numeración
    const numero = await resolverNumeroFactura(dto.companyId, dto.serie, dto.numero);
    const numeroCompleto = `${dto.serie}-${numero}`;

    // 3) Resolver fechas
    const fechaEmision = (dto.fechaEmision ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    const fechaVencimiento = (
      dto.fechaVencimiento ??
      (() => {
        const d = new Date(fechaEmision);
        d.setDate(d.getDate() + 15);
        return d.toISOString().slice(0, 10);
      })()
    ).slice(0, 10);

    // 4) Calcular totales
    const { baseTotal, ivaTotal, retencionTotal, totalFactura, lineasConTotales } = calcularTotales(dto.lineas);

    // 5) Crear factura en BD
    const factura = await prisma.incomeInvoice.create({
      data: {
        companyId: dto.companyId,
        customerId,
        serie: dto.serie,
        numero,
        numeroCompleto,
        fechaEmision,
        fechaVencimiento,
        estado: determinarEstado(fechaVencimiento),
        baseTotal,
        ivaTotal,
        retencionTotal,
        totalFactura,
        plantillaId: dto.plantillaId || 'default',
        observaciones: dto.observaciones,
        esRectificativa: !!dto.facturaOriginalId,
        facturaOriginalId: dto.facturaOriginalId,
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
            productoServicioId: l.productoServicioId,
          })),
        },
      },
      include: { lineas: true },
    });

    // 6) Mapear respuesta
    return {
      id: factura.id,
      companyId: factura.companyId,
      customerId: factura.customerId,
      serie: factura.serie,
      numero: factura.numero,
      numeroCompleto: factura.numeroCompleto,
      fechaEmision: factura.fechaEmision,
      fechaVencimiento: factura.fechaVencimiento,
      estado: factura.estado,
      baseTotal: factura.baseTotal,
      ivaTotal: factura.ivaTotal,
      retencionTotal: factura.retencionTotal,
      totalFactura: factura.totalFactura,
      plantillaId: factura.plantillaId,
      observaciones: factura.observaciones ?? undefined,
      esRectificativa: factura.esRectificativa,
      facturaOriginalId: factura.facturaOriginalId ?? undefined,
      esRecurrente: factura.esRecurrente,
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
  },

  /**
   * Listar facturas de ingreso con filtros.
   */
  async listar(
    companyId: string,
    filtros?: {
      estado?: string;
      customerId?: string;
      desde?: string;
      hasta?: string;
      skip?: number;
      take?: number;
    },
  ) {
    const skip = filtros?.skip ?? 0;
    const take = filtros?.take ?? 20;

    const where: Record<string, unknown> = { companyId };
    if (filtros?.estado) where.estado = filtros.estado;
    if (filtros?.customerId) where.customerId = filtros.customerId;
    if (filtros?.desde || filtros?.hasta) {
      where.fechaEmision = {};
      if (filtros.desde) (where.fechaEmision as Record<string, unknown>).gte = filtros.desde;
      if (filtros.hasta) (where.fechaEmision as Record<string, unknown>).lte = filtros.hasta;
    }

    const [items, total] = await Promise.all([
      prisma.incomeInvoice.findMany({
        where,
        include: { lineas: true, customer: true },
        orderBy: { fechaEmision: 'desc' },
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
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        estado: f.estado,
        baseTotal: f.baseTotal,
        ivaTotal: f.ivaTotal,
        retencionTotal: f.retencionTotal,
        totalFactura: f.totalFactura,
        esRectificativa: f.esRectificativa,
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
    const factura = await prisma.incomeInvoice.findFirst({
      where: { id, companyId },
      include: { lineas: true },
    });

    if (!factura) throw notFound('Factura no encontrada.');

    return {
      id: factura.id,
      companyId: factura.companyId,
      customerId: factura.customerId,
      serie: factura.serie,
      numero: factura.numero,
      numeroCompleto: factura.numeroCompleto,
      fechaEmision: factura.fechaEmision,
      fechaVencimiento: factura.fechaVencimiento,
      estado: factura.estado,
      baseTotal: factura.baseTotal,
      ivaTotal: factura.ivaTotal,
      retencionTotal: factura.retencionTotal,
      totalFactura: factura.totalFactura,
      plantillaId: factura.plantillaId,
      observaciones: factura.observaciones ?? undefined,
      esRectificativa: factura.esRectificativa,
      facturaOriginalId: factura.facturaOriginalId ?? undefined,
      esRecurrente: factura.esRecurrente,
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
  },

  /**
   * Cambiar estado de la factura (ej. PENDING -> PAID).
   */
  async cambiarEstado(
    companyId: string,
    id: string,
    nuevoEstado: string,
  ): Promise<IncomeInvoiceResp> {
    const factura = await prisma.incomeInvoice.findFirst({
      where: { id, companyId },
      include: { lineas: true },
    });

    if (!factura) throw notFound('Factura no encontrada.');

    const actualizada = await prisma.incomeInvoice.update({
      where: { id },
      data: { estado: nuevoEstado },
      include: { lineas: true },
    });

    return {
      id: actualizada.id,
      companyId: actualizada.companyId,
      customerId: actualizada.customerId,
      serie: actualizada.serie,
      numero: actualizada.numero,
      numeroCompleto: actualizada.numeroCompleto,
      fechaEmision: actualizada.fechaEmision,
      fechaVencimiento: actualizada.fechaVencimiento,
      estado: actualizada.estado,
      baseTotal: actualizada.baseTotal,
      ivaTotal: actualizada.ivaTotal,
      retencionTotal: actualizada.retencionTotal,
      totalFactura: actualizada.totalFactura,
      plantillaId: actualizada.plantillaId,
      observaciones: actualizada.observaciones ?? undefined,
      esRectificativa: actualizada.esRectificativa,
      facturaOriginalId: actualizada.facturaOriginalId ?? undefined,
      esRecurrente: actualizada.esRecurrente,
      createdAt: actualizada.createdAt,
      updatedAt: actualizada.updatedAt,
      lineas: actualizada.lineas.map((l) => ({
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
  },

  /**
   * Crear factura rectificativa (abono).
   */
  async crearRectificativa(
    companyId: string,
    facturaOriginalId: string,
    lineasOverride?: CrearLineaIngresoDTO[],
  ): Promise<IncomeInvoiceResp> {
    const original = await this.obtenerPorId(companyId, facturaOriginalId);

    let lineas = lineasOverride;
    if (!lineas) {
      // Negar las líneas originales
      lineas = original.lineas.map((l) => ({
        descripcion: l.descripcion,
        cantidad: -l.cantidad,
        precioUnitario: l.precioUnitario,
        descuentoPorcentaje: l.descuentoPorcentaje,
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
      }));
    }

    return this.crearIngreso({
      companyId,
      customer: { id: original.customerId },
      serie: original.serie,
      lineas,
      observaciones: `Rectificativa de ${original.numeroCompleto}`,
      facturaOriginalId: original.id,
    });
  },

  /**
   * Obtener resumen de ingresos por período (para el dashboard).
   */
  async resumenPorPeriodo(
    companyId: string,
    desde?: string,
    hasta?: string,
  ) {
    const where: Record<string, unknown> = { companyId };
    if (desde || hasta) {
      where.fechaEmision = {};
      if (desde) (where.fechaEmision as Record<string, unknown>).gte = desde;
      if (hasta) (where.fechaEmision as Record<string, unknown>).lte = hasta;
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
      else if (f.estado === 'PENDING') basePendiente += f.baseTotal;
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
