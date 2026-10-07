import type { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../utils/http-errors';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import { obtenerOCrearSerie, obtenerSeriePorDefecto, resolverCodSerieFactura } from './series.service';
import { listarCobros, registrarCobroFactura, tieneCobrosActivos, type DatosCobro } from './cobrosPagos.service';
import {
  calcularImportesFactura,
  lineasEspejo,
  type ImportesFactura,
  type LineaCalculada,
  type LineaEntrada,
} from '../domain/importesFactura';
import { importesDoc, normalizarMoneda, textoTipo, validarFormatoTipoCambio, validarMoneda } from '../domain/divisas';
import {
  esTipoOperacion,
  inferirTipoOperacion,
  mencionFiscal,
  normalizarPais,
  operacionEfectiva,
  paisDelCliente,
  type AvisoFiscal,
  type ClienteFiscal,
  type Mencion,
  type ModoFiscal,
  type TipoOperacionVenta,
} from '../domain/tipo-operacion.model';
import { perfilDesdeConfig, perfilEmpresa, type PerfilEmpresa } from './perfilEmpresa.service';
import { marcarTransaccion, mensajeSinTipo, resolverTipoCambio, type TipoResuelto } from './tiposCambio.service';
import { resolverFiscalidad } from './fiscalidad-venta.service';

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
 *
 * Facturas PROFORMA: mismo documento, pero NO es una factura. Se numeran en su
 * serie propia (P-1, P-2...) al crearlas y no cuentan para impuestos, informes,
 * contabilidad, cobros ni archivo. Su `estado` es PENDIENTE, ACEPTADA o
 * RECHAZADA. Si el cliente la acepta, "Pasar a factura" crea un borrador de
 * factura enlazado (proformaId) y la proforma queda ACEPTADA.
 *
 * DIVISAS: los importes de siempre (baseTotal..., baseLine...) van SIEMPRE en
 * la moneda de cuenta de la empresa; las columnas *Doc, en la moneda de la
 * factura (null = iguales). El tipo de cambio (unidades de la moneda de la
 * factura por 1 de la de cuenta) se resuelve antes de cualquier transaccion y
 * queda fijado al emitir (BCE del devengo o manual). Ver domain/divisas.ts.
 *
 * TIPO DE OPERACION de IVA: uno por factura (domain/tipo-operacion.model.ts).
 * Una empresa no espanola factura sin IVA ni retencion (EMPRESA_EXTRANJERA).
 */

export const ESTADO_BORRADOR = 'BORRADOR';
export const ESTADO_FINAL = 'FINAL';
export const ESTADO_PROFORMA = 'PROFORMA';

/** Estados de una proforma (van en `estado`, que en las facturas es el de cobro). */
export const ESTADOS_PROFORMA = ['PENDIENTE', 'ACEPTADA', 'RECHAZADA'] as const;
export type EstadoProforma = (typeof ESTADOS_PROFORMA)[number];

/** Tipos de factura de Verifactu: F1 completa, F2 simplificada, R1-R5 rectificativas. */
export const TIPOS_FACTURA = ['F1', 'F2', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type TipoFactura = (typeof TIPOS_FACTURA)[number];

/** Formas de pago que se imprimen en la factura. */
export const FORMAS_PAGO = ['TRANSFERENCIA', 'GIRO', 'CONTADO'] as const;
export type FormaPago = (typeof FORMAS_PAGO)[number];

/** Estados de cobro que se pueden poner a mano en una factura final. */
export const ESTADOS_COBRO = ['PENDING', 'PAID', 'OVERDUE'] as const;

/** De donde nace la factura. Lo fija el servidor, nunca el cuerpo de la peticion. */
export type OrigenFactura = 'pantalla' | 'lector' | 'copia';

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
  /** Fecha de la operacion (devengo) si es distinta de la de emision: fija el tipo de cambio. */
  fechaOperacion?: string | null;
  lineas: CrearLineaIngresoDTO[];
  plantillaId?: string; // Defecto: "default"
  observaciones?: string;
  /** true: se guarda como borrador, sin numero. Por defecto se emite (final). */
  borrador?: boolean;
  /** true: factura proforma (serie P, numero al crearla, sin efectos fiscales). */
  proforma?: boolean;
  tipoFactura?: TipoFactura;
  /** Transferencia bancaria (defecto), giro (recibo domiciliado) o contado. */
  formaPago?: FormaPago;
  facturaOriginalId?: string; // Si es rectificativa
  tipoRectificativa?: 'S' | 'I';
  motivoRectificacion?: string;
  /** Moneda de la factura (ISO 4217). Por defecto, la de la contabilidad. */
  moneda?: string;
  /**
   * Tipo de cambio indicado a mano: unidades de `moneda` por 1 de la moneda de
   * cuenta ("1 EUR = 1,1490 USD" -> 1.149). Sin el, el del BCE del devengo.
   * null en una modificacion: volver al del BCE.
   */
  tipoCambio?: number | string | null;
  /** Tipo de operacion de IVA (ver domain/tipo-operacion.model.ts). */
  tipoOperacion?: string | null;
  /** E1 | E3 | E4 | E6, solo con EXENTA. */
  causaExencion?: string | null;
  /** Precepto de la exencion (EXENTA) o letra del art. 84.Uno.2.º (ISP_NACIONAL). */
  referenciaLegal?: string | null;
}

export interface CrearLineaIngresoDTO {
  descripcion: string;
  cantidad: number;
  /** En la moneda de la factura. */
  precioUnitario: number;
  descuentoPorcentaje?: number;
  tipoIva?: number; // 0, 4, 10, 21 (defecto 21)
  tipoRetencion?: number; // 0, 7, 15, 19 (defecto 0)
  productoServicioId?: string;
  /** Moneda de la linea (la de la factura). Obligatoria al modificar un borrador en divisa. */
  moneda?: string;
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
    | 'moneda'
    | 'tipoCambio'
    | 'fechaOperacion'
    | 'tipoOperacion'
    | 'causaExencion'
    | 'referenciaLegal'
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
  /** Fecha de la operacion si es distinta de la de emision. */
  fechaOperacion?: string;
  estado: string;
  /** Importes en la moneda de CUENTA (los de la contabilidad y los impuestos). */
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  totalFactura: number;
  /** Importes en la moneda de la factura (iguales a los de cuenta si es la misma). */
  baseTotalDoc: number;
  ivaTotalDoc: number;
  retencionTotalDoc: number;
  totalFacturaDoc: number;
  moneda: string;
  monedaCuenta: string;
  /** Unidades de `moneda` por 1 de `monedaCuenta`. */
  tipoCambio: number;
  fechaTipoCambio?: string;
  /** PAR | BCE | MANUAL | HEREDADO | PENDIENTE */
  fuenteTipoCambio: string;
  /** '1 EUR = 1,1490 USD' (solo si la moneda no es la de cuenta y hay tipo). */
  textoTipoCambio?: string;
  /** true: aun no esta emitida y va en otra moneda: el tipo se fija al emitir. */
  tipoCambioProvisional: boolean;
  /** Aviso del tipo de cambio al guardar (desviado del BCE, provisional...). */
  avisoTipoCambio?: string;
  /** Tipo de operacion guardado (null en borradores sin elegir y facturas anteriores). */
  tipoOperacion?: string;
  /** Tipo con el que se trata la factura (el guardado, el de siempre o el que se deduce). */
  tipoOperacionEfectivo: string | null;
  causaExencion?: string;
  referenciaLegal?: string;
  /** Mencion fiscal del PDF (es/en), o null. */
  mencionFiscal: Mencion | null;
  /** Avisos fiscales al guardar o emitir (no bloquean). */
  avisosFiscales?: AvisoFiscal[];
  plantillaId: string;
  observaciones?: string;
  esRectificativa: boolean;
  facturaOriginalId?: string;
  /** Factura nacida de una proforma: id de esa proforma. */
  proformaId?: string;
  /** Proforma ya pasada a factura: id de la factura creada. */
  facturaGeneradaId?: string;
  esRecurrente: boolean;
  createdAt: Date;
  updatedAt: Date;
  lineas: LineaIngresoResp[];
}

export interface LineaIngresoResp {
  id: string;
  descripcion: string;
  cantidad: number;
  /** Moneda de cuenta (informativo si la factura va en otra moneda). */
  precioUnitario: number;
  baseLine: number;
  descuentoPorcentaje: number;
  descuentoImporte: number;
  tipoIva: number;
  ivaImporte: number;
  tipoRetencion: number;
  retencionImporte: number;
  /** En la moneda de la factura. */
  precioUnitarioDoc: number;
  baseLineDoc: number;
  descuentoImporteDoc: number;
  ivaImporteDoc: number;
  retencionImporteDoc: number;
  productoServicioId?: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const hoyISO = (): string => new Date().toISOString().slice(0, 10);
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIPOS_IVA = [0, 4, 5, 10, 21];

// Tipos del cliente con extensiones: los importes ya llegan como number.
type FacturaConLineas = NonNullable<Awaited<ReturnType<typeof buscarConLineas>>>;
const INCLUIR = { lineas: true, customer: true } as const;
const buscarConLineas = (companyId: string, id: string) =>
  prisma.incomeInvoice.findFirst({ where: { id, companyId }, include: INCLUIR });

/** Datos del cliente que importan para el IVA. */
const clienteFiscal = (c: { pais: string | null; nifCif: string | null; cp: string | null }): ClienteFiscal => ({
  pais: c.pais,
  nifCif: c.nifCif,
  cp: c.cp,
});

/** Tipo con el que se trata la factura: el guardado; si no, el de siempre (emitidas) o el que se deduce. */
function tipoOperacionEfectivo(f: FacturaConLineas): TipoOperacionVenta | null {
  if (esTipoOperacion(f.tipoOperacion)) return f.tipoOperacion;
  const cliente = clienteFiscal(f.customer);
  if (f.estadoDocumento === ESTADO_FINAL) return operacionEfectiva(f, cliente);
  return inferirTipoOperacion(cliente, f.lineas);
}

interface ContextoRespuesta {
  monedaCuenta: string;
  avisosFiscales?: AvisoFiscal[];
  avisoTipoCambio?: string;
}

function aRespuesta(f: FacturaConLineas, ctx: ContextoRespuesta): IncomeInvoiceResp {
  const doc = importesDoc(f);
  const otraMoneda = f.moneda !== ctx.monedaCuenta;
  const efectivo = tipoOperacionEfectivo(f);
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
    fechaOperacion: f.fechaOperacion ?? undefined,
    estado: f.estado,
    baseTotal: f.baseTotal,
    ivaTotal: f.ivaTotal,
    retencionTotal: f.retencionTotal,
    totalFactura: f.totalFactura,
    baseTotalDoc: doc.baseTotal,
    ivaTotalDoc: doc.ivaTotal,
    retencionTotalDoc: doc.retencionTotal,
    totalFacturaDoc: doc.totalFactura,
    moneda: f.moneda,
    monedaCuenta: ctx.monedaCuenta,
    tipoCambio: f.tipoCambio,
    fechaTipoCambio: f.fechaTipoCambio ?? undefined,
    fuenteTipoCambio: f.fuenteTipoCambio,
    textoTipoCambio: otraMoneda && f.fuenteTipoCambio !== 'PENDIENTE' ? textoTipo(ctx.monedaCuenta, f.moneda, f.tipoCambio) : undefined,
    tipoCambioProvisional: otraMoneda && f.estadoDocumento !== ESTADO_FINAL,
    ...(ctx.avisoTipoCambio ? { avisoTipoCambio: ctx.avisoTipoCambio } : {}),
    tipoOperacion: f.tipoOperacion ?? undefined,
    tipoOperacionEfectivo: efectivo,
    causaExencion: f.causaExencion ?? undefined,
    referenciaLegal: f.referenciaLegal ?? undefined,
    mencionFiscal: mencionFiscal(efectivo, {
      cliente: clienteFiscal(f.customer),
      causaExencion: f.causaExencion,
      referenciaLegal: f.referenciaLegal,
    }),
    ...(ctx.avisosFiscales?.length ? { avisosFiscales: ctx.avisosFiscales } : {}),
    plantillaId: f.plantillaId,
    observaciones: f.observaciones ?? undefined,
    esRectificativa: f.esRectificativa,
    facturaOriginalId: f.facturaOriginalId ?? undefined,
    proformaId: f.proformaId ?? undefined,
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
      precioUnitarioDoc: l.precioUnitarioDoc ?? l.precioUnitario,
      baseLineDoc: l.baseLineDoc ?? l.baseLine,
      descuentoImporteDoc: l.descuentoImporteDoc ?? l.descuentoImporte,
      ivaImporteDoc: l.ivaImporteDoc ?? l.ivaImporte,
      retencionImporteDoc: l.retencionImporteDoc ?? l.retencionImporte,
      productoServicioId: l.productoServicioId ?? undefined,
    })),
  };
}

