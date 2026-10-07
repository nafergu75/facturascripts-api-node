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

import { badRequest, notFound, notImplemented } from '../utils/http-errors';
import { prisma, type ClienteBD, type TransaccionBD } from '../config/database';
import { aCentimos, cuadraEnCentimos } from '../utils/money';
import { esTipoOperacion, REGLA_OPERACION, type TipoOperacionVenta } from '../domain/tipo-operacion.model';

// Cliente compartido o el de una transaccion (los importes se leen como number).
type DbClient = ClienteBD | TransaccionBD;

/** Base y cuota de IVA de una factura para un tipo concreto (0, 4, 10, 21). */
export interface DesgloseIva {
  tipoIva: number;
  base: number;
  cuota: number;
}

const centimos = (n: number) => Math.round(n * 100) / 100;

/**
 * Agrupa las lineas de una factura por tipo de IVA. El libro registro necesita
 * un apunte por tipo: una factura con lineas al 21% y al 10% son dos apuntes,
 * y una exenta es un apunte al 0% (no al 21%).
 */
export function desgloseIvaPorTipo(
  lineas: Array<{ tipoIva: number; baseLine: number; ivaImporte: number }>,
): DesgloseIva[] {
  const porTipo = new Map<number, DesgloseIva>();
  for (const l of lineas) {
    const actual = porTipo.get(l.tipoIva) ?? { tipoIva: l.tipoIva, base: 0, cuota: 0 };
    actual.base += l.baseLine;
    actual.cuota += l.ivaImporte;
    porTipo.set(l.tipoIva, actual);
  }
  return [...porTipo.values()].map((d) => ({ tipoIva: d.tipoIva, base: centimos(d.base), cuota: centimos(d.cuota) }));
}

/** Apuntes del libro de IVA: el desglose si viene, o los totales al tipo de la factura. */
function apuntesLibroIva(d: { desgloseIva?: DesgloseIva[]; ivaRate: number; baseTotal: number; ivaTotal: number }): DesgloseIva[] {
  if (d.desgloseIva && d.desgloseIva.length > 0) return d.desgloseIva;
  return [{ tipoIva: d.ivaRate, base: d.baseTotal, cuota: d.ivaTotal }];
}

// ============================================================================
// TIPOS Y CONFIGURACIÓN
// ============================================================================

/**
 * Reglas de mapeo: Factura → Cuentas PGC
 *
 * Determina qué cuentas contables usar según tipo de operación, IVA, IRPF
 */
