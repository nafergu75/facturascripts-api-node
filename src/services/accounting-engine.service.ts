/**
 * MOTOR CONTABLE AUTOMÁTICO - Basado en PGC Español
 *
 * Responsabilidades principales:
 * 1. Contabilizar facturas (ingresos y gastos) automáticamente
 * 2. Mantener libros de IVA y retenciones
 * 3. Generar borradores para Hacienda
 * 4. Alimentar informes y analíticas
 * 5. Integración con tesorería
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { badRequest, notFound, notImplemented } from '../utils/http-errors';
import { prisma } from '../config/database';

type DbClient = PrismaClient | Prisma.TransactionClient;

// ============================================================================
// TIPOS Y CONFIGURACIÓN
// ============================================================================

/**
 * Reglas de mapeo: Factura → Cuentas PGC
 *
 * Determina qué cuentas contables usar según tipo de operación, IVA, IRPF
 */
export const CONTABLE_RULES = {
  // FACTURAS DE INGRESO (VENTAS)
  VENTA_NACIONAL: {
    ingreso: '700', // Ventas de mercaderías
    clienteDeudor: '430', // Clientes
    ivaRepercutido: '477', // IVA repercutido
    // 473 = "HP retenciones y pagos a cuenta" (ACTIVO: Hacienda nos debe devolver).
    // 4751 sería PASIVO (nosotros debemos a Hacienda), que es el caso del GASTO, no del ingreso.
    irpfRetenido: '473',
  },
  VENTA_INTRACOMUNITARIA: {
    ingreso: '701', // Ventas intracomunitarias
    clienteDeudor: '430',
    ivaRepercutido: '477', // 0% IVA
    irpfRetenido: '473',
  },
  VENTA_EXPORTACION: {
    ingreso: '702', // Ventas exportación
    clienteDeudor: '430',
    ivaRepercutido: '477', // 0% IVA
    irpfRetenido: '473',
  },
  VENTA_EXENTA: {
    ingreso: '705', // Ventas exentas
    clienteDeudor: '430',
    ivaRepercutido: '477', // Sin IVA repercutido (0%)
    irpfRetenido: '473',
  },

  // FACTURAS DE GASTO (COMPRAS)
  COMPRA_NACIONAL: {
    gasto: '600', // Compra de mercaderías
    proveedorAcreedor: '400', // Proveedores
    ivaSoportado: '472', // IVA soportado
    irpfAsumido: '4751', // IRPF asumido
  },
  SERVICIO_PROFESIONAL: {
    gasto: '622', // Gastos de servicios profesionales
    proveedorAcreedor: '400',
    ivaSoportado: '472',
    irpfAsumido: '4751', // Generalmente 15%
  },
  ALQUILER: {
    gasto: '621', // Arrendamiento
    proveedorAcreedor: '400',
    ivaSoportado: '472',
    irpfAsumido: '4751',
  },
  SUMINISTROS: {
    gasto: '623', // Suministros
    proveedorAcreedor: '400',
    ivaSoportado: '472',
    irpfAsumido: '4751',
  },

  // TESORERÍA
  BANCO: {
    cuenta: '572', // Bancos e instituciones de crédito
  },
  CAJA: {
    cuenta: '570', // Caja
  },
};

// ============================================================================
// SERVICIOS DE CONTABILIZACIÓN
// ============================================================================

/**
 * Contabilizar una factura de ingreso (VENTA)
 *
 * Genera automáticamente:
 * - Asiento de ingresos + IVA repercutido
 * - Cuentas de clientes deudores
 * - Registra en libro de facturas emitidas
 */