/** Pais del cliente nuevo: ISO-2, o el del prefijo de su NIF-IVA si viene vacio o ES. */
function paisClienteNuevo(pais: string | undefined, nifCif: string): string {
  const p = paisDelCliente({ pais: normalizarPais(pais), nifCif });
  return /^[A-Z]{2}$/.test(p) ? p : pais || 'ES';
}

/**
 * Resuelve o crea el cliente. Devuelve su id y sus datos fiscales.
 */
async function resolverCliente(
  companyId: string,
  customerData: CrearFacturaIngresoDTO['customer'] | undefined,
): Promise<{ id: string; fiscal: ClienteFiscal }> {
  if (customerData?.id) {
    // Verificar que existe y pertenece a esta empresa
    const exists = await prisma.customer.findFirst({
      where: { id: customerData.id, companyId },
    });
    if (!exists) throw badRequest('Cliente no encontrado.');
    return { id: exists.id, fiscal: clienteFiscal(exists) };
  }

  // Crear cliente nuevo
  if (!customerData?.nuevo?.nombreFiscal || !customerData?.nuevo?.nifCif) {
    throw badRequest('Elige un cliente o indica el nombre fiscal y el NIF del cliente nuevo.');
  }

  const n = customerData.nuevo;
  const nifCif = n.nifCif.replace(/[\s-]/g, '').toUpperCase();
  const customer = await prisma.customer.create({
    data: {
      companyId,
      nombreFiscal: n.nombreFiscal,
      nifCif,
      direccion: n.direccion,
      pais: paisClienteNuevo(n.pais, nifCif),
      provincia: n.provincia,
      municipio: n.municipio,
      cp: n.cp,
      email: n.email,
    },
  });

  return { id: customer.id, fiscal: clienteFiscal(customer) };
}

