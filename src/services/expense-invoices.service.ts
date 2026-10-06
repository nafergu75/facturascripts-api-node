import { prisma } from '../config/database';
import { badRequest, notFound } from '../utils/http-errors';

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
  const supplier = await prisma.supplier.create({
    data: {
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
    },
  });

  return supplier.id;
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
 * Calcula totales a partir de las líneas de gasto.
 */
function calcularTotales(lineas: CrearLineaGastoDTO[]): {
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
 * Determina el estado de una factura de gasto según su fecha de vencimiento.
 */
function determinarEstado(fechaVencimiento: string): string {
  const hoy = new Date().toISOString().slice(0, 10);
  return fechaVencimiento < hoy ? 'OVERDUE' : 'PENDING';
}

export const expenseInvoicesService = {
  /**
   * Crear factura de gasto completa.
   */
  async crearGasto(dto: CrearFacturaGastoDTO): Promise<ExpenseInvoiceResp> {
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
    const fechaEmision = (dto.fechaEmision ?? new Date().toISOString().slice(0, 10)).slice(0, 10);
    const fechaVencimiento = (
      dto.fechaVencimiento ??
      (() => {
        const d = new Date(fechaEmision);
        d.setDate(d.getDate() + 30);
        return d.toISOString().slice(0, 10);
      })()
    ).slice(0, 10);

    // 4) Calcular totales
    const { baseTotal, ivaTotal, retencionTotal, totalFactura, lineasConTotales } = calcularTotales(lineas);

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
        retencionTotal,
        totalFactura,
        observaciones: dto.observaciones,
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
  },

  /**
   * Listar facturas de gasto con filtros.
   */
  async listarGastos(
    companyId: string,
    filtros?: {
      estado?: string;
      supplierId?: string;
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
    if (filtros?.supplierId) where.supplierId = filtros.supplierId;
    if (filtros?.desde || filtros?.hasta) {
      where.fechaEmision = {};
      if (filtros.desde) (where.fechaEmision as Record<string, unknown>).gte = filtros.desde;
      if (filtros.hasta) (where.fechaEmision as Record<string, unknown>).lte = filtros.hasta;
    }

    const [items, total] = await Promise.all([
      prisma.expenseInvoice.findMany({
        where,
        include: { lineas: true, supplier: true },
        orderBy: { fechaEmision: 'desc' },
        skip,
        take,
      }),
      prisma.expenseInvoice.count({ where }),
    ]);

    return {
      items: items.map((f) => ({
        id: f.id,
        companyId: f.companyId,
        supplierId: f.supplierId,
        supplierNombre: f.supplier.nombreFiscal,
        serie: f.serie,
        numero: f.numero,
        numeroCompleto: f.numeroCompleto,
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        estado: f.estado,
        tipoGasto: f.tipoGasto,
        baseTotal: f.baseTotal,
        ivaTotal: f.ivaTotal,
        retencionTotal: f.retencionTotal,
        totalFactura: f.totalFactura,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
      total,
      skip,
      take,
    };
  },

  /**
   * Obtener una factura de gasto por ID.
   */
  async obtenerPorId(companyId: string, id: string): Promise<ExpenseInvoiceResp> {
    const factura = await prisma.expenseInvoice.findFirst({
      where: { id, companyId },
      include: { lineas: true },
    });

    if (!factura) throw notFound('Factura de gasto no encontrada.');

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
  },

  /**
   * Cambiar estado de la factura de gasto.
   */
  async cambiarEstado(
    companyId: string,
    id: string,
    nuevoEstado: string,
  ): Promise<ExpenseInvoiceResp> {
    const factura = await prisma.expenseInvoice.findFirst({
      where: { id, companyId },
      include: { lineas: true },
    });

    if (!factura) throw notFound('Factura de gasto no encontrada.');

    const actualizada = await prisma.expenseInvoice.update({
      where: { id },
      data: { estado: nuevoEstado },
      include: { lineas: true },
    });

    return {
      id: actualizada.id,
      companyId: actualizada.companyId,
      supplierId: actualizada.supplierId,
      serie: actualizada.serie,
      numero: actualizada.numero,
      numeroCompleto: actualizada.numeroCompleto,
      fechaEmision: actualizada.fechaEmision,
      fechaVencimiento: actualizada.fechaVencimiento,
      estado: actualizada.estado,
      tipoGasto: actualizada.tipoGasto,
      baseTotal: actualizada.baseTotal,
      ivaTotal: actualizada.ivaTotal,
      retencionTotal: actualizada.retencionTotal,
      totalFactura: actualizada.totalFactura,
      observaciones: actualizada.observaciones ?? undefined,
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
};