export async function contabilizarFacturaIngreso(
  companyId: string,
  invoiceId: string,
  invoiceData: {
    baseTotal: number;
    ivaTotal: number;
    ivaRate: number; // 0, 4, 10, 21
    retencionTotal: number;
    retencionRate: number; // 0, 7, 15, 19
    totalFactura: number;
    fechaEmision: string;
    numeroFactura: string;
    clienteId: string;
    clienteNif: string;
    clienteNombre: string;
    tipoOperacion?: 'NACIONAL' | 'INTRACOMUNITARIA' | 'EXPORTACION' | 'EXENTA'; // default: NACIONAL
  },
  tx?: Prisma.TransactionClient,
): Promise<{ asientoId: string; lineas: any[] }> {
  const db: DbClient = tx ?? prisma;
  const tipoOp = invoiceData.tipoOperacion || 'NACIONAL';
  const regla = CONTABLE_RULES[`VENTA_${tipoOp}`];

  if (!regla) throw badRequest(`Tipo de operación desconocido: ${tipoOp}`);

  // Crear asiento
  const asiento = await db.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(invoiceData.fechaEmision),
      numeroAsiento: `FAC-ING-${invoiceData.numeroFactura}`,
      descripcion: `Factura de ingreso #${invoiceData.numeroFactura} - ${invoiceData.clienteNombre}`,
      origen: 'FACTURA_INGRESO',
      estado: 'DRAFT',
      invoiceId,
      invoiceType: 'INGRESO',
    },
  });

  // Crear líneas del asiento
  const lineas: any[] = [];
  let totalDebe = 0;
  let totalHaber = 0;

  // Línea 1: Deudor cliente (DEBE)
  const lineaCliente = await db.journalEntryLine.create({
    data: {
      entryId: asiento.id,
      accountCode: regla.clienteDeudor!,
      accountName: 'Clientes',
      debe: invoiceData.totalFactura,
      haber: 0,
      referencia: invoiceData.numeroFactura,
      companyId,
    },
  });
  lineas.push(lineaCliente);
  totalDebe += invoiceData.totalFactura;

  // Línea 2: Ingresos (HABER)
  const lineaIngreso = await db.journalEntryLine.create({
    data: {
      entryId: asiento.id,
      accountCode: regla.ingreso,
      accountName: 'Ventas',
      debe: 0,
      haber: invoiceData.baseTotal,
      referencia: invoiceData.numeroFactura,
      companyId,
    },
  });
  lineas.push(lineaIngreso);
  totalHaber += invoiceData.baseTotal;

  // Línea 3: IVA repercutido (HABER) - si aplica
  if (invoiceData.ivaTotal > 0) {
    const lineaIva = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.ivaRepercutido!,
        accountName: 'IVA repercutido',
        debe: 0,
        haber: invoiceData.ivaTotal,
        referencia: invoiceData.numeroFactura,
        companyId,
      },
    });
    lineas.push(lineaIva);
    totalHaber += invoiceData.ivaTotal;
  }

  // Línea 4: Retención IRPF (DEBE, cuenta 473 HP retenciones — ACTIVO).
  // El cliente nos retiene parte del pago y lo ingresa a Hacienda en nuestro nombre.
  // 473 = crédito frente a AEAT (nos lo devolverán o compensarán con el IS).
  if (invoiceData.retencionTotal > 0) {
    const lineaIrpf = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.irpfRetenido!,
        accountName: 'HP retenciones y pagos a cuenta',
        debe: invoiceData.retencionTotal,
        haber: 0,
        referencia: invoiceData.numeroFactura,
        companyId,
      },
    });
    lineas.push(lineaIrpf);
    totalDebe += invoiceData.retencionTotal;
  }

  // Validar que debe = haber (asiento equilibrado)
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    throw badRequest(
      `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`,
    );
  }

  // VATBook: se registra aquí vinculado al asiento. Los informes filtran por asientos POSTED,
  // por lo que los datos no aparecerán en informes hasta que el asiento sea aprobado.
  if (invoiceData.ivaTotal > 0 || invoiceData.ivaRate === 0) {
    await db.vATBook.create({
      data: {
        companyId,
        tipoLibro: 'EMITIDAS',
        numeroFactura: invoiceData.numeroFactura,
        fechaFactura: new Date(invoiceData.fechaEmision),
        nifTercero: invoiceData.clienteNif,
        nombreTercero: invoiceData.clienteNombre,
        baseImponible: invoiceData.baseTotal,
        tipoIva: invoiceData.ivaRate,
        cuotaIva: invoiceData.ivaTotal,
        asientoId: asiento.id,
      },
    });
  }

  return { asientoId: asiento.id, lineas };
}

/**
 * Contabilizar una factura de gasto (COMPRA/SERVICIO)
 */