/** Comprueba las lineas antes de guardarlas: una factura con datos absurdos no se emite. */
function validarLineas(lineas: CrearLineaIngresoDTO[] | undefined): LineaEntrada[] {
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
    descripcion: String(l.descripcion).trim(),
    cantidad: Number(l.cantidad),
    precioUnitario: Number(l.precioUnitario),
    descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
    tipoIva: Number(l.tipoIva ?? 21),
    tipoRetencion: Number(l.tipoRetencion ?? 0),
    productoServicioId: l.productoServicioId,
  }));
}

/**
 * Las lineas van en la moneda de la factura. Si una indica otra moneda, 400.
 * Con `exigir` (borrador en divisa), cada linea tiene que decir su moneda: un
 * formulario antiguo reenviaria precios en euros sin saberlo.
 */
function comprobarMonedaLineas(lineas: CrearLineaIngresoDTO[] | undefined, moneda: string, exigir: boolean): void {
  (lineas ?? []).forEach((l, i) => {
    const m = l?.moneda;
    if (m === undefined || m === null || m === '') {
      if (exigir) {
        throw badRequest(`Línea ${i + 1}: indica la moneda de la línea (${moneda}). Los precios van en la moneda de la factura.`);
      }
      return;
    }
    if (normalizarMoneda(m) !== moneda) {
      throw badRequest(`Línea ${i + 1}: está en ${normalizarMoneda(m)} y la factura en ${moneda}.`);
    }
  });
}

/** Lineas de una factura guardada, con los precios en la moneda del documento. */
function lineasDocGuardadas(f: FacturaConLineas): LineaEntrada[] {
  return f.lineas.map((l) => ({
    descripcion: l.descripcion,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitarioDoc ?? l.precioUnitario,
    descuentoPorcentaje: l.descuentoPorcentaje,
    tipoIva: l.tipoIva,
    tipoRetencion: l.tipoRetencion,
    productoServicioId: l.productoServicioId ?? undefined,
  }));
}

/** Importes guardados de una factura (documento y cuenta), sin recalcular. */
function importesGuardados(f: FacturaConLineas): ImportesFactura {
  return {
    doc: importesDoc(f),
    cuenta: { baseTotal: f.baseTotal, ivaTotal: f.ivaTotal, retencionTotal: f.retencionTotal, totalFactura: f.totalFactura },
    lineas: f.lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: l.cantidad,
      descuentoPorcentaje: l.descuentoPorcentaje,
      tipoIva: l.tipoIva,
      tipoRetencion: l.tipoRetencion,
      productoServicioId: l.productoServicioId ?? undefined,
      doc: {
        precioUnitario: l.precioUnitarioDoc ?? l.precioUnitario,
        baseLine: l.baseLineDoc ?? l.baseLine,
        descuentoImporte: l.descuentoImporteDoc ?? l.descuentoImporte,
        ivaImporte: l.ivaImporteDoc ?? l.ivaImporte,
        retencionImporte: l.retencionImporteDoc ?? l.retencionImporte,
      },
      cuenta: {
        precioUnitario: l.precioUnitario,
        baseLine: l.baseLine,
        descuentoImporte: l.descuentoImporte,
        ivaImporte: l.ivaImporte,
        retencionImporte: l.retencionImporte,
      },
    })),
  };
}

/** Columnas de cabecera: cuenta y documento. */
function cabecera(imp: ImportesFactura) {
  return {
    baseTotal: imp.cuenta.baseTotal,
    ivaTotal: imp.cuenta.ivaTotal,
    retencionTotal: imp.cuenta.retencionTotal,
    totalFactura: imp.cuenta.totalFactura,
    baseTotalDoc: imp.doc.baseTotal,
    ivaTotalDoc: imp.doc.ivaTotal,
    retencionTotalDoc: imp.doc.retencionTotal,
    totalFacturaDoc: imp.doc.totalFactura,
  };
}

/** Importes de una linea: cuenta y documento. */
function importesLinea(l: LineaCalculada) {
  return {
    tipoIva: l.tipoIva,
    tipoRetencion: l.tipoRetencion,
    precioUnitario: l.cuenta.precioUnitario,
    baseLine: l.cuenta.baseLine,
    descuentoImporte: l.cuenta.descuentoImporte,
    ivaImporte: l.cuenta.ivaImporte,
    retencionImporte: l.cuenta.retencionImporte,
    precioUnitarioDoc: l.doc.precioUnitario,
    baseLineDoc: l.doc.baseLine,
    descuentoImporteDoc: l.doc.descuentoImporte,
    ivaImporteDoc: l.doc.ivaImporte,
    retencionImporteDoc: l.doc.retencionImporte,
  };
}

/** Lineas listas para `lineas: { create }`. */
function lineasACrear(imp: ImportesFactura) {
  return imp.lineas.map((l) => ({
    descripcion: l.descripcion,
    cantidad: l.cantidad,
    descuentoPorcentaje: l.descuentoPorcentaje,
    productoServicioId: l.productoServicioId,
    ...importesLinea(l),
  }));
}

/** Columnas del tipo de cambio. PENDIENTE guarda 1 (la columna no admite null) y la fuente lo dice. */
function datosTipo(t: TipoResuelto) {
  return { tipoCambio: t.tipoCambio ?? 1, fechaTipoCambio: t.fechaTipoCambio, fuenteTipoCambio: t.fuente };
}

/** Aplica a las lineas el IVA y la retencion que decide la fiscalidad (empresa no espanola: 0). */
function conFiscalidad(lineas: LineaEntrada[], fiscal: { lineas: Array<{ tipoIva: number; tipoRetencion: number }> }): LineaEntrada[] {
  return lineas.map((l, i) => ({ ...l, tipoIva: fiscal.lineas[i].tipoIva, tipoRetencion: fiscal.lineas[i].tipoRetencion }));
}

/** Un recalculo de importes nunca toca una factura emitida (sus datos estan congelados). */
function exigirNoFinal(f: { estadoDocumento: string; numeroCompleto: string | null }): void {
  if (f.estadoDocumento === ESTADO_FINAL) {
    throw new Error(`La factura ${f.numeroCompleto ?? ''} está emitida: sus importes no se recalculan.`);
  }
}

/** Valor de tipoCambio del cuerpo: undefined = no se toca; null = volver al del BCE. */
const hayValor = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/**
 * Determina el estado de la factura según la fecha de vencimiento.
 */
function determinarEstado(fechaVencimiento: string): string {
  return fechaVencimiento < hoyISO() ? 'OVERDUE' : 'PENDING';
}

function validarFecha(fecha: string, campo: string): string {
  const f = String(fecha).slice(0, 10);
  if (!FECHA_RE.test(f) || Number.isNaN(new Date(`${f}T00:00:00Z`).getTime())) {
    throw badRequest(`La ${campo} no es una fecha válida (AAAA-MM-DD).`);
  }
  return f;
}

/** Fecha de la operacion: null si no se indica o coincide con la de emision. */
function validarFechaOperacion(valor: string | null | undefined, fechaEmision: string): string | null {
  if (!valor) return null;
  const f = validarFecha(valor, 'fecha de la operación');
  return f === fechaEmision ? null : f;
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
  if (serie.tipoDocumento === 'PROFORMA') {
    throw badRequest(`La serie ${serie.codigo} es de proformas: una factura no puede ir en ella.`);
  }
  return serie.codigo;
}