export const CONTABLE_RULES = {
  // FACTURAS DE INGRESO (VENTAS). La cuenta de ingreso es la 700 en todos los
  // tipos de operacion: el tipo decide el IVA (477), el libro de IVA y los
  // modelos, no la cuenta (701, 702 y 705 son productos terminados,
  // semiterminados y servicios en el PGC, no "ventas al extranjero").
  VENTA_NACIONAL: {
    ingreso: '700', // Ventas de mercaderías
    clienteDeudor: '430', // Clientes
    ivaRepercutido: '477', // IVA repercutido
    // 473 = "HP retenciones y pagos a cuenta" (ACTIVO: Hacienda nos debe devolver).
    // 4751 sería PASIVO (nosotros debemos a Hacienda), que es el caso del GASTO, no del ingreso.
    irpfRetenido: '473',
  },
  VENTA_INTRACOMUNITARIA: {
    ingreso: '700', // Entrega intracomunitaria exenta: sin 477
    clienteDeudor: '430',
    ivaRepercutido: '477',
    irpfRetenido: '473',
  },
  VENTA_EXPORTACION: {
    ingreso: '700', // Exportacion exenta: sin 477
    clienteDeudor: '430',
    ivaRepercutido: '477',
    irpfRetenido: '473',
  },
  VENTA_SERVICIOS_EXTRANJERO: {
    ingreso: '700', // No sujeta por reglas de localizacion: sin 477
    clienteDeudor: '430',
    ivaRepercutido: '477',
    irpfRetenido: '473',
  },
  VENTA_EXENTA: {
    ingreso: '700', // Exenta (art. 20 LIVA y otros): sin 477
    clienteDeudor: '430',
    ivaRepercutido: '477',
    irpfRetenido: '473',
  },
  VENTA_ISP_NACIONAL: {
    ingreso: '700', // Inversion del sujeto pasivo: la cuota la declara el cliente
    clienteDeudor: '430',
    ivaRepercutido: '477',
    irpfRetenido: '473',
  },
  VENTA_EMPRESA_EXTRANJERA: {
    ingreso: '700', // Empresa no establecida en Espana: sin IVA ni libro de IVA
    clienteDeudor: '430',
    ivaRepercutido: '477',
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
    // 623 = servicios de profesionales independientes (la 622 es reparaciones).
    gasto: '623',
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
    gasto: '628', // Suministros (la 623 es profesionales)
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

  // COBROS Y PAGOS EN DIVISA: diferencia entre el tipo de la factura y el del cobro.
  DIFERENCIAS_CAMBIO: {
    positiva: '768', // Diferencias positivas de cambio (ingreso)
    negativa: '668', // Diferencias negativas de cambio (gasto)
  },
  // Comision que el banco descuenta de un cobro en divisa.
  COMISION_BANCARIA: {
    cuenta: '626', // Servicios bancarios y similares
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
 *
 * Los importes son SIEMPRE los de la moneda de cuenta de la empresa (las
 * columnas de siempre de la factura), nunca los de la moneda del documento.
 *
 * Tipo de operacion (domain/tipo-operacion.model.ts):
 *  - Sin tipo (facturas anteriores a esta funcion): igual que siempre, como
 *    NACIONAL y con el libro de IVA sin tipo.
 *  - Con tipo: los que no llevan cuota no admiten IVA (400) y no tienen 477;
 *    el libro de IVA guarda el tipo y la causa de exencion (E2 exportacion, E5
 *    intracomunitaria...), y la empresa extranjera no escribe libro de IVA.
 *  - Las cuotas y retenciones negativas (rectificativas) van con su signo en
 *    la misma columna, como la 430 y la 700.
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
    /**
     * Fecha de devengo del IVA (domain/tipo-operacion.model.ts fechaDevengoVenta)
     * si es distinta de la de emision: con ella se anota en el libro de IVA, para
     * que el 303 la lleve al periodo de la operacion. El asiento va con la de emision.
     */
    fechaDevengo?: string | null;
    numeroFactura: string;
    clienteId: string;
    clienteNif: string;
    clienteNombre: string;
    /** Sin el: factura anterior a los tipos de operacion (como NACIONAL, libro de IVA sin tipo). */
    tipoOperacion?: TipoOperacionVenta;
    /** Solo con EXENTA: E1, E3, E4 o E6. */
    causaExencion?: string | null;
    /** Pais del cliente (para la casilla de los servicios a extranjeros). */
    clientePais?: string | null;
    /** Base y cuota por tipo de IVA. Sin el, se registra todo al tipo `ivaRate`. */
    desgloseIva?: DesgloseIva[];
    /** Texto que se anade a la descripcion (p. ej. la nota de divisa). */
    notaDescripcion?: string;
    /** POSTED (por defecto): la factura emitida es definitiva. DRAFT: pendiente de revisar (OCR). */
    estadoAsiento?: 'POSTED' | 'DRAFT';
  },
  tx?: TransaccionBD,
): Promise<{ asientoId: string; lineas: any[] }> {
  const db: DbClient = tx ?? prisma;
  const tipoOp = invoiceData.tipoOperacion ?? 'NACIONAL';
  if (!esTipoOperacion(tipoOp)) throw badRequest(`Tipo de operación desconocido: ${tipoOp}`);
  const regla = CONTABLE_RULES[`VENTA_${tipoOp}`];
  const reglaIva = REGLA_OPERACION[tipoOp];

  // Un tipo sin cuota (exenta, intracomunitaria, exportacion, ISP...) con IVA es
  // una contradiccion: el asiento llevaria una 477 que el libro de IVA no tiene.
  if (invoiceData.tipoOperacion && !reglaIva.llevaCuota && aCentimos(invoiceData.ivaTotal) !== 0) {
    throw badRequest(
      `Una factura de tipo "${reglaIva.etiqueta.es}" no lleva IVA y esta tiene ${invoiceData.ivaTotal} de cuota: revísala.`,
    );
  }

  // La descripcion cabe en 190 caracteres: se recorta el nombre, nunca la nota.
  const nota = invoiceData.notaDescripcion ?? '';
  const descripcion = `Factura de ingreso #${invoiceData.numeroFactura} - ${invoiceData.clienteNombre}`.slice(0, 190 - nota.length) + nota;

  // Crear asiento
  const asiento = await db.journalEntry.create({
    data: {
      companyId,
      fecha: new Date(invoiceData.fechaEmision),
      numeroAsiento: `FAC-ING-${invoiceData.numeroFactura}`,
      descripcion,
      origen: 'FACTURA_INGRESO',
      estado: invoiceData.estadoAsiento ?? 'POSTED',
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
      accountCode: regla.clienteDeudor,
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

  // Línea 3: IVA repercutido (HABER), si hay cuota. Una rectificativa la lleva
  // negativa, como la 430 y la 700 (antes no se apuntaba y el asiento no cuadraba).
  if (aCentimos(invoiceData.ivaTotal) !== 0) {
    const lineaIva = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.ivaRepercutido,
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
  if (aCentimos(invoiceData.retencionTotal) !== 0) {
    const lineaIrpf = await db.journalEntryLine.create({
      data: {
        entryId: asiento.id,
        accountCode: regla.irpfRetenido,
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
  if (!cuadraEnCentimos(totalDebe, totalHaber)) {
    throw badRequest(
      `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`,
    );
  }

  // VATBook: un apunte por tipo de IVA, vinculado al asiento. Las exentas tambien
  // se registran (libro de facturas expedidas). Los informes filtran por asientos
  // POSTED, asi que no aparecen hasta que el asiento se aprueba. Una empresa no
  // establecida en Espana no lleva libro de IVA.
  if (!invoiceData.tipoOperacion || reglaIva.enLibroIva) {
    const ctx = {
      cliente: { pais: invoiceData.clientePais ?? null, nifCif: invoiceData.clienteNif },
      causaExencion: invoiceData.causaExencion ?? null,
    };
    // Facturas anteriores: el libro sin tipo, como siempre.
    const tipoLibro = invoiceData.tipoOperacion ? { tipoOperacion: tipoOp, causaExencion: reglaIva.causaLibro(ctx) } : {};
    // Devengo distinto de la emision: el libro (y el 303) en el periodo del devengo, con la fecha de expedicion anotada.
    const devengo = invoiceData.fechaDevengo && invoiceData.fechaDevengo !== invoiceData.fechaEmision ? invoiceData.fechaDevengo : null;
    const fechaExpedicion = `${invoiceData.fechaEmision.slice(8, 10)}/${invoiceData.fechaEmision.slice(5, 7)}/${invoiceData.fechaEmision.slice(0, 4)}`;
    for (const apunte of apuntesLibroIva(invoiceData)) {
      await db.vATBook.create({
        data: {
          companyId,
          tipoLibro: 'EMITIDAS',
          numeroFactura: invoiceData.numeroFactura,
          fechaFactura: new Date(devengo ?? invoiceData.fechaEmision),
          ...(devengo ? { observaciones: `Fecha de expedición: ${fechaExpedicion}` } : {}),
          nifTercero: invoiceData.clienteNif,
          nombreTercero: invoiceData.clienteNombre,
          baseImponible: apunte.base,
          tipoIva: apunte.tipoIva,
          cuotaIva: apunte.cuota,
          asientoId: asiento.id,
          ...tipoLibro,
        },
      });
    }
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
    /** Base y cuota por tipo de IVA. Sin el, se registra todo al tipo `ivaRate`. */
    desgloseIva?: DesgloseIva[];
    /** POSTED (por defecto) o DRAFT si viene del lector OCR y hay que revisarla. */
    estadoAsiento?: 'POSTED' | 'DRAFT';
  },
  tx?: TransaccionBD,
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
      estado: invoiceData.estadoAsiento ?? 'POSTED',
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
  if (!cuadraEnCentimos(totalDebe, totalHaber)) {
    throw badRequest(
      `Asiento desequilibrado: debe ${totalDebe} ≠ haber ${totalHaber}`,
    );
  }

  // VATBook: un apunte por tipo de IVA, vinculado al asiento. Informes filtran por asientos POSTED.
  for (const apunte of apuntesLibroIva(invoiceData)) {
    await db.vATBook.create({
      data: {
        companyId,
        tipoLibro: 'RECIBIDAS',
        numeroFactura: invoiceData.numeroFactura,
        fechaFactura: new Date(invoiceData.fechaEmision),
        nifTercero: invoiceData.proveedorNif,
        nombreTercero: invoiceData.proveedorNombre,
        baseImponible: apunte.base,
        tipoIva: apunte.tipoIva,
        cuotaIva: apunte.cuota,
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