export async function contabilizarFacturaGasto(
  companyId: string,
  invoiceId: string,
  invoiceData: {
    baseTotal: number;
    ivaTotal: number;
    ivaRate: number;
    retencionTotal: number;
    retencionRate: number;
    totalFactura: number;
    fechaEmision: string;
    numeroFactura: string;
    proveedorId: string;
    proveedorNif: string;
    proveedorNombre: string;
    tipoGasto?: 'COMPRA' | 'SERVICIO_PROFESIONAL' | 'ALQUILER' | 'SUMINISTROS'; // default: COMPRA
  },
  tx?: Prisma.TransactionClient,
): Promise<{ asientoId: string; lineas: any[] }> {
  const db: DbClient = tx ?? prisma;
  const tipoGasto = invoiceData.tipoGasto || 'COMPRA';
  const regla =
    CONTABLE_RULES[
      tipoGasto === 'COMPRA'
        ? 'COMPRA_NACIONAL'
        : tipoGasto === 'SERVICIO_PROFESIONAL'
          ? 'SERVICIO_PROFESIONAL'
          : tipoGasto === 'ALQUILER'
            ? 'ALQUILER'
            : 'SUMINISTROS'
    ];

  if (!regla) throw badRequest(`Tipo de gasto desconocido: ${tipoGasto}`);

  // Crear asiento
  const asiento = await db.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(invoiceData.fechaEmision),
      numeroAsiento: `FAC-GAST-${invoiceData.numeroFactura}`,
      descripcion: `Factura de gasto #${invoiceData.numeroFactura} - ${invoiceData.proveedorNombre}`,
      origen: 'FACTURA_GASTO',
      estado: 'DRAFT',
      invoiceId,
      invoiceType: 'GASTO',
    },
  });

  const lineas: any[] = [];
  let totalDebe = 0;
  let totalHaber = 0;

  // Línea 1: Gasto (DEBE)
  const lineaGasto = await db.journalEntryLine.create({
    data: {
      entryId: asiento.id,
      accountCode: regla.gasto,
      accountName: 'Gastos',
      debe: invoiceData.baseTotal,
      haber: 0,
      referencia: invoiceData.numeroFactura,
      companyId,
    },
  });
  lineas.push(lineaGasto);
  totalDebe += invoiceData.baseTotal;

  // Línea 2: IVA soportado (DEBE) - si aplica
  if (invoiceData.ivaTotal > 0) {
    const lineaIva = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.ivaSoportado!,
        accountName: 'IVA soportado',
        debe: invoiceData.ivaTotal,
        haber: 0,
        referencia: invoiceData.numeroFactura,
        companyId,
      },
    });
    lineas.push(lineaIva);
    totalDebe += invoiceData.ivaTotal;
  }

  // Línea 3: IRPF retenido al proveedor (HABER, cuenta 4751 — PASIVO con Hacienda).
  // Nosotros retenemos este importe del pago al proveedor y lo ingresamos a Hacienda.
  // Es una deuda nuestra con la AEAT → HABER (incrementa el pasivo).
  if (invoiceData.retencionTotal > 0) {
    const lineaIrpf = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.irpfAsumido!,
        accountName: 'HP acreedor retenciones practicadas',
        debe: 0,
        haber: invoiceData.retencionTotal,
        referencia: invoiceData.numeroFactura,
        companyId,
      },
    });
    lineas.push(lineaIrpf);
    totalHaber += invoiceData.retencionTotal;
  }

  // Línea 4: Acreedor proveedor (HABER, cuenta 400)
  const lineaProveedor = await db.journalEntryLine.create({
    data: {
      entryId: asiento.id,
      accountCode: regla.proveedorAcreedor!,
      accountName: 'Proveedores',
      debe: 0,
      haber: invoiceData.totalFactura,
      referencia: invoiceData.numeroFactura,
      companyId,
    },
  });
  lineas.push(lineaProveedor);
  totalHaber += invoiceData.totalFactura;

  // Validar equilibrio: DEBE (base+IVA) = HABER (retención+totalFactura)
  if (Math.abs(totalDebe - totalHaber) > 0.01) {
    throw badRequest(
      `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`,
    );
  }

  // VATBook: vinculado al asiento. Informes filtran por asientos POSTED.
  if (invoiceData.ivaTotal > 0 || invoiceData.ivaRate === 0) {
    await db.vATBook.create({
      data: {
        companyId,
        tipoLibro: 'RECIBIDAS',
        numeroFactura: invoiceData.numeroFactura,
        fechaFactura: new Date(invoiceData.fechaEmision),
        nifTercero: invoiceData.proveedorNif,
        nombreTercero: invoiceData.proveedorNombre,
        baseImponible: invoiceData.baseTotal,
        tipoIva: invoiceData.ivaRate,
        cuotaIva: invoiceData.ivaTotal,
        asientoId: asiento.id,
      },
    });
  }

  // RetentionBook: vinculado al asiento. Informes filtran por asientos POSTED.
  if (invoiceData.retencionTotal > 0 && invoiceData.retencionRate > 0) {
    const fechaRetencion = new Date(invoiceData.fechaEmision);
    await db.retentionBook.create({
      data: {
        companyId,
        ano: fechaRetencion.getFullYear(),
        mes: fechaRetencion.getMonth() + 1,
        tipoRetencionNombre: 'PROFESIONAL',
        nifTercero: invoiceData.proveedorNif,
        nombreTercero: invoiceData.proveedorNombre,
        baseImponible: invoiceData.baseTotal,
        porcentajeRetencion: invoiceData.retencionRate,
        cuotaRetencion: invoiceData.retencionTotal,
        asientoId: asiento.id,
      },
    });
  }

  return { asientoId: asiento.id, lineas };
}