/** Serie de las proformas: la indicada (si es de proformas) o la por defecto. */
async function resolverSerieProforma(companyId: string, codigo: string | undefined): Promise<string> {
  if (!codigo) {
    const p = await obtenerSeriePorDefecto(companyId, 'PROFORMA');
    if (!p) throw badRequest('No hay serie de proformas configurada.');
    return p.codigo;
  }
  const serie = await obtenerOCrearSerie(companyId, String(codigo).trim(), 'PROFORMA');
  if (!serie.activa) throw badRequest(`La serie ${serie.codigo} está desactivada.`);
  if (serie.tipoDocumento !== 'PROFORMA') throw badRequest(`La serie ${serie.codigo} no es de proformas.`);
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
async function asignarNumero(
  tx: Tx,
  companyId: string,
  serie: string,
  fechaEmision: string,
  // Las proformas no son facturas: su numero no tiene que ir en orden de fechas.
  { controlarFecha = true }: { controlarFecha?: boolean } = {},
): Promise<number> {
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
  if (!controlarFecha) return s.ultimoNumero;
  if (s.ultimaFecha && fechaEmision < s.ultimaFecha) {
    throw badRequest(
      `La fecha de emisión (${fechaEmision}) no puede ser anterior a la de la última factura de la serie ${serie} (${s.ultimaFecha}).`,
    );
  }
  await tx.invoiceSeries.update({ where: { id: s.id }, data: { ultimaFecha: fechaEmision } });
  return s.ultimoNumero;
}

/** Transaccion de facturas: el tipo de cambio ya esta resuelto; dentro no se consulta la red. */
function transaccion<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction((tx) => marcarTransaccion(() => fn(tx)));
}

/** Carga una factura de la empresa con sus lineas, o 404. */
async function cargar(companyId: string, id: string): Promise<FacturaConLineas> {
  const factura = await buscarConLineas(companyId, id);
  if (!factura) throw notFound('Factura no encontrada.');
  return factura;
}

function exigirBorrador(f: FacturaConLineas, accion: string): void {
  if (f.estadoDocumento === ESTADO_PROFORMA) {
    throw badRequest(`La proforma ${f.numeroCompleto ?? ''} no se puede ${accion}: para facturarla usa «Pasar a factura».`);
  }
  if (f.estadoDocumento !== ESTADO_BORRADOR) {
    throw badRequest(
      `La factura ${f.numeroCompleto ?? ''} ya está emitida y no se puede ${accion}. Para corregirla, haz una factura rectificativa.`,
    );
  }
}

/** Se puede tocar: un borrador o una proforma aun pendiente. */
function exigirEditable(f: FacturaConLineas, accion: string): void {
  if (f.estadoDocumento === ESTADO_PROFORMA) {
    if (f.estado !== 'PENDIENTE') {
      throw badRequest(`La proforma ${f.numeroCompleto ?? ''} está ${f.estado.toLowerCase()} y ya no se puede ${accion}.`);
    }
    return;
  }
  exigirBorrador(f, accion);
}

/** Carga una proforma de la empresa, o 404 / 400 si no lo es. */
async function cargarProforma(companyId: string, id: string): Promise<FacturaConLineas> {
  const f = await buscarConLineas(companyId, id);
  if (!f) throw notFound('Proforma no encontrada.');
  if (f.estadoDocumento !== ESTADO_PROFORMA) throw badRequest('El documento no es una factura proforma.');
  return f;
}

/** Dias entre la emision y el vencimiento (se conservan al copiar o emitir). */
function plazoDias(f: { fechaEmision: string; fechaVencimiento: string }): number {
  return Math.max(
    0,
    Math.round(
      (new Date(`${f.fechaVencimiento}T00:00:00Z`).getTime() - new Date(`${f.fechaEmision}T00:00:00Z`).getTime()) / 86_400_000,
    ),
  );
}

/** Tipo heredado de la factura que se rectifica (misma moneda y mismo tipo). */
function tipoHeredado(original: FacturaConLineas, monedaCuenta: string): TipoResuelto {
  if (original.moneda === monedaCuenta) return { tipoCambio: 1, fechaTipoCambio: null, fuente: 'PAR', provisional: false };
  if (original.fuenteTipoCambio === 'PENDIENTE' || !(original.tipoCambio > 0)) {
    throw badRequest(`La factura ${original.numeroCompleto ?? ''} no tiene tipo de cambio fijado: no se puede rectificar.`);
  }
  return { tipoCambio: original.tipoCambio, fechaTipoCambio: original.fechaTipoCambio, fuente: 'HEREDADO', provisional: false };
}

/** Una rectificativa va en la moneda y al tipo de la factura que rectifica. */
function comprobarHerencia(original: FacturaConLineas, dto: { moneda?: string | null; tipoCambio?: unknown; tipoOperacion?: string | null }): void {
  if (hayValor(dto.moneda) && normalizarMoneda(dto.moneda) !== original.moneda) {
    throw badRequest(`Una rectificativa va en la moneda de la factura que rectifica (${original.moneda}).`);
  }
  if (hayValor(dto.tipoCambio) && validarFormatoTipoCambio(dto.tipoCambio) !== original.tipoCambio) {
    throw badRequest('Una rectificativa lleva el tipo de cambio de la factura que rectifica.');
  }
  if (hayValor(dto.tipoOperacion) && String(dto.tipoOperacion).trim().toUpperCase() !== (original.tipoOperacion ?? String(dto.tipoOperacion).trim().toUpperCase())) {
    throw badRequest('Una rectificativa lleva el tipo de operación de la factura que rectifica.');
  }
}

/** Herencia y lineas espejo de una rectificativa: solo se pasan desde este servicio. */
interface Interno {
  original?: FacturaConLineas;
  /** Rectificativa total: importes espejo de la original, sin recalcular. */
  importes?: ImportesFactura;
}

/**
 * Crea una factura (borrador, proforma, emitida o rectificativa). `opciones`
 * lo fija el servidor; `interno` solo lo usa este servicio.
 */
async function crear(dto: CrearFacturaIngresoDTO, opciones: { origen?: OrigenFactura }, interno: Interno): Promise<IncomeInvoiceResp> {
  const origen: OrigenFactura = opciones.origen ?? 'pantalla';
  let lineas = validarLineas(dto.lineas);
  if (dto.proforma && dto.facturaOriginalId) throw badRequest('Una proforma no puede ser una rectificativa.');
  const esRectificativa = !!dto.facturaOriginalId;
  const tipoFactura = validarTipoFactura(dto.tipoFactura, esRectificativa ? 'R1' : 'F1');
  if (esRectificativa !== tipoFactura.startsWith('R')) {
    throw badRequest('Una factura rectificativa debe ser de tipo R1 a R5, y solo las rectificativas pueden serlo.');
  }

  const perfil = await perfilEmpresa(dto.companyId);
  let original: FacturaConLineas | null = interno.original ?? null;
  if (esRectificativa && !original) {
    original = await buscarConLineas(dto.companyId, String(dto.facturaOriginalId));
    if (!original) throw badRequest('La factura que se rectifica no existe.');
  }
  if (original) comprobarHerencia(original, dto);
  const moneda = original ? original.moneda : validarMoneda(dto.moneda ?? perfil.monedaCuenta, perfil.monedasFactura);
  comprobarMonedaLineas(dto.lineas, moneda, false);

  const cliente = await resolverCliente(dto.companyId, dto.customer);
  const serie = dto.proforma
    ? await resolverSerieProforma(dto.companyId, dto.serie)
    : await resolverSerie(dto.companyId, dto.serie, esRectificativa);

  const fechaEmision = validarFecha(dto.fechaEmision ?? hoyISO(), 'fecha de emisión');
  const fechaVencimiento = validarFecha(dto.fechaVencimiento ?? sumarDias(fechaEmision, 15), 'fecha de vencimiento');
  if (fechaVencimiento < fechaEmision) throw badRequest('El vencimiento no puede ser anterior a la fecha de emisión.');
  const fechaOperacion = validarFechaOperacion(dto.fechaOperacion, fechaEmision);
  const devengo = fechaOperacion ?? fechaEmision;

  // Quien revisa la fiscalidad lo decide el servidor, nunca el cuerpo.
  const modo: ModoFiscal = esRectificativa
    ? 'heredar'
    : dto.proforma || dto.borrador
      ? 'guardar'
      : origen === 'lector'
        ? 'lector'
        : 'emitir';
  const fiscal = await resolverFiscalidad(
    {
      companyId: dto.companyId,
      perfil,
      cliente: cliente.fiscal,
      tipoOperacion: dto.tipoOperacion,
      causaExencion: dto.causaExencion,
      referenciaLegal: dto.referenciaLegal,
      tipoFactura,
      lineas,
      ...(original
        ? {
            heredado: {
              tipoOperacion: original.tipoOperacion,
              causaExencion: original.causaExencion,
              referenciaLegal: original.referenciaLegal,
            },
          }
        : {}),
    },
    modo,
  );
  // Las lineas espejo de una rectificativa total se copian tal cual de la original.
  if (!interno.importes) lineas = conFiscalidad(lineas, fiscal);

  // Tipo de cambio, ANTES de cualquier transaccion. Emitir exige el definitivo.
  const emite = !dto.proforma && !dto.borrador;
  const tipo = original
    ? tipoHeredado(original, perfil.monedaCuenta)
    : await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo, manual: dto.tipoCambio, definitivo: emite });
  if (emite && tipo.tipoCambio === null) throw badRequest(mensajeSinTipo(moneda, devengo));

  const importes =
    interno.importes ?? calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: moneda === perfil.monedaCuenta });
  const comunes = {
    companyId: dto.companyId,
    customerId: cliente.id,
    serie,
    fechaEmision,
    fechaVencimiento,
    fechaOperacion,
    tipoFactura,
    formaPago: validarFormaPago(dto.formaPago),
    ...cabecera(importes),
    moneda,
    ...datosTipo(tipo),
    tipoOperacion: fiscal.tipoOperacion,
    causaExencion: fiscal.causaExencion,
    referenciaLegal: fiscal.referenciaLegal,
    plantillaId: dto.plantillaId || 'default',
    observaciones: dto.observaciones,
    esRectificativa,
    facturaOriginalId: dto.facturaOriginalId,
    tipoRectificativa: esRectificativa ? (dto.tipoRectificativa ?? 'I') : null,
    motivoRectificacion: esRectificativa ? dto.motivoRectificacion : null,
    lineas: { create: lineasACrear(importes) },
  };
  const ctx: ContextoRespuesta = { monedaCuenta: perfil.monedaCuenta, avisosFiscales: fiscal.avisos, avisoTipoCambio: tipo.aviso };

  // Proforma: numero de su serie al crearla (sin huecos), sin efectos fiscales.
  if (dto.proforma) {
    const proforma = await transaccion(async (tx) => {
      const numero = await asignarNumero(tx, dto.companyId, serie, fechaEmision, { controlarFecha: false });
      return tx.incomeInvoice.create({
        data: {
          ...comunes,
          numero,
          numeroCompleto: `${serie}-${numero}`,
          estadoDocumento: ESTADO_PROFORMA,
          estado: 'PENDIENTE',
        },
        include: INCLUIR,
      });
    });
    return aRespuesta(proforma, ctx);
  }

  // Borrador: sin numero, no cuenta para nada hasta que se finalice.
  if (dto.borrador) {
    const factura = await prisma.incomeInvoice.create({
      data: { ...comunes, estadoDocumento: ESTADO_BORRADOR, estado: 'DRAFT' },
      include: INCLUIR,
    });
    return aRespuesta(factura, ctx);
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
      include: INCLUIR,
    });
    await prisma.invoiceSeries.updateMany({
      where: { companyId: dto.companyId, codigo: serie, ultimoNumero: { lt: dto.numero } },
      data: { ultimoNumero: dto.numero },
    });
    return aRespuesta(factura, ctx);
  }

  // Emision directa: numero de la serie en la misma transaccion.
  const factura = await transaccion(async (tx) => {
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
      include: INCLUIR,
    });
  });
  return aRespuesta(factura, ctx);
}