// ============================================================================
// SERVICIOS DE LIBROS Y RESÚMENES FISCALES
// ============================================================================

/**
 * Obtener resumen de IVA por período (para modelo 303, etc.)
 */
export async function obtenerResumenIVA(
  companyId: string,
  trimestre: number,
  ano: number,
) {
  const startDate = new Date(ano, (trimestre - 1) * 3, 1);
  const endDate = new Date(ano, trimestre * 3, 0);

  // Facturas emitidas (IVA repercutido)
  const emitidas = await prisma.vATBook.groupBy({
    by: ['tipoIva'],
    where: {
      companyId,
      tipoLibro: 'EMITIDAS',
      fechaFactura: { gte: startDate, lte: endDate },
    },
    _sum: { baseImponible: true, cuotaIva: true },
  });

  // Facturas recibidas (IVA soportado)
  const recibidas = await prisma.vATBook.groupBy({
    by: ['tipoIva'],
    where: {
      companyId,
      tipoLibro: 'RECIBIDAS',
      fechaFactura: { gte: startDate, lte: endDate },
    },
    _sum: { baseImponible: true, cuotaIva: true },
  });

  return {
    trimestre,
    ano,
    fechaInicio: startDate,
    fechaFin: endDate,
    emitidas: emitidas.map((e) => ({
      tipoIva: e.tipoIva,
      baseImponible: e._sum.baseImponible || 0,
      cuotaIva: e._sum.cuotaIva || 0,
    })),
    recibidas: recibidas.map((r) => ({
      tipoIva: r.tipoIva,
      baseImponible: r._sum.baseImponible || 0,
      cuotaIva: r._sum.cuotaIva || 0,
    })),
    cuotaAIngresar: emitidas.reduce((s, e) => s + (e._sum.cuotaIva || 0), 0) - recibidas.reduce((s, r) => s + (r._sum.cuotaIva || 0), 0),
  };
}

/**
 * Obtener resumen de retenciones (IRPF) por período
 */
export async function obtenerResumenRetenciones(
  companyId: string,
  ano: number,
  tipo: 'PROFESIONALES' | 'ASALARIADOS' | 'TODAS',
) {
  const retenciones = await prisma.retentionBook.findMany({
    where: {
      companyId,
      ano,
      ...(tipo === 'PROFESIONALES' && { tipoRetencionNombre: 'PROFESIONAL' }),
      ...(tipo === 'ASALARIADOS' && { tipoRetencionNombre: 'ASALARIADO' }),
    },
    orderBy: { nifTercero: 'asc' },
  });

  // Agrupar por nifTercero manualmente
  const agrupado = new Map<string, { baseImponible: number; cuotaRetencion: number }>();
  let totalBases = 0;
  let totalRetenciones = 0;

  for (const ret of retenciones) {
    const existing = agrupado.get(ret.nifTercero) || { baseImponible: 0, cuotaRetencion: 0 };
    existing.baseImponible += ret.baseImponible;
    existing.cuotaRetencion += ret.cuotaRetencion;
    agrupado.set(ret.nifTercero, existing);

    totalBases += ret.baseImponible;
    totalRetenciones += ret.cuotaRetencion;
  }

  return {
    ano,
    tipo,
    totalBases,
    totalRetenciones,
    detallePorTercero: Array.from(agrupado.entries()).map(([nif, datos]) => ({
      nif,
      ...datos,
    })),
  };
}

// ============================================================================
// INFORMES FINANCIEROS
// ============================================================================