export const incomeInvoicesService = {
  /**
   * Crear factura de venta: como borrador (sin numero) o ya emitida.
   * `opciones.origen` lo pone quien llama desde el servidor (lector OCR,
   * copia); lo que llegue en el cuerpo con ese nombre se ignora.
   */
  async crearIngreso(dto: CrearFacturaIngresoDTO, opciones: { origen?: OrigenFactura } = {}): Promise<IncomeInvoiceResp> {
    const limpio = { ...dto } as CrearFacturaIngresoDTO & Record<string, unknown>;
    // Campos que fija el servidor: nunca desde el cuerpo.
    for (const campo of [
      'origen',
      'fuenteTipoCambio',
      'fechaTipoCambio',
      'baseTotalDoc',
      'ivaTotalDoc',
      'retencionTotalDoc',
      'totalFacturaDoc',
    ]) {
      delete limpio[campo];
    }
    return crear(limpio, { origen: opciones.origen }, {});
  },

  /** Modifica un borrador. Una factura emitida no se toca. */
  async actualizarBorrador(companyId: string, id: string, dto: ActualizarBorradorDTO): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirEditable(actual, 'modificar');
    exigirNoFinal(actual);
    const perfil = await perfilEmpresa(companyId);

    const data: Prisma.IncomeInvoiceUncheckedUpdateInput = {};
    let cliente = clienteFiscal(actual.customer);
    if (dto.customer) {
      const c = await resolverCliente(companyId, dto.customer);
      data.customerId = c.id;
      cliente = c.fiscal;
    }
    if (actual.estadoDocumento === ESTADO_PROFORMA) {
      // La proforma ya tiene su numero en la serie: no cambia de serie.
      if (dto.serie !== undefined && dto.serie !== actual.serie) {
        throw badRequest('Una proforma ya numerada no cambia de serie.');
      }
    } else if (dto.serie !== undefined) {
      data.serie = await resolverSerie(companyId, dto.serie, actual.esRectificativa);
    }
    let tipoFactura = actual.tipoFactura;
    if (dto.tipoFactura !== undefined) {
      const t = validarTipoFactura(dto.tipoFactura, 'F1');
      if (actual.esRectificativa !== t.startsWith('R')) throw badRequest('El tipo no corresponde a esta factura.');
      data.tipoFactura = t;
      tipoFactura = t;
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
    const fechaOperacion = validarFechaOperacion(
      dto.fechaOperacion !== undefined ? dto.fechaOperacion : actual.fechaOperacion,
      fechaEmision,
    );
    data.fechaOperacion = fechaOperacion;
    const devengo = fechaOperacion ?? fechaEmision;
    const devengoAntes = actual.fechaOperacion ?? actual.fechaEmision;

    // Moneda: los precios no se convierten solos.
    const original = actual.esRectificativa && actual.facturaOriginalId ? await buscarConLineas(companyId, actual.facturaOriginalId) : null;
    if (original) comprobarHerencia(original, dto);
    let moneda = actual.moneda;
    if (!original && hayValor(dto.moneda)) {
      moneda = validarMoneda(dto.moneda, perfil.monedasFactura);
      if (moneda !== actual.moneda && !dto.lineas) {
        throw badRequest('Los precios no se convierten: envía las líneas en la nueva moneda.');
      }
    }
    if (dto.lineas) comprobarMonedaLineas(dto.lineas, moneda, moneda !== perfil.monedaCuenta);
    const misma = moneda === perfil.monedaCuenta;

    // Fiscalidad con el estado combinado (lo nuevo y lo que ya habia).
    let lineas = dto.lineas ? validarLineas(dto.lineas) : lineasDocGuardadas(actual);
    const fiscal = await resolverFiscalidad(
      {
        companyId,
        perfil,
        cliente,
        tipoOperacion: dto.tipoOperacion !== undefined ? dto.tipoOperacion : actual.tipoOperacion,
        causaExencion: dto.causaExencion !== undefined ? dto.causaExencion : actual.causaExencion,
        referenciaLegal: dto.referenciaLegal !== undefined ? dto.referenciaLegal : actual.referenciaLegal,
        tipoFactura,
        lineas,
        ...(original
          ? {
              heredado: {
                tipoOperacion: original.tipoOperacion,
                causaExencion: original.causaExencion,
                referenciaLegal: original.referenciaLegal,
              },
            }
          : {}),
      },
      actual.esRectificativa ? 'heredar' : 'guardar',
    );
    data.tipoOperacion = fiscal.tipoOperacion;
    data.causaExencion = fiscal.causaExencion;
    data.referenciaLegal = fiscal.referenciaLegal;
    const normaliza = fiscal.lineas.some((l, i) => l.tipoIva !== (lineas[i].tipoIva ?? 21) || l.tipoRetencion !== (lineas[i].tipoRetencion ?? 0));
    lineas = conFiscalidad(lineas, fiscal);

    // Tipo de cambio: se vuelve a pedir si cambian la moneda o el devengo (salvo el manual).
    let tipo: TipoResuelto | null = null;
    const cambiaTipo = dto.tipoCambio !== undefined;
    if (misma) {
      if (hayValor(dto.tipoCambio) || moneda !== actual.moneda || actual.fuenteTipoCambio !== 'PAR') {
        tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo, manual: dto.tipoCambio, definitivo: false });
      }
    } else if (original) {
      tipo = tipoHeredado(original, perfil.monedaCuenta);
    } else if (hayValor(dto.tipoCambio)) {
      tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo, manual: dto.tipoCambio, definitivo: false });
    } else {
      const conservaManual = actual.fuenteTipoCambio === 'MANUAL' && dto.tipoCambio !== null && moneda === actual.moneda;
      const conservaBce = actual.fuenteTipoCambio === 'BCE' && !cambiaTipo && moneda === actual.moneda && devengo === devengoAntes;
      if (!conservaManual && !conservaBce) {
        tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo, definitivo: false });
      }
    }
    const tipoCambio = tipo ? tipo.tipoCambio : actual.fuenteTipoCambio === 'PENDIENTE' ? null : actual.tipoCambio;
    if (tipo) Object.assign(data, datosTipo(tipo));
    if (moneda !== actual.moneda) data.moneda = moneda;

    const recalcular = !!dto.lineas || normaliza || moneda !== actual.moneda || (tipo !== null && tipo.tipoCambio !== actual.tipoCambio) || (tipo !== null && tipo.fuente !== actual.fuenteTipoCambio);
    const factura = await transaccion(async (tx) => {
      if (recalcular) {
        exigirNoFinal(actual);
        const importes = calcularImportesFactura(lineas, { tipoCambio, mismaMoneda: misma });
        await tx.incomeInvoiceLine.deleteMany({ where: { invoiceId: id } });
        Object.assign(data, cabecera(importes), { lineas: { create: lineasACrear(importes) } });
      }
      return tx.incomeInvoice.update({ where: { id }, data, include: INCLUIR });
    });
    return aRespuesta(factura, { monedaCuenta: perfil.monedaCuenta, avisosFiscales: fiscal.avisos, avisoTipoCambio: tipo?.aviso });
  },

  /**
   * Borra un borrador o una proforma pendiente. Las facturas emitidas no se
   * borran nunca.
   *  - Si era la ultima proforma de su serie, el contador retrocede (sin huecos).
   *  - Si el borrador nacio de una proforma, la proforma vuelve a PENDIENTE.
   */
  async eliminarBorrador(companyId: string, id: string): Promise<void> {
    const actual = await cargar(companyId, id);
    exigirEditable(actual, 'borrar');
    await prisma.$transaction(async (tx) => {
      await tx.incomeInvoice.delete({ where: { id } });
      if (actual.estadoDocumento === ESTADO_PROFORMA && actual.numero) {
        await tx.invoiceSeries.updateMany({
          where: { companyId, codigo: actual.serie, ultimoNumero: actual.numero },
          data: { ultimoNumero: actual.numero - 1 },
        });
      }
      if (actual.proformaId) {
        await tx.incomeInvoice.updateMany({
          where: { id: actual.proformaId, companyId, estadoDocumento: ESTADO_PROFORMA, estado: 'ACEPTADA' },
          data: { estado: 'PENDIENTE' },
        });
      }
    });
  },

  /**
   * "Pasar a factura" una proforma que el cliente acepta: crea un BORRADOR de
   * factura en la serie de facturas por defecto, con el cliente, las lineas, la
   * forma de pago, las observaciones, la moneda y el tipo de operacion de la
   * proforma, enlazado a ella (proformaId). El tipo de cambio NO se hereda: se
   * pide el de hoy. La proforma queda ACEPTADA. Una proforma solo se pasa una vez.
   */
  async pasarProformaAFactura(companyId: string, id: string): Promise<IncomeInvoiceResp> {
    const p = await cargarProforma(companyId, id);
    if (p.estado === 'ACEPTADA') throw badRequest(`La proforma ${p.numeroCompleto} ya se pasó a factura.`);
    if (p.estado !== 'PENDIENTE') {
      throw badRequest(`La proforma ${p.numeroCompleto} está rechazada: duplícala si el cliente cambia de idea.`);
    }
    if (p.lineas.length === 0) throw badRequest('La proforma no tiene líneas.');

    const perfil = await perfilEmpresa(companyId);
    const serie = await resolverCodSerieFactura(companyId, {});
    const hoy = hoyISO();
    const tipoFactura = p.tipoFactura.startsWith('R') ? 'F1' : p.tipoFactura;
    let lineas = lineasDocGuardadas(p);
    const fiscal = await resolverFiscalidad(
      {
        companyId,
        perfil,
        cliente: clienteFiscal(p.customer),
        tipoOperacion: p.tipoOperacion === 'EMPRESA_EXTRANJERA' ? null : p.tipoOperacion,
        causaExencion: p.causaExencion,
        referenciaLegal: p.referenciaLegal,
        tipoFactura,
        lineas,
      },
      'guardar',
    );
    lineas = conFiscalidad(lineas, fiscal);
    const tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: p.moneda, devengo: hoy, definitivo: false });
    const importes = calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: p.moneda === perfil.monedaCuenta });

    const factura = await transaccion(async (tx) => {
      // Solo si sigue pendiente: dos clics a la vez no crean dos facturas.
      const r = await tx.incomeInvoice.updateMany({
        where: { id, companyId, estadoDocumento: ESTADO_PROFORMA, estado: 'PENDIENTE' },
        data: { estado: 'ACEPTADA' },
      });
      if (r.count !== 1) throw badRequest(`La proforma ${p.numeroCompleto} ya se pasó a factura.`);
      return tx.incomeInvoice.create({
        data: {
          companyId,
          customerId: p.customerId,
          serie,
          fechaEmision: hoy,
          fechaVencimiento: sumarDias(hoy, plazoDias(p)),
          tipoFactura,
          formaPago: p.formaPago,
          ...cabecera(importes),
          moneda: p.moneda,
          ...datosTipo(tipo),
          tipoOperacion: fiscal.tipoOperacion,
          causaExencion: fiscal.causaExencion,
          referenciaLegal: fiscal.referenciaLegal,
          plantillaId: p.plantillaId,
          observaciones: p.observaciones,
          esRectificativa: false,
          proformaId: p.id,
          estadoDocumento: ESTADO_BORRADOR,
          estado: 'DRAFT',
          lineas: { create: lineasACrear(importes) },
        },
        include: INCLUIR,
      });
    });
    return aRespuesta(factura, { monedaCuenta: perfil.monedaCuenta, avisosFiscales: fiscal.avisos, avisoTipoCambio: tipo.aviso });
  },

  /** El cliente no acepta la proforma: queda RECHAZADA (solo se puede ver, descargar o duplicar). */
  async rechazarProforma(companyId: string, id: string): Promise<IncomeInvoiceResp> {
    const p = await cargarProforma(companyId, id);
    if (p.estado !== 'PENDIENTE') throw badRequest(`La proforma ${p.numeroCompleto} ya está ${p.estado.toLowerCase()}.`);
    const r = await prisma.incomeInvoice.updateMany({
      where: { id, companyId, estadoDocumento: ESTADO_PROFORMA, estado: 'PENDIENTE' },
      data: { estado: 'RECHAZADA' },
    });
    if (r.count !== 1) throw badRequest(`La proforma ${p.numeroCompleto} ya no está pendiente.`);
    return aRespuesta(await cargar(companyId, id), { monedaCuenta: (await perfilEmpresa(companyId)).monedaCuenta });
  },

  /**
   * Emite un borrador: le da el siguiente numero de su serie y congela sus datos.
   * La fecha de emision es la indicada o, si no, hoy.
   *
   * Antes de la transaccion se fijan:
   *  - el tipo de operacion (el elegido o el deducido; la empresa no espanola,
   *    sin IVA ni retencion);
   *  - el tipo de cambio: el heredado (rectificativa); si no, el manual que
   *    llegue; si no, el manual del borrador si el devengo no ha cambiado; si
   *    no, el del BCE del devengo definitivo (nunca uno viejo: sin el, 400).
   * Dentro de la transaccion se numera y se guardan lineas y cabecera.
   */
  async finalizar(
    companyId: string,
    id: string,
    opciones: { fechaEmision?: string; tipoCambio?: unknown } = {},
  ): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirBorrador(actual, 'volver a emitir');
    // Art. 6 RD 1619/2012: la factura lleva el nombre y el NIF del emisor.
    const emisor = await prisma.legalConfig.findUnique({ where: { companyId } });
    const perfil = perfilDesdeConfig(emisor);
    if (!emisor?.nif?.trim() || !emisor?.denominacion?.trim()) {
      throw badRequest(
        perfil.espanola
          ? 'Antes de emitir facturas rellena la denominación y el NIF de tu empresa en Registro Mercantil > Datos para la memoria.'
          : 'Antes de emitir facturas rellena la denominación y la identificación fiscal de tu empresa en Registro Mercantil > Datos para la memoria.',
      );
    }
    if (actual.lineas.length === 0) throw badRequest('La factura no tiene líneas.');
    if (actual.esRectificativa && !actual.motivoRectificacion?.trim()) {
      throw badRequest('Indica el motivo de la rectificación antes de emitirla.');
    }

    const fechaEmision = validarFecha(opciones.fechaEmision ?? hoyISO(), 'fecha de emisión');
    // Se mantienen los dias de plazo que tenia el borrador.
    const fechaVencimiento = sumarDias(fechaEmision, plazoDias(actual));
    const fechaOperacion = actual.fechaOperacion && actual.fechaOperacion !== fechaEmision ? actual.fechaOperacion : null;
    const devengo = fechaOperacion ?? fechaEmision;
    const devengoBorrador = actual.fechaOperacion ?? actual.fechaEmision;

    // Tipo de operacion definitivo, con el cliente y la empresa de ahora.
    const original = actual.esRectificativa && actual.facturaOriginalId ? await buscarConLineas(companyId, actual.facturaOriginalId) : null;
    let lineas = lineasDocGuardadas(actual);
    const fiscal = await resolverFiscalidad(
      {
        companyId,
        perfil,
        cliente: clienteFiscal(actual.customer),
        tipoOperacion: actual.tipoOperacion,
        causaExencion: actual.causaExencion,
        referenciaLegal: actual.referenciaLegal,
        tipoFactura: actual.tipoFactura,
        lineas,
        ...(original
          ? {
              heredado: {
                tipoOperacion: original.tipoOperacion,
                causaExencion: original.causaExencion,
                referenciaLegal: original.referenciaLegal,
              },
            }
          : {}),
      },
      actual.esRectificativa ? 'heredar' : 'emitir',
    );
    const normaliza = fiscal.lineas.some((l, i) => l.tipoIva !== (lineas[i].tipoIva ?? 21) || l.tipoRetencion !== (lineas[i].tipoRetencion ?? 0));
    lineas = conFiscalidad(lineas, fiscal);

    // Tipo de cambio definitivo.
    const misma = actual.moneda === perfil.monedaCuenta;
    let tipo: TipoResuelto;
    if (misma) {
      tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: actual.moneda, devengo, manual: opciones.tipoCambio, definitivo: true });
    } else if (actual.fuenteTipoCambio === 'HEREDADO' || original) {
      if (hayValor(opciones.tipoCambio) && validarFormatoTipoCambio(opciones.tipoCambio) !== actual.tipoCambio) {
        throw badRequest('Una rectificativa lleva el tipo de cambio de la factura que rectifica.');
      }
      tipo = original
        ? tipoHeredado(original, perfil.monedaCuenta)
        : { tipoCambio: actual.tipoCambio, fechaTipoCambio: actual.fechaTipoCambio, fuente: 'HEREDADO', provisional: false };
    } else if (hayValor(opciones.tipoCambio)) {
      tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: actual.moneda, devengo, manual: opciones.tipoCambio, definitivo: true });
    } else if (actual.fuenteTipoCambio === 'MANUAL' && devengo === devengoBorrador) {
      tipo = { tipoCambio: actual.tipoCambio, fechaTipoCambio: actual.fechaTipoCambio, fuente: 'MANUAL', provisional: false };
    } else {
      tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: actual.moneda, devengo, definitivo: true });
    }
    if (tipo.tipoCambio === null) throw badRequest(mensajeSinTipo(actual.moneda, devengo));

    // EUR -> EUR sin normalizar: no se recalcula nada (igual bit a bit que antes).
    const recalcular = !misma || normaliza;
    exigirNoFinal(actual);
    const importes = recalcular ? calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: misma }) : null;

    const factura = await transaccion(async (tx) => {
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
          fechaOperacion,
          estado: determinarEstado(fechaVencimiento),
          ...datosTipo(tipo),
          tipoOperacion: fiscal.tipoOperacion,
          causaExencion: fiscal.causaExencion,
          referenciaLegal: fiscal.referenciaLegal,
          ...(importes ? cabecera(importes) : {}),
        },
      });
      if (r.count !== 1) throw badRequest('La factura ya se había emitido.');
      if (importes) {
        // Se releen las lineas: si alguien las ha cambiado mientras tanto, no se emite con importes viejos.
        const ahora = await tx.incomeInvoiceLine.findMany({ where: { invoiceId: id }, select: { id: true } });
        const calculadas = new Set(actual.lineas.map((l) => l.id));
        if (ahora.length !== calculadas.size || ahora.some((l) => !calculadas.has(l.id))) {
          throw badRequest('La factura ha cambiado mientras se emitía: vuelve a intentarlo.');
        }
        for (let i = 0; i < actual.lineas.length; i++) {
          await tx.incomeInvoiceLine.update({ where: { id: actual.lineas[i].id }, data: importesLinea(importes.lineas[i]) });
        }
      }
      return tx.incomeInvoice.findUniqueOrThrow({ where: { id }, include: INCLUIR });
    });
    return aRespuesta(factura, { monedaCuenta: perfil.monedaCuenta, avisosFiscales: fiscal.avisos, avisoTipoCambio: tipo.aviso });
  },

  /**
   * Copia una factura (emitida o no) en un borrador nuevo, con fecha de hoy.
   * Una proforma se copia en otra proforma (con el siguiente numero de su serie).
   * Se copian la moneda, los precios en esa moneda y el tipo de operacion
   * elegido; el tipo de cambio no: se pide el de hoy.
   */
  async duplicar(companyId: string, id: string): Promise<IncomeInvoiceResp> {
    const o = await cargar(companyId, id);
    if (o.esRectificativa) throw badRequest('Las rectificativas no se duplican; crea una nueva desde la factura original.');
    const esProforma = o.estadoDocumento === ESTADO_PROFORMA;
    const plazo = plazoDias(o);
    const hoy = hoyISO();
    return crear(
      {
        companyId,
        customer: { id: o.customerId },
        serie: o.serie,
        fechaEmision: hoy,
        fechaVencimiento: sumarDias(hoy, plazo),
        tipoFactura: o.tipoFactura as TipoFactura,
        formaPago: o.formaPago as FormaPago,
        plantillaId: o.plantillaId,
        observaciones: o.observaciones ?? undefined,
        borrador: !esProforma,
        proforma: esProforma,
        moneda: o.moneda,
        tipoOperacion: o.tipoOperacion === 'EMPRESA_EXTRANJERA' ? null : o.tipoOperacion,
        causaExencion: o.causaExencion,
        referenciaLegal: o.referenciaLegal,
        lineas: lineasDocGuardadas(o).map((l) => ({ ...l, moneda: o.moneda })),
      },
      { origen: 'copia' },
      {},
    );
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
      tipoOperacion?: string;
      moneda?: string;
      skip?: number;
      take?: number;
    },
  ) {
    const skip = filtros?.skip ?? 0;
    const take = filtros?.take ?? 20;

    const where: Prisma.IncomeInvoiceWhereInput = { companyId };
    if (filtros?.estado) where.estado = filtros.estado;
    // Las proformas no son facturas: solo salen si se piden (?estadoDocumento=PROFORMA).
    where.estadoDocumento = filtros?.estadoDocumento ? filtros.estadoDocumento : { not: ESTADO_PROFORMA };
    if (filtros?.customerId) where.customerId = filtros.customerId;
    if (filtros?.tipoOperacion) where.tipoOperacion = String(filtros.tipoOperacion).toUpperCase();
    if (filtros?.moneda) where.moneda = normalizarMoneda(filtros.moneda);
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
        // Moneda de cuenta (las de siempre) y de la factura.
        baseTotal: f.baseTotal,
        ivaTotal: f.ivaTotal,
        retencionTotal: f.retencionTotal,
        totalFactura: f.totalFactura,
        moneda: f.moneda,
        totalFacturaDoc: f.totalFacturaDoc ?? f.totalFactura,
        tipoCambio: f.tipoCambio,
        fuenteTipoCambio: f.fuenteTipoCambio,
        tipoOperacion: f.tipoOperacion,
        esRectificativa: f.esRectificativa,
        facturaOriginalId: f.facturaOriginalId,
        proformaId: f.proformaId,
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
    const f = await cargar(companyId, id);
    const resp = aRespuesta(f, { monedaCuenta: (await perfilEmpresa(companyId)).monedaCuenta });
    if (f.estadoDocumento === ESTADO_PROFORMA && f.estado === 'ACEPTADA') {
      const generada = await prisma.incomeInvoice.findFirst({ where: { companyId, proformaId: f.id }, select: { id: true } });
      if (generada) resp.facturaGeneradaId = generada.id;
    }
    return resp;
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
    if (factura.estadoDocumento === ESTADO_PROFORMA) {
      throw badRequest('Una proforma no se cobra: pásala a factura y emítela antes.');
    }
    if (factura.estadoDocumento !== ESTADO_FINAL) {
      throw badRequest('La factura está en borrador: emítela antes de marcar el cobro.');
    }
    const ctx = { monedaCuenta: (await perfilEmpresa(companyId)).monedaCuenta };
    if (nuevoEstado === 'PAID') {
      const { importePendiente } = await listarCobros(companyId, 'INGRESO', id);
      if (importePendiente > 0) {
        await registrarCobroFactura(companyId, 'INGRESO', id, { ...datosCobro, importe: undefined });
      }
      return aRespuesta(await cargar(companyId, id), ctx);
    }
    if (await tieneCobrosActivos(companyId, 'INGRESO', id)) {
      throw badRequest('La factura tiene cobros registrados: para dejarla pendiente, anula esos cobros desde la ficha de la factura.');
    }
    const actualizada = await prisma.incomeInvoice.update({
      where: { id },
      data: { estado: nuevoEstado },
      include: INCLUIR,
    });
    return aRespuesta(actualizada, ctx);
  },

  /**
   * Crear factura rectificativa de una factura emitida, en la serie de
   * rectificativas. Por defecto es "por diferencias" (I) y anula la original
   * entera: copia espejo de TODOS sus importes (documento y cuenta), sin
   * recalcular, para que la pareja sume 0 exacto. Con `lineas` se rectifica
   * solo una parte (en la moneda de la original y a su tipo de cambio).
   * Hereda la moneda, el tipo de cambio y el tipo de operacion de la original.
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
      moneda?: string;
      tipoCambio?: unknown;
      tipoOperacion?: string;
    } = {},
  ): Promise<IncomeInvoiceResp> {
    const original = await cargar(companyId, facturaOriginalId);
    if (original.estadoDocumento === ESTADO_PROFORMA) {
      throw badRequest('Una proforma no se rectifica: mientras esté pendiente, modifícala.');
    }
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
    comprobarHerencia(original, { moneda: opciones.moneda, tipoCambio: opciones.tipoCambio, tipoOperacion: opciones.tipoOperacion });

    const interno: Interno = { original };
    let lineas: CrearLineaIngresoDTO[];
    if (opciones.lineas) {
      lineas = opciones.lineas;
    } else {
      interno.importes = lineasEspejo(importesGuardados(original));
      lineas = interno.importes.lineas.map((l) => ({
        descripcion: l.descripcion,
        cantidad: l.cantidad,
        precioUnitario: l.doc.precioUnitario,
        descuentoPorcentaje: l.descuentoPorcentaje,
        tipoIva: l.tipoIva,
        tipoRetencion: l.tipoRetencion,
        productoServicioId: l.productoServicioId,
      }));
    }

    return crear(
      {
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
      },
      { origen: 'pantalla' },
      interno,
    );
  },

  /**
   * Obtener resumen de ingresos por período (para el dashboard).
   * Solo facturas emitidas: los borradores no son ventas todavía.
   * Importes en la moneda de cuenta.
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