/**
 * Obtener Balance General (por cuentas de balance: grupos 1-5)
 */
export async function obtenerBalance(
  companyId: string,
  fecha: string,
) {
  const saldos = await prisma.journalEntryLine.groupBy({
    by: ['accountCode'],
    where: {
      companyId,
      entry: {
        fecha: { lte: new Date(fecha) },
        estado: 'POSTED',
      },
    },
    _sum: { debe: true, haber: true },
  });

  const balance = {
    activo: { circulante: 0, noCirculante: 0 },
    pasivo: { circulante: 0, noCirculante: 0 },
    patrimonioNeto: 0,
    fecha,
  };

  // Procesar saldos (simplificado)
  for (const saldo of saldos) {
    const neto = (saldo._sum.debe || 0) - (saldo._sum.haber || 0);
    const grupo = parseInt(saldo.accountCode!.charAt(0));

    if (grupo === 1) balance.patrimonioNeto += neto;
    else if (grupo === 2) balance.activo.noCirculante += neto;
    else if (grupo === 3 || grupo === 4) balance.activo.circulante += neto;
    else if (grupo === 5) balance.activo.circulante += neto;
  }

  return balance;
}

/**
 * Obtener Cuenta de Pérdidas y Ganancias (ingresos - gastos)
 */
export async function obtenerPyG(
  companyId: string,
  desde: string,
  hasta: string,
) {
  const movimientos = await prisma.journalEntryLine.groupBy({
    by: ['accountCode'],
    where: {
      companyId,
      entry: {
        fecha: { gte: new Date(desde), lte: new Date(hasta) },
      },
    },
    _sum: { debe: true, haber: true },
  });

  let ingresos = 0;
  let gastos = 0;

  for (const mov of movimientos) {
    const grupo = parseInt(mov.accountCode!.charAt(0));
    if (grupo === 7) {
      // Ventas e ingresos: naturaleza HABER → net = haber - debe
      ingresos += (mov._sum.haber || 0) - (mov._sum.debe || 0);
    } else if (grupo === 6) {
      // Compras y gastos: naturaleza DEBE → net positivo = debe - haber
      gastos += (mov._sum.debe || 0) - (mov._sum.haber || 0);
    }
  }

  return {
    desde,
    hasta,
    ingresos,
    gastos,
    resultadoExplotacion: ingresos - gastos,
  };
}

// ============================================================================
// ANALÍTICAS
// ============================================================================

/**
 * Evolución de ingresos y gastos por mes
 */
export async function obtenerEvolucionMensual(
  companyId: string,
  ano: number,
) {
  const movimientos = await prisma.journalEntry.findMany({
    where: {
      companyId,
      fecha: {
        gte: new Date(ano, 0, 1),
        lte: new Date(ano, 11, 31),
      },
    },
    include: { lineas: true },
  });

  const meses: Record<string, { ingresos: number; gastos: number }> = {};

  for (let i = 1; i <= 12; i++) {
    meses[i.toString().padStart(2, '0')] = { ingresos: 0, gastos: 0 };
  }

  for (const entry of movimientos) {
    const mes = (entry.fecha.getMonth() + 1).toString().padStart(2, '0');
    for (const linea of entry.lineas) {
      const grupo = parseInt(linea.accountCode!.charAt(0));
      if (grupo === 7) meses[mes].ingresos += linea.haber || 0;
      else if (grupo === 6) meses[mes].gastos += linea.debe || 0;
    }
  }

  return { ano, meses };
}

/**
 * Análisis por categoría (cliente, proveedor, proyecto, etc.)
 */
export async function obtenerAnalisisPorCategoria(
  companyId: string,
  tipo: 'CLIENTE' | 'PROVEEDOR' | 'CATEGORIA',
  desde: string,
  hasta: string,
) {
  void companyId; void tipo; void desde; void hasta;
  // Pendiente: requiere mapeo de JournalEntryLine a terceros (cliente/proveedor)
  // via invoiceId → Customer/Supplier. La estructura de datos está disponible
  // pero la agregación no está implementada.
  throw notImplemented('Análisis por categoría pendiente de implementación.');
}

export const accountingEngineService = {
  contabilizarFacturaIngreso,
  contabilizarFacturaGasto,
  obtenerResumenIVA,
  obtenerResumenRetenciones,
  obtenerBalance,
  obtenerPyG,
  obtenerEvolucionMensual,
  obtenerAnalisisPorCategoria,
};
