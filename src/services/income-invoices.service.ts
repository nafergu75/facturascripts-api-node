import type { Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../utils/http-errors';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import {
  buscarSeriePorCodigo,
  obtenerOCrearSerieHistorica,
  obtenerOCrearSerieTickets,
  obtenerSeriePorDefecto,
  problemaSerieAeat,
  resolverCodSerieFactura,
  serieCompatible,
  type NecesidadPlantilla,
} from './series.service';
import { admiteEnvases, ivaPorTipo, limpiarTextoAdicional, normalizarPlantillaId, type PlantillaVentaId } from '../domain/plantillasFactura';
import { calcularIeepnr, redondearKg, resumenEnvases, type ResumenEnvases } from '../domain/ieepnr';
import type { TipoDocumentoSerie } from '../domain/series.model';
import { listarCobros, recalcularEstadoCobroVenta, registrarCobroFactura, tieneCobrosActivos, type DatosCobro } from './cobrosPagos.service';
import { comprobarFechaAbierta } from './periodos.service';
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
  fechaDevengoVenta,
  inferirTipoOperacion,
  mencionFiscal,
  operacionEfectiva,
  type AvisoFiscal,
  type ClienteFiscal,
  type Mencion,
  type ModoFiscal,
  type TipoOperacionVenta,
} from '../domain/tipo-operacion.model';
import { perfilDesdeConfig, perfilEmpresa, type PerfilEmpresa } from './perfilEmpresa.service';
import { marcarTransaccion, mensajeSinTipo, resolverTipoCambio, type TipoResuelto } from './tiposCambio.service';
import { resolverFiscalidad } from './fiscalidad-venta.service';
import { diferenciasDeSustituciones } from './resumenFiscal.service';
import { fechaTexto, hoyEspana, sumarDiasISO } from '../utils/fechas';
import { inicioLlevanzaApp, periodo303FueraDeLaApp, regimenFiscalEn } from '../utils/anios';
import { aCentimos, importeTexto } from '../utils/money';
import { copiaAlEmitir, cuentaBancariaDeCobro, leerAjustesFacturacion } from './ajustesFacturacion.service';
import { FORMAS_PAGO, type FormaPago } from '../domain/ajustes.model';
import { leerPais } from './clientes.service';
import { crearClienteConSubcuenta } from './terceros/subcuentas';
import { esCuentaDeTipo, problemaCuentasLinea } from './cuentasLinea.service';
import { MOTIVOS_VENTA } from '../domain/rectificativa-venta.model';
import { recalcularEstadoPartidas } from './arranque/partidas.service';
import { ahoraRedSeguridad, exigirPuedeEmitirFinal } from './verifactu/redSeguridad';
import {
  aFavorDeAbonos,
  AISLAMIENTO_RECTIFICATIVAS,
  cerrarPlan,
  enlacesDeVentas,
  exigirLimites,
  exigirRectificablesEnTx,
  exigirRetencionDeOriginales,
  exigirTipoRectificativaDisponible,
  guardarEnlacesVenta,
  leerBloque,
  prepararRectificativaVenta,
  rectificadaPorDe,
  restantePorOriginal,
  lineasImportesDe,
  type BloqueVenta,
  type EnlaceVenta,
  type PlanVenta,
  type RectificativaResp,
} from './rectificativasVenta.service';

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

/** Formas de pago que se imprimen en la factura (viven en domain/ajustes.model). */
export { FORMAS_PAGO, type FormaPago };

/** Estados de cobro que se pueden poner a mano en una factura final. */
export const ESTADOS_COBRO = ['PENDING', 'PAID', 'OVERDUE'] as const;

/**
 * De donde nace la factura (columna IncomeInvoice.origen, spec verifactu 2.8).
 * Lo fija el servidor, nunca el cuerpo de la peticion:
 *  - pantalla: alta a mano (tambien la rectificativa);
 *  - api: reservado para integraciones que se identifiquen como tales;
 *  - copia: duplicar y «pasar a factura» una proforma;
 *  - lector: factura que expidio otro programa (no genera registro VERI*FACTU).
 */
export type OrigenFactura = 'pantalla' | 'api' | 'copia' | 'lector';

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
  fechaVencimiento?: string; // YYYY-MM-DD, defecto: fechaEmision + los días de Configuración > Facturación (30 si no se han tocado)
  /** Fecha de la operacion (devengo) si es distinta de la de emision: fija el tipo de cambio. */
  fechaOperacion?: string | null;
  lineas: CrearLineaIngresoDTO[];
  /**
   * Se ignora: la plantilla la fija el servidor (la de la serie; en una
   * rectificativa de una factura de la app, la de la original; del lector, la
   * estandar). Se deja en el tipo por compatibilidad con clientes antiguos.
   */
  plantillaId?: string;
  /** Plantilla A: peso bruto en kg escrito a mano (>= 0 y hasta 3 decimales). */
  pesoBrutoKg?: number | null;
  observaciones?: string;
  /** true: se guarda como borrador, sin numero. Por defecto se emite (final). */
  borrador?: boolean;
  /** true: factura proforma (serie P, numero al crearla, sin efectos fiscales). */
  proforma?: boolean;
  tipoFactura?: TipoFactura;
  /** Transferencia bancaria, giro (recibo domiciliado) o contado. Defecto: el de Configuración > Facturación. */
  formaPago?: FormaPago;
  facturaOriginalId?: string; // Si es rectificativa
  /**
   * Rectificativa de una factura emitida FUERA de la app antes de llevar en
   * ella la facturacion (p. ej. una de 2026 que trajo la gestoria): su numero
   * y su fecha. En lugar de facturaOriginalId; solo por diferencias (I).
   */
  rectificaFuera?: { numero?: unknown; fecha?: unknown } | null;
  tipoRectificativa?: 'S' | 'I';
  motivoRectificacion?: string;
  /**
   * Rectificativa o abono (bloque nuevo, services/rectificativasVenta.service.ts):
   * ticket, forma (I/S), motivo, explicacion y que rectifica (facturas de la
   * app, de fuera o un periodo). No se junta con facturaOriginalId,
   * rectificaFuera ni tipoRectificativa (los campos de antes).
   */
  rectificativa?: unknown;
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
  /**
   * true: se emite aunque la operacion sea de un periodo cuyo 303 presenta la
   * gestoria (ver devengoEnPeriodoDeFuera). Sin ella, 409 DEVENGO_FUERA_APP.
   */
  confirmaDevengoFuera?: boolean;
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
  /**
   * Cuenta de ingresos de la linea (70x: 700, 705, 7050001...). Sin ella, la
   * del producto (la suya, la de su familia o 705 si es un servicio) y, si no
   * hay producto, la 700.
   */
  cuenta?: string | null;
  /** Moneda de la linea (la de la factura). Obligatoria al modificar un borrador en divisa. */
  moneda?: string;
  /** Plantilla A: packs de la linea (entero). `cantidad` sigue siendo las unidades. */
  packs?: number | null;
  /** Plantilla A: kg de plastico no reciclado de la linea (se redondea a 3 decimales). */
  kgPlastico?: number | null;
  /** Plantilla A: texto bajo el concepto (500 caracteres y 6 lineas como mucho). */
  textoAdicional?: string | null;
  /** Se ignora: el IEEPNR lo calcula el servidor (kg x tipo). */
  ieepnrImporte?: unknown;
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
    | 'rectificativa'
    | 'pesoBrutoKg'
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
  /** Plantilla de la factura: la fija el servidor (domain/plantillasFactura). */
  plantillaId: PlantillaVentaId;
  /** Plantilla A: peso bruto en kg escrito a mano. */
  pesoBrutoKg: number | null;
  /** Tipo del IEEPNR aplicado (EUR por kg); null = sin IEEPNR. */
  ieepnrPorKg: number | null;
  /** Totales de envases (kg, packs, uds e IEEPNR); null si la plantilla no lleva envases. */
  resumenEnvases: ResumenEnvases | null;
  observaciones?: string;
  esRectificativa: boolean;
  facturaOriginalId?: string;
  /** Rectificativa de una factura de fuera de la app: su numero y su fecha. */
  rectificaFuera?: { numero: string; fecha: string | null };
  /** Factura nacida de una proforma: id de esa proforma. */
  proformaId?: string;
  /** Proforma ya pasada a factura: id de la factura creada. */
  facturaGeneradaId?: string;
  /** Solo en la ficha (obtenerPorId): rectificativas emitidas de esta factura (por sus enlaces y por facturaOriginalId). */
  /** totalFactura: el de la rectificativa entera; parte: lo que toca a esta factura (su reparto o, por sustitucion, la diferencia). */
  rectificadaPor?: Array<{ id: string; numeroCompleto: string | null; fechaEmision: string; totalFactura: number; parte: number; tipoRectificativa: string | null; tipoFactura: string }>;
  /** Rectificativas: que rectifica (facturas de la app o de fuera, o un periodo), forma, motivo y explicacion. */
  rectificativa?: RectificativaResp;
  /** Solo en la ficha de un abono (total < 0): lo que queda a favor del cliente, en la moneda de la factura y sin lo ya devuelto. */
  aFavor?: number;
  /** Solo en la ficha: sus rectificativas la dejan a cero (anulada entera). */
  anuladaPorCompleto?: boolean;
  /** Solo en la ficha: el asiento de la factura (no el de sus cobros), o null si no tiene. */
  asiento?: { id: string; numero: string | null; estado: string } | null;
  /** Solo en la ficha de una emitida: IBAN impreso al emitirla ('' = sin IBAN; null = anterior a esa copia). */
  ibanCobro?: string | null;
  /** Solo en la ficha de una emitida: cuenta bancaria activa que se propone al cobrarla (null si no hay ninguna). */
  cuentaBancariaCobroId?: string | null;
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
  /** Cuenta de ingresos de la linea; null = la generica (700). */
  cuenta: string | null;
  /** Plantilla A: packs de la linea. */
  packs: number | null;
  /** Plantilla A: kg de plastico no reciclado. */
  kgPlastico: number | null;
  /**
   * IEEPNR de la linea en EUR (0 si no hay). Va DENTRO de baseLine y
   * baseLineDoc, que son la base imponible: el TOTAL del articulo es
   * baseLineDoc - ieepnrImporte.
   */
  ieepnrImporte: number;
  /** Texto adicional bajo el concepto. */
  textoAdicional: string | null;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
/** Hoy en hora peninsular: el vencimiento y la fecha de emisión por defecto no dependen de la zona del servidor. */
const hoyISO = (): string => hoyEspana();
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

/**
 * Tipo con el que se trata la factura: el guardado; si no, el de siempre
 * (emitidas anteriores, con el pais del cliente congelado en ellas) o el que se
 * deduce (borradores).
 */
function tipoOperacionEfectivo(f: FacturaConLineas): TipoOperacionVenta | null {
  if (esTipoOperacion(f.tipoOperacion)) return f.tipoOperacion;
  const cliente = clienteFiscal(f.customer);
  if (f.estadoDocumento === ESTADO_FINAL) return operacionEfectiva(f, cliente);
  return inferirTipoOperacion(cliente, f.lineas);
}

/**
 * Mencion fiscal que lleva (o llevara) el PDF: la de su tipo guardado o, en un
 * borrador o proforma, la del que se deduce. Una factura emitida sin tipo
 * (anterior a esta funcion) no lleva mencion propia, igual que su PDF.
 */
function mencionDeFactura(f: FacturaConLineas, efectivo: TipoOperacionVenta | null): Mencion | null {
  if (f.estadoDocumento === ESTADO_FINAL && !esTipoOperacion(f.tipoOperacion)) return null;
  return mencionFiscal(efectivo, { cliente: clienteFiscal(f.customer), causaExencion: f.causaExencion, referenciaLegal: f.referenciaLegal });
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
    mencionFiscal: mencionDeFactura(f, efectivo),
    ...(ctx.avisosFiscales?.length ? { avisosFiscales: ctx.avisosFiscales } : {}),
    plantillaId: normalizarPlantillaId(f.plantillaId),
    pesoBrutoKg: f.pesoBrutoKg ?? null,
    ieepnrPorKg: f.ieepnrPorKg ?? null,
    resumenEnvases: admiteEnvases(f.plantillaId)
      ? resumenEnvases(f.lineas.map((l) => ({ cantidad: l.cantidad, packs: l.packs, kgPlastico: l.kgPlastico, ieepnrImporte: l.ieepnrImporte })))
      : null,
    observaciones: f.observaciones ?? undefined,
    esRectificativa: f.esRectificativa,
    facturaOriginalId: f.facturaOriginalId ?? undefined,
    ...(f.rectificaFueraNumero ? { rectificaFuera: { numero: f.rectificaFueraNumero, fecha: f.rectificaFueraFecha ?? null } } : {}),
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
      cuenta: l.accountCode ?? null,
      packs: l.packs ?? null,
      kgPlastico: l.kgPlastico ?? null,
      ieepnrImporte: l.ieepnrImporte ?? 0,
      textoAdicional: l.textoAdicional ?? null,
    })),
  };
}

/**
 * Pais del cliente nuevo, con la misma regla que la ficha de clientes
 * (leerPais): ISO-2 que exista, o el del prefijo de su NIF-IVA si viene vacio o
 * ES. 'SP' o 'Espana' dan 400: guardados tal cual, el cliente pasaba por
 * extranjero y sus facturas al 0 % por exportaciones.
 */
function paisClienteNuevo(pais: string | undefined, nifCif: string): string {
  return leerPais(pais, nifCif) ?? 'ES';
}

/**
 * Resuelve o crea el cliente. Devuelve su id y sus datos fiscales.
 */
/** Numero y fecha de la factura de fuera de la app que se rectifica (rectificaFuera), validados. */
function leerRectificaFuera(v: unknown): { numero: string; fecha: string } {
  const o = (v && typeof v === 'object' ? v : {}) as { numero?: unknown; fecha?: unknown };
  const numero = typeof o.numero === 'string' ? o.numero.trim() : '';
  if (!numero) throw badRequest('Escribe el número de la factura que rectificas.', { campo: 'rectificaFuera.numero' });
  if (numero.length > 60) throw badRequest('El número de la factura que rectificas es demasiado largo (60 caracteres como mucho).', { campo: 'rectificaFuera.numero' });
  const fecha = typeof o.fecha === 'string' ? o.fecha.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(Date.parse(`${fecha}T00:00:00Z`)) || new Date(`${fecha}T00:00:00Z`).toISOString().slice(0, 10) !== fecha) {
    throw badRequest('Escribe la fecha de la factura que rectificas (día, mes y año).', { campo: 'rectificaFuera.fecha' });
  }
  return { numero, fecha };
}

const MESES_TEXTO = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** «del 4T de 2026» o «de diciembre de 2026». */
const periodo303Texto = (p: { ejercicio: number; periodo: string }) =>
  /^\d{2}$/.test(p.periodo) ? `de ${MESES_TEXTO[Number(p.periodo) - 1]} de ${p.ejercicio}` : `del ${p.periodo} de ${p.ejercicio}`;

/**
 * Venta cuya operacion es de un periodo que lleva la gestoria (su 303 se
 * presenta fuera de la app) emitida ya en un periodo de la app: por ejemplo,
 * una entrega de diciembre de 2026 facturada en enero de 2027. Su IVA va en el
 * 303 del devengo (art. 75 LIVA), que no esta en la app: hay que pasarle la
 * factura a la gestoria. null si no es el caso.
 */
async function devengoEnPeriodoDeFuera(companyId: string, devengo: string, fechaEmision: string): Promise<{ ejercicio: number; periodo: string } | null> {
  if (devengo >= fechaEmision) return null;
  const fuera = await periodo303FueraDeLaApp(companyId, devengo);
  if (!fuera) return null;
  // Si la emision tambien es de un periodo de fuera, no hay frontera que avisar.
  return (await periodo303FueraDeLaApp(companyId, fechaEmision)) ? null : fuera;
}

const textoDevengoFuera = (devengo: string, p: { ejercicio: number; periodo: string }) =>
  `La operación es del ${fechaTexto(devengo)}: su IVA va en el 303 ${periodo303Texto(p)}, que se presenta fuera de la app (por ejemplo, lo lleva tu gestoría). ` +
  'Emítela igualmente y pasa la factura a quien presente ese 303 para que la incluya, y también en su 390 y su 347.';

/** 409 de una venta con la operacion en un periodo de la gestoria, sin confirmar (ver devengoEnPeriodoDeFuera). */
const errorDevengoFuera = (devengo: string, p: { ejercicio: number; periodo: string }) =>
  conflict(textoDevengoFuera(devengo, p), { codigo: 'DEVENGO_FUERA_APP', motivo: 'devengo_fuera_app', modelo: '303', ejercicio: p.ejercicio, periodo: p.periodo, campo: 'fechaOperacion' });

/** El 303 del periodo de una fecha (el mes o el trimestre) ya presentado desde la app, o null. */
async function periodo303Presentado(companyId: string, fecha: string): Promise<{ ejercicio: number; periodo: string } | null> {
  const ejercicio = Number(fecha.slice(0, 4));
  const mes = fecha.slice(5, 7);
  const p = await prisma.modeloImpuesto.findFirst({
    where: { companyId, codigo: '303', ejercicio, periodo: { in: [`${Math.ceil(Number(mes) / 3)}T`, mes] }, estado: 'presentado' },
    select: { periodo: true },
  });
  return p ? { ejercicio, periodo: p.periodo } : null;
}

const textoRectificar303 = (p: { ejercicio: number; periodo: string }) =>
  `Esta rectificativa sube el IVA por un error y va en el 303 ${periodo303Texto(p)}, que ya está presentado: la app no la añade a ese 303. ` +
  'Tendrás que presentar una autoliquidación complementaria de ese periodo con esta factura (art. 89.Cinco LIVA).';

/**
 * 409 de una R4 que sube el IVA y va al 303 ya presentado de la original. Se
 * confirma igual que DEVENGO_FUERA_APP (la pantalla repite con
 * confirmaDevengoFuera: true); `motivo` lo distingue.
 */
const errorRectificar303 = (p: { ejercicio: number; periodo: string }) =>
  conflict(textoRectificar303(p), { codigo: 'DEVENGO_FUERA_APP', motivo: 'rectificar_303', modelo: '303', ejercicio: p.ejercicio, periodo: p.periodo, campo: 'fechaEmision' });

/**
 * Una R4 que sube el IVA va al 303 de la original (cerrarPlan). Si ese periodo
 * lo presenta la gestoria (DEVENGO_FUERA_APP) o su 303 ya esta presentado en la
 * app (hay que presentar una complementaria), hace falta confirmarlo; con la
 * confirmacion, el aviso queda en la factura (y en AuditLog, por el controlador).
 */
async function exigirPeriodoDeR4(
  companyId: string,
  devengo: string,
  fechaEmision: string,
  confirmado: boolean,
): Promise<AvisoFiscal | null> {
  const fuera = await devengoEnPeriodoDeFuera(companyId, devengo, fechaEmision);
  if (fuera) {
    if (!confirmado) throw errorDevengoFuera(devengo, fuera);
    return { codigo: 'DEVENGO_FUERA_APP', mensaje: textoDevengoFuera(devengo, fuera) };
  }
  const presentado = await periodo303Presentado(companyId, devengo);
  if (!presentado) return null;
  if (!confirmado) throw errorRectificar303(presentado);
  return { codigo: 'RECTIFICAR_303', mensaje: textoRectificar303(presentado) };
}

/** La empresa presenta el 303 cada mes en esa fecha (si no, cada trimestre). */
const declaraCadaMes = async (companyId: string, fecha: string) => (await regimenFiscalEn(companyId, fecha)).periodicidadIva === 'MENSUAL';

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
  // Con su subcuenta 430 asignada en la misma transaccion que el alta.
  const customer = await crearClienteConSubcuenta({
    companyId,
    nombreFiscal: n.nombreFiscal,
    nifCif,
    direccion: n.direccion,
    pais: paisClienteNuevo(n.pais, nifCif),
    provincia: n.provincia,
    municipio: n.municipio,
    cp: n.cp,
    email: n.email,
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
    // Plantilla A: una linea de 0 uds con kg corrige solo los kg (y su IEEPNR); si
    // vale (solo en una rectificativa por diferencias) lo decide aplicarEnvases.
    const soloKg = Number(l.cantidad) === 0 && !!numeroDelCuerpo(l.kgPlastico);
    if (!Number.isFinite(Number(l.cantidad)) || (Number(l.cantidad) === 0 && !soloKg)) {
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
    const cuenta = cuentaDeLinea(l.cuenta);
    if (cuenta && !esCuentaDeTipo(cuenta, 'venta')) {
      throw badRequest(`Línea ${n}: la cuenta ${cuenta} no es de ventas; tiene que empezar por 70.`, { campo: `lineas.${i}.cuenta` });
    }
  });
  return lineas.map((l, i) => ({
    descripcion: String(l.descripcion).trim(),
    cantidad: Number(l.cantidad),
    precioUnitario: Number(l.precioUnitario),
    descuentoPorcentaje: Number(l.descuentoPorcentaje ?? 0),
    tipoIva: Number(l.tipoIva ?? 21),
    tipoRetencion: Number(l.tipoRetencion ?? 0),
    productoServicioId: l.productoServicioId,
    ...(cuentaDeLinea(l.cuenta) ? { cuentaContable: cuentaDeLinea(l.cuenta)! } : {}),
    // Plantilla A: solo se lee y se comprueba el formato. Si la plantilla los
    // admite lo decide aplicarEnvases; el IEEPNR del cuerpo nunca se usa.
    ...leerEnvasesLinea(l, i),
  }));
}

/** Mayor valor absoluto de kg o de peso que se admite (la columna es DECIMAL(14,3)). */
const KG_MAX = 99_999_999_999;
/** Mayor numero de packs que se admite (la columna es un entero de 32 bits). */
const PACKS_MAX = 2_000_000_000;

/** Numero del cuerpo (number o texto con punto decimal); null si no lo es. */
function numeroDelCuerpo(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

/**
 * Packs, kg de plastico y texto adicional de una linea, con el formato
 * comprobado (400 con su campo). Solo los que llegan con valor.
 */
function leerEnvasesLinea(l: CrearLineaIngresoDTO, i: number): { packs?: number; kgPlastico?: number; textoAdicional?: string } {
  const n = i + 1;
  const out: { packs?: number; kgPlastico?: number; textoAdicional?: string } = {};
  if (l.packs !== undefined && l.packs !== null && (l.packs as unknown) !== '') {
    const p = numeroDelCuerpo(l.packs);
    if (p === null || !Number.isInteger(p) || Math.abs(p) > PACKS_MAX) {
      throw badRequest(`Línea ${n}: los packs son un número entero.`, { campo: `lineas.${i}.packs` });
    }
    out.packs = p;
  }
  if (l.kgPlastico !== undefined && l.kgPlastico !== null && (l.kgPlastico as unknown) !== '') {
    const k = numeroDelCuerpo(l.kgPlastico);
    if (k === null || Math.abs(k) > KG_MAX) {
      throw badRequest(`Línea ${n}: los kg de plástico son un número (con 3 decimales como mucho).`, { campo: `lineas.${i}.kgPlastico` });
    }
    out.kgPlastico = redondearKg(k);
  }
  if (l.textoAdicional !== undefined) {
    const t = limpiarTextoAdicional(l.textoAdicional);
    if (!t.ok) throw badRequest(`Línea ${n}: el texto adicional admite 500 caracteres y 6 líneas como mucho.`, { campo: `lineas.${i}.textoAdicional` });
    if (t.valor !== null) out.textoAdicional = t.valor;
  }
  return out;
}

/** Peso bruto del cuerpo: undefined = no llega; null = sin peso; si no, >= 0 y con 3 decimales como mucho (400 pesoBrutoKg). */
function leerPesoBruto(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = numeroDelCuerpo(v);
  if (n === null || n < 0 || n > KG_MAX || Math.abs(Math.round(n * 1000) - n * 1000) > 1e-6) {
    throw badRequest('El peso bruto son los kg de la mercancía: un número desde 0 y con 3 decimales como mucho.', { campo: 'pesoBrutoKg' });
  }
  return n;
}

/** La linea lleva algun dato de envase (packs, kg o texto adicional). */
const lineaConEnvases = (l: { packs?: number | null; kgPlastico?: number | null; textoAdicional?: string | null }) =>
  (l.packs !== undefined && l.packs !== null) || (l.kgPlastico !== undefined && l.kgPlastico !== null) || !!l.textoAdicional;

/** 400 PLANTILLA_SIN_ENVASES: la plantilla de la serie no lleva envases. */
function errorSinEnvases(campo: string, n?: number) {
  return badRequest(
    `${n ? `Línea ${n}: ` : ''}la plantilla de esta serie no lleva packs, kg de plástico, texto adicional ni peso bruto. Quita esos datos o elige una serie con la plantilla A (envases).`,
    { codigo: 'PLANTILLA_SIN_ENVASES', campo },
  );
}

/** Opciones de aplicarEnvases. */
export interface OpcionesEnvases {
  plantilla: PlantillaVentaId;
  /** La empresa repercute el IEEPNR (o lo repercutio la factura que se rectifica). */
  repercute: boolean;
  /** EUR por kg: el de los ajustes o, en una rectificativa de una factura de la app, el de la original. */
  tipo: number;
  moneda: string;
  /** Rectificativa: redondeo simetrico del IEEPNR. */
  simetrico: boolean;
  /**
   * Rectificativa por diferencias: admite lineas de 0 uds con kg, que corrigen
   * solo los kg de plastico y su IEEPNR (sin packs). En el resto, 400 UDS_CERO.
   */
  soloKg?: boolean;
  /** false: el IEEPNR de las lineas ya esta calculado (lineas guardadas) y no se toca; solo se comprueba. */
  recalcular?: boolean;
}

/**
 * Datos de envase de las lineas segun la plantilla (puro):
 *  - sin envases (estandar, B, C): ninguna linea puede llevar packs, kg ni
 *    texto (400 PLANTILLA_SIN_ENVASES) y el IEEPNR queda fuera;
 *  - con envases (A): sin descuento (400 DESCUENTO_NO_ADMITIDO), kg y packs con
 *    el signo de la cantidad (400 SIGNO_ENVASES) y el IEEPNR = kg x tipo si la
 *    empresa lo repercute (0 si no); con IEEPNR, solo en euros (400 IEEPNR_SOLO_EUROS).
 *    Una linea de 0 uds con kg (de cualquier signo) solo en una rectificativa
 *    por diferencias (`soloKg`; si no, 400 UDS_CERO) y sin packs (400 PACKS_SIN_UDS).
 * Devuelve las lineas con su ieepnrImporte y el tipo aplicado (null sin IEEPNR).
 */
export function aplicarEnvases(lineas: LineaEntrada[], o: OpcionesEnvases): { lineas: LineaEntrada[]; ieepnrPorKg: number | null } {
  if (!admiteEnvases(o.plantilla)) {
    lineas.forEach((l, i) => {
      if (l.packs !== undefined && l.packs !== null) throw errorSinEnvases(`lineas.${i}.packs`, i + 1);
      if (l.kgPlastico !== undefined && l.kgPlastico !== null) throw errorSinEnvases(`lineas.${i}.kgPlastico`, i + 1);
      if (l.textoAdicional) throw errorSinEnvases(`lineas.${i}.textoAdicional`, i + 1);
    });
    return { lineas: lineas.map(({ ieepnrImporte: _i, packs: _p, kgPlastico: _k, textoAdicional: _t, ...resto }) => resto), ieepnrPorKg: null };
  }
  const recalcular = o.recalcular !== false;
  const out = lineas.map((l, i) => {
    if (Number(l.descuentoPorcentaje ?? 0) !== 0) {
      throw badRequest(`Línea ${i + 1}: la plantilla A no lleva descuento por línea. Pon el precio ya rebajado.`, {
        codigo: 'DESCUENTO_NO_ADMITIDO',
        campo: `lineas.${i}.descuentoPorcentaje`,
      });
    }
    if (l.cantidad === 0) {
      // Solo corrige los kg de plastico (y su IEEPNR): validarLineas ya exige kg.
      if (!o.soloKg) {
        throw badRequest(
          `Línea ${i + 1}: las uds no pueden ser 0. Una línea sin uds solo vale en una rectificativa por diferencias que corrige únicamente los kg de plástico.`,
          { codigo: 'UDS_CERO', campo: `lineas.${i}.cantidad` },
        );
      }
      if (Number(l.packs ?? 0) !== 0) {
        throw badRequest(`Línea ${i + 1}: una línea que solo corrige los kg de plástico va sin packs (deja los packs vacíos).`, {
          codigo: 'PACKS_SIN_UDS',
          campo: `lineas.${i}.packs`,
        });
      }
    }
    const signo = Math.sign(l.cantidad);
    for (const campo of l.cantidad === 0 ? [] : (['kgPlastico', 'packs'] as const)) {
      const v = Number(l[campo] ?? 0);
      if (v !== 0 && Math.sign(v) !== signo) {
        throw badRequest(
          `Línea ${i + 1}: ${campo === 'kgPlastico' ? 'los kg de plástico' : 'los packs'} van con el mismo signo que las unidades (en negativo solo si las unidades lo están).`,
          { codigo: 'SIGNO_ENVASES', campo: `lineas.${i}.${campo}` },
        );
      }
    }
    const ieepnrImporte = recalcular ? (o.repercute ? calcularIeepnr(l.kgPlastico, o.tipo, { simetrico: o.simetrico }) : 0) : Number(l.ieepnrImporte ?? 0);
    return { ...l, ieepnrImporte };
  });
  const conIeepnr = out.findIndex((l) => aCentimos(Number(l.ieepnrImporte ?? 0)) !== 0);
  if (conIeepnr >= 0 && o.moneda !== 'EUR') {
    throw badRequest(`El IEEPNR solo se repercute en euros y esta factura va en ${o.moneda}. Hazla en euros o quita los kg de plástico.`, {
      codigo: 'IEEPNR_SOLO_EUROS',
      campo: 'moneda',
    });
  }
  const conTipo = recalcular ? o.repercute : out.some((l) => aCentimos(Number(l.ieepnrImporte ?? 0)) !== 0) || o.repercute;
  return { lineas: out, ieepnrPorKg: conTipo ? o.tipo : null };
}

/** Plantilla que usa la serie de una empresa por su codigo, o la estandar si no existe. */
async function plantillaDeSerie(companyId: string, codigo: string | null | undefined): Promise<PlantillaVentaId> {
  if (!codigo) return 'default';
  return (await buscarSeriePorCodigo(companyId, codigo))?.plantilla ?? 'default';
}

/**
 * Plantilla de un alta (sin original de la app): la de la serie indicada o, sin
 * ella, la de la serie por defecto de su tipo (facturas, rectificativas,
 * rectificativas de tickets o proformas). Solo lee: una serie que no existe da
 * la estandar y el error de la serie sale despues, como siempre.
 */
async function plantillaDelAlta(
  companyId: string,
  dto: { serie?: string; proforma?: boolean },
  r: { esRectificativa: boolean; tipoFactura: string },
): Promise<PlantillaVentaId> {
  if (dto.serie) return plantillaDeSerie(companyId, String(dto.serie));
  const tipo: TipoDocumentoSerie = dto.proforma ? 'PROFORMA' : !r.esRectificativa ? 'FACTURA' : r.tipoFactura === 'R5' ? 'RECTIFICATIVA_SIMPLIFICADA' : 'RECTIFICATIVA';
  return (await obtenerSeriePorDefecto(companyId, tipo))?.plantilla ?? 'default';
}

/**
 * Aviso (no bloquea) si una venta que sale de Espana (exportacion o entrega
 * intracomunitaria) lleva IEEPNR: la Ley 7/2022 no grava los envases que salen
 * de Espana (exencion, deduccion o devolucion). La factura se emite igual; que
 * lo confirme la gestoria. null si no toca.
 */
export function avisoIeepnrFueraDeEspana(
  tipoOperacion: string | null | undefined,
  lineas: Array<{ ieepnrImporte?: number | null }>,
): AvisoFiscal | null {
  if (tipoOperacion !== 'EXPORTACION' && tipoOperacion !== 'INTRACOMUNITARIA') return null;
  if (!lineas.some((l) => aCentimos(Number(l.ieepnrImporte ?? 0)) !== 0)) return null;
  return {
    codigo: 'IEEPNR_VENTA_FUERA',
    mensaje:
      'Esta venta sale de España (exportación o entrega intracomunitaria) y lleva IEEPNR. Los envases que salen de España no pagan este impuesto (Ley 7/2022): pregunta a tu gestoría si debes cobrárselo al cliente y si puedes pedir la devolución del que pagaste al comprarlos.',
  };
}

/** Lo que una rectificativa de una factura de la app hereda para el IEEPNR: su plantilla, si lo repercutio y a que tipo. */
function envasesDeOriginal(original: { plantillaId: string; ieepnrPorKg: number | null }) {
  return { plantilla: normalizarPlantillaId(original.plantillaId), repercute: original.ieepnrPorKg !== null, tipo: original.ieepnrPorKg };
}

/**
 * numeroCompleto de una factura del lector: el numero tal como aparece en
 * ella, sin espacios («F2026/0012», «FX-0007»). Si no lleva serie (solo
 * «0015»), delante va la que se le pone, el ano («2027-0015»): si no, la 15 de
 * 2027 y la de 2028 se llamarian igual. null si no hay o es demasiado largo.
 */
export function numeroCompletoLeido(leido: string | null | undefined, serie: string): string | null {
  const t = String(leido ?? '').replace(/\s+/g, '');
  if (!t) return null;
  const completo = t.startsWith(serie) ? t : `${serie}-${t}`;
  return completo.length <= 60 ? completo : null;
}

/** Cuenta escrita en una linea: solo digitos; vacia = ninguna. */
function cuentaDeLinea(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const c = String(v).replace(/[\s.]/g, '');
  return c || undefined;
}

/**
 * Cuenta de ingresos de cada linea: la indicada (tiene que estar activa en el
 * plan, salvo si es de la factura que se rectifica; si no, 400 con la linea) o la del producto (la suya, la de su familia
 * o la 705 si es un servicio), siempre que exista en el plan. Sin ninguna, la
 * linea queda sin cuenta y va a la 700 al contabilizar.
 */
async function conCuentasDeVenta(
  companyId: string,
  lineas: LineaEntrada[],
  original?: { lineas: Array<{ accountCode: string | null }> } | Array<{ lineas: Array<{ accountCode: string | null }> }> | null,
): Promise<LineaEntrada[]> {
  // En una rectificativa, las cuentas de las facturas originales valen aunque se
  // hayan desactivado despues: rectificar es obligatorio y va a la misma cuenta.
  const originales = Array.isArray(original) ? original : original ? [original] : [];
  const deLaOriginal = originales.flatMap((o) => o.lineas).map((l) => l.accountCode).filter((c): c is string => !!c);
  const indicada = await problemaCuentasLinea(companyId, 'venta', lineas.map((l) => l.cuentaContable), prisma, { permitirInactivas: deLaOriginal });
  if (indicada) throw badRequest(`Línea ${indicada.indice + 1}: ${indicada.mensaje}`, { campo: `lineas.${indicada.indice}.cuenta` });
  const ids = [...new Set(lineas.filter((l) => !l.cuentaContable && l.productoServicioId).map((l) => l.productoServicioId!))];
  if (!ids.length) return lineas;
  const productos = await prisma.product.findMany({
    where: { companyId, id: { in: ids } },
    select: { id: true, tipo: true, cuentaVentas: true, familia: { select: { cuentaVentas: true } } },
  });
  const propuesta = new Map(productos.map((p) => [p.id, (p.cuentaVentas || p.familia?.cuentaVentas || (p.tipo === 'SERVICIO' ? '705' : '700')).replace(/\D/g, '')]));
  // La del producto solo si vale (una cuenta antigua que ya no esta en el plan no bloquea la factura).
  const validas = new Set<string>();
  for (const c of new Set(propuesta.values())) if (c && !(await problemaCuentasLinea(companyId, 'venta', [c]))) validas.add(c);
  return lineas.map((l) => {
    if (l.cuentaContable || !l.productoServicioId) return l;
    const c = propuesta.get(l.productoServicioId);
    return c && validas.has(c) ? { ...l, cuentaContable: c } : l;
  });
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
    ...(l.accountCode ? { cuentaContable: l.accountCode } : {}),
    ...envasesGuardados(l),
  }));
}

/**
 * Datos de envase guardados de una linea (plantilla A), solo los que tiene. El
 * IEEPNR guardado va tal cual: no se recalcula (una emitida no cambia aunque
 * cambie el tipo de los ajustes).
 */
function envasesGuardados(l: { packs: number | null; kgPlastico: number | null; ieepnrImporte: number | null; textoAdicional: string | null }) {
  return {
    ...(l.packs !== null && l.packs !== undefined ? { packs: l.packs } : {}),
    ...(l.kgPlastico !== null && l.kgPlastico !== undefined ? { kgPlastico: l.kgPlastico } : {}),
    ...(l.ieepnrImporte !== null && l.ieepnrImporte !== undefined ? { ieepnrImporte: l.ieepnrImporte } : {}),
    ...(l.textoAdicional ? { textoAdicional: l.textoAdicional } : {}),
  };
}

/** La factura guardada lleva datos de envase (en sus lineas o el peso bruto). */
const facturaConEnvases = (f: FacturaConLineas) => f.pesoBrutoKg !== null || f.lineas.some((l) => lineaConEnvases(l));

/**
 * Lo que una copia de la factura (duplicar, pasar una proforma a factura)
 * necesita de la plantilla de su serie: con envases, la A; con descuento por
 * linea, una que no sea la A (que no lo lleva); si no, nada.
 */
function necesidadPlantilla(f: FacturaConLineas): NecesidadPlantilla | null {
  if (facturaConEnvases(f)) return 'envases';
  return f.lineas.some((l) => aCentimos(Number(l.descuentoPorcentaje ?? 0)) !== 0) ? 'descuento' : null;
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
      ...(l.accountCode ? { cuentaContable: l.accountCode } : {}),
      ...envasesGuardados(l),
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
    accountCode: l.cuentaContable ?? null,
    // Plantilla A: los datos de envase y el IEEPNR (ya dentro de baseLine).
    packs: l.packs ?? null,
    kgPlastico: l.kgPlastico ?? null,
    ieepnrImporte: l.ieepnrImporte ?? null,
    textoAdicional: l.textoAdicional ?? null,
    ...importesLinea(l),
  }));
}

/** Columnas del tipo de cambio. PENDIENTE guarda 1 (la columna no admite null) y la fuente lo dice. */
function datosTipo(t: TipoResuelto) {
  return { tipoCambio: t.tipoCambio ?? 1, fechaTipoCambio: t.fechaTipoCambio, fuenteTipoCambio: t.fuente };
}

/** Aplica a las lineas el IVA y la retencion que decide la fiscalidad (empresa no espanola: 0). */
function conFiscalidad(lineas: LineaEntrada[], fiscal: { lineas: Array<{ tipoIva: number; tipoRetencion: number }> }): LineaEntrada[] {
  return lineas.map((l, i) => {
    // Una cuota fijada deja de valer si la fiscalidad cambia el tipo de IVA de la linea.
    const { cuotaFija, ...resto } = l;
    const mismoTipo = cuotaFija !== undefined && fiscal.lineas[i].tipoIva === (l.tipoIva ?? 21);
    return { ...resto, ...(mismoTipo ? { cuotaFija } : {}), tipoIva: fiscal.lineas[i].tipoIva, tipoRetencion: fiscal.lineas[i].tipoRetencion };
  });
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

function validarFormaPago(forma: string | undefined, porDefecto: FormaPago = 'TRANSFERENCIA'): FormaPago {
  const f = (forma ?? porDefecto).toUpperCase();
  if (!(FORMAS_PAGO as readonly string[]).includes(f)) {
    throw badRequest(`Forma de pago no válida. Usa: ${FORMAS_PAGO.join(', ')}.`);
  }
  return f as FormaPago;
}

/** Serie que no existe: ya no se crea sola (una errata creaba una serie nueva y activa). */
const serieNoExiste = (codigo: string) =>
  badRequest(`La serie ${String(codigo).trim()} no existe. Elige una de las series de la empresa o créala antes en Configuración > Series.`, {
    campo: 'serie',
  });

/** Aviso de una factura del lector registrada en una serie historica que mezcla facturas y rectificativas. */
const avisoSerieMixta = (codigo: string): AvisoFiscal => ({
  codigo: 'SERIE_HISTORICA_MIXTA',
  mensaje: `La serie ${codigo} del otro programa tiene facturas y rectificativas juntas: se registra igual, porque esa numeración no es de la app.`,
});

/**
 * Serie elegida en el DTO (o la por defecto). Desde la pantalla o la API tiene
 * que existir y estar activa. Solo una factura del lector, que trae su numero
 * original, puede crear su serie (desactivada: guarda la numeracion de otro
 * programa, pero no sale para emitir facturas nuevas); si esa serie historica
 * ya existe con facturas del otro tipo, se usa con el aviso SERIE_HISTORICA_MIXTA.
 *
 * Rectificativas (art. 6.1.a y 7.1.a RD 1619/2012): las R1-R4 solo en series
 * de rectificativas (por defecto, la R) y las R5 (tickets) solo en una de
 * rectificativas de tickets (por defecto la RT, que se crea con la primera).
 * Nunca en una serie de facturas (A, B) ni de proformas.
 */
async function resolverSerie(
  companyId: string,
  codigo: string | undefined,
  r: { esRectificativa: boolean; tipoFactura: string; origen?: OrigenFactura },
): Promise<{ codigo: string; aviso?: AvisoFiscal }> {
  const tickets = r.esRectificativa && r.tipoFactura === 'R5';
  if (r.esRectificativa && !codigo) {
    if (tickets) return { codigo: (await obtenerOCrearSerieTickets(companyId)).codigo };
    const def = await obtenerSeriePorDefecto(companyId, 'RECTIFICATIVA');
    if (!def) throw badRequest('No hay serie de rectificativas configurada.', { codigo: 'SERIE_NO_RECTIFICATIVA', campo: 'serie' });
    return { codigo: def.codigo };
  }
  if (!codigo) return { codigo: await resolverCodSerieFactura(companyId, {}) };
  const lector = r.origen === 'lector';
  const tipoSerie = !r.esRectificativa ? 'FACTURA' : tickets ? 'RECTIFICATIVA_SIMPLIFICADA' : 'RECTIFICATIVA';
  const serie = lector
    ? await obtenerOCrearSerieHistorica(companyId, String(codigo), tipoSerie, { aceptarOtroTipo: true })
    : await buscarSeriePorCodigo(companyId, String(codigo));
  if (!serie) throw serieNoExiste(String(codigo));
  if (!serie.activa && !lector) throw badRequest(`La serie ${serie.codigo} está desactivada.`, { campo: 'serie' });
  if (lector && 'mixta' in serie && serie.mixta) return { codigo: serie.codigo, aviso: avisoSerieMixta(serie.codigo) };
  if (serie.tipoDocumento === 'PROFORMA') {
    throw badRequest(`La serie ${serie.codigo} es de proformas: una factura no puede ir en ella.`, { campo: 'serie' });
  }
  if (r.esRectificativa && serie.tipoDocumento === 'FACTURA') {
    throw badRequest('Las rectificativas van en una serie propia de rectificativas, no en la de facturas.', { codigo: 'SERIE_NO_RECTIFICATIVA', campo: 'serie' });
  }
  if (r.esRectificativa && !tickets && serie.tipoDocumento === 'RECTIFICATIVA_SIMPLIFICADA') {
    throw badRequest(`La serie ${serie.codigo} es de rectificativas de tickets: la rectificativa de una factura completa va en la serie de rectificativas.`, {
      codigo: 'SERIE_NO_RECTIFICATIVA',
      campo: 'serie',
    });
  }
  if (tickets && serie.tipoDocumento === 'RECTIFICATIVA') {
    throw badRequest('La rectificativa de un ticket (R5) va en una serie propia, distinta de la de rectificativas: elige la de rectificativas de tickets.', {
      codigo: 'SERIE_NO_RECTIFICATIVA',
      campo: 'serie',
    });
  }
  if (!r.esRectificativa && serie.tipoDocumento !== 'FACTURA') {
    throw badRequest(`La serie ${serie.codigo} es solo para rectificativas.`, { campo: 'serie' });
  }
  return { codigo: serie.codigo };
}

/** Serie de las proformas: la indicada (si es de proformas) o la por defecto. */
async function resolverSerieProforma(companyId: string, codigo: string | undefined): Promise<string> {
  if (!codigo) {
    const p = await obtenerSeriePorDefecto(companyId, 'PROFORMA');
    if (!p) throw badRequest('No hay serie de proformas configurada.');
    return p.codigo;
  }
  const serie = await buscarSeriePorCodigo(companyId, String(codigo));
  if (!serie) throw serieNoExiste(String(codigo));
  if (!serie.activa) throw badRequest(`La serie ${serie.codigo} está desactivada.`, { campo: 'serie' });
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

/**
 * Art. 6 RD 1619/2012: la factura lleva el nombre y el NIF del emisor. Lo
 * comprueban los dos caminos que emiten (finalizar y la emision directa de
 * crear), antes de numerar. Devuelve el perfil de la empresa.
 */
async function exigirDatosEmisor(companyId: string): Promise<PerfilEmpresa> {
  const emisor = await prisma.legalConfig.findUnique({ where: { companyId } });
  const perfil = perfilDesdeConfig(emisor);
  if (!emisor?.nif?.trim() || !emisor?.denominacion?.trim()) {
    throw badRequest(
      perfil.espanola
        ? 'Antes de emitir facturas rellena la denominación y el NIF de tu empresa en Registro Mercantil > Datos para la memoria.'
        : 'Antes de emitir facturas rellena la denominación y la identificación fiscal de tu empresa en Registro Mercantil > Datos para la memoria.',
    );
  }
  return perfil;
}

/**
 * Una factura no se emite con fecha futura (spec verifactu, P3): la AEAT la
 * rechaza y, ademas, bloquearia la serie hasta ese dia. Hoy es el dia de Madrid.
 */
function exigirFechaNoFutura(fechaEmision: string, hoy: string = hoyISO()): void {
  if (fechaEmision > hoy) {
    throw badRequest(
      `La fecha de emisión (${fechaEmision}) no puede ser posterior a hoy. Guarda la factura como borrador y emítela ese día.`,
      { campo: 'fechaEmision' },
    );
  }
}

/** La serie tiene que servir para el numero de factura que se envia a la AEAT (spec verifactu, P11). */
function exigirSerieValidaAeat(serie: string): void {
  const problema = problemaSerieAeat(serie);
  if (problema) throw badRequest(problema, { campo: 'serie' });
}

/** Tope de una factura simplificada (F2): 3.000 € con el IVA incluido (art. 4.1 RD 1619/2012). */
export const LIMITE_SIMPLIFICADA = 3000;

/**
 * Una simplificada (F2) no pasa de 3.000 € de base mas IVA, en euros (spec
 * verifactu, 4.3 y P9). Solo empresas espanolas: el limite es de la norma espanola.
 */
function exigirLimiteSimplificada(
  tipoFactura: string,
  perfil: PerfilEmpresa,
  importes: { baseTotal: number; ivaTotal: number },
): void {
  if (tipoFactura !== 'F2' || !perfil.espanola) return;
  const total = aCentimos(importes.baseTotal) + aCentimos(importes.ivaTotal);
  if (total > LIMITE_SIMPLIFICADA * 100) {
    throw badRequest(
      `Una factura simplificada no puede pasar de 3.000 € (base más IVA) y esta suma ${(total / 100).toFixed(2).replace('.', ',')} €. ` +
        'Emítela como factura completa (F1).',
      { campo: 'tipoFactura' },
    );
  }
}

/** R5 solo rectifica una simplificada (F2); el resto de facturas se rectifican con R1 a R4 (spec verifactu, 4.3). */
function exigirR5SobreSimplificada(tipoFactura: string, original: { tipoFactura: string; numeroCompleto: string | null } | null): void {
  if (tipoFactura === 'R5' && original && original.tipoFactura !== 'F2') {
    throw badRequest(
      `Una rectificativa R5 solo corrige facturas simplificadas (F2) y la ${original.numeroCompleto ?? ''} es ${original.tipoFactura}. Usa R1 a R4.`,
      { campo: 'tipoFactura' },
    );
  }
}

/** Transaccion de facturas: el tipo de cambio ya esta resuelto; dentro no se consulta la red. */
function transaccion<T>(fn: (tx: Tx) => Promise<T>, opciones?: { isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T> {
  return prisma.$transaction((tx) => marcarTransaccion(() => fn(tx)), opciones);
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
function comprobarHerencia(
  original: FacturaConLineas,
  dto: { moneda?: string | null; tipoCambio?: unknown; tipoOperacion?: string | null; causaExencion?: string | null },
  forma: 'I' | 'S' = 'I',
): void {
  if (hayValor(dto.moneda) && normalizarMoneda(dto.moneda) !== original.moneda) {
    throw badRequest(`Una rectificativa va en la moneda de la factura que rectifica (${original.moneda}).`);
  }
  if (hayValor(dto.tipoCambio) && validarFormatoTipoCambio(dto.tipoCambio) !== original.tipoCambio) {
    throw badRequest('Una rectificativa lleva el tipo de cambio de la factura que rectifica.');
  }
  const otroTipo = hayValor(dto.tipoOperacion) && String(dto.tipoOperacion).trim().toUpperCase() !== (original.tipoOperacion ?? String(dto.tipoOperacion).trim().toUpperCase());
  const otraCausa = hayValor(dto.causaExencion) && hayValor(original.causaExencion) && String(dto.causaExencion).trim().toUpperCase() !== original.causaExencion;
  // Por sustitucion no se cambia el regimen de IVA: la factura corregida y la
  // original irian a casillas distintas. Se anula por diferencias y se factura de nuevo.
  if (forma === 'S' && (otroTipo || otraCausa)) {
    throw badRequest(
      'Por sustitución no se puede cambiar el tipo de operación ni la exención de la factura. Para corregirlos, rectifica la factura entera por diferencias (con el motivo «Error al interpretar la norma» si fue un error al aplicar la ley) y emite una factura nueva con el tipo correcto.',
      { codigo: 'SUSTITUCION_CAMBIA_OPERACION', campo: 'tipoOperacion' },
    );
  }
  if (otroTipo) throw badRequest('Una rectificativa lleva el tipo de operación de la factura que rectifica.', { campo: 'tipoOperacion' });
}

/** Lo que una rectificativa hereda de la factura que rectifica para su fiscalidad. */
function herencia(original: FacturaConLineas) {
  return {
    tipoOperacion: original.tipoOperacion,
    causaExencion: original.causaExencion,
    referenciaLegal: original.referenciaLegal,
    paisClienteLegacy: original.paisClienteLegacy,
  };
}

/** Pais con el que se clasifica una factura sin tipo: el congelado o, si no, el de la ficha ahora. */
function paisCongelado(f: FacturaConLineas): string {
  return f.paisClienteLegacy ?? f.customer.pais ?? '';
}

/**
 * Lo que fija el servidor al crear: el origen y, del lector, el numero leido y
 * las cuotas de IVA ya fijadas de algunas lineas (cuotasFijas, por indice: los
 * importes de la original de una sustitucion de fuera de la app).
 */
export interface OpcionesAlta {
  origen?: OrigenFactura;
  numeroLeido?: string | null;
  cuotasFijas?: Array<number | undefined>;
}

/** Herencia y lineas espejo de una rectificativa: solo se pasan desde este servicio. */
interface Interno {
  original?: FacturaConLineas;
  /** Rectificativa total: importes espejo de la original, sin recalcular. */
  importes?: ImportesFactura;
}

const MOTIVOS_RECT = new Set<string>(MOTIVOS_VENTA);

/**
 * La respuesta de siempre y, en una rectificativa, que rectifica (enlaces de la
 * tabla o, en las anteriores, facturaOriginalId o rectificaFuera).
 */
async function respuesta(f: FacturaConLineas, ctx: ContextoRespuesta): Promise<IncomeInvoiceResp> {
  const resp = aRespuesta(f, ctx);
  if (f.esRectificativa) {
    const r = (await enlacesDeVentas(prisma, [f])).get(f.id);
    if (r) resp.rectificativa = r;
  }
  return resp;
}

/**
 * Lineas de una rectificativa que son el espejo exacto de las de su original
 * (mismo orden, cantidad por precio con el signo cambiado, mismo IVA,
 * retencion, descuento y cuenta): se copian sus importes en negativo
 * (lineasEspejo), asi la pareja suma cero tambien en divisa.
 */
function esEspejoDe(lineas: LineaEntrada[], original: FacturaConLineas): boolean {
  const o = lineasDocGuardadas(original);
  if (o.length !== lineas.length || !o.length) return false;
  return lineas.every((l, i) => {
    const x = o[i];
    return (
      Math.sign(l.cantidad) === -Math.sign(x.cantidad) &&
      Math.abs(l.cantidad) === Math.abs(x.cantidad) &&
      l.precioUnitario === x.precioUnitario &&
      (l.tipoIva ?? 21) === (x.tipoIva ?? 21) &&
      (l.tipoRetencion ?? 0) === (x.tipoRetencion ?? 0) &&
      (l.descuentoPorcentaje ?? 0) === (x.descuentoPorcentaje ?? 0) &&
      (l.cuentaContable ?? null) === (x.cuentaContable ?? null) &&
      // Plantilla A: los kg y los packs, tambien con el signo cambiado.
      Math.round(Number(l.kgPlastico ?? 0) * 1000) === -Math.round(Number(x.kgPlastico ?? 0) * 1000) &&
      Number(l.packs ?? 0) === -Number(x.packs ?? 0)
    );
  });
}

/** El bloque de una rectificativa hecha con los campos antiguos (facturaOriginalId o rectificaFuera). */
function bloqueDeCamposAntiguos(dto: CrearFacturaIngresoDTO, rectFuera: { numero: string; fecha: string } | null): BloqueVenta {
  return {
    ticket: String(dto.tipoFactura ?? '').toUpperCase() === 'R5',
    forma: dto.tipoRectificativa === 'S' ? 'S' : 'I',
    motivo: null,
    explicacion: String(dto.motivoRectificacion ?? '').trim(),
    originales: dto.facturaOriginalId ? [{ id: String(dto.facturaOriginalId) }] : rectFuera ? [{ numero: rectFuera.numero, fecha: rectFuera.fecha }] : [],
    periodo: null,
    legado: true,
  };
}

/** Columnas de compatibilidad de una rectificativa con una sola original: facturaOriginalId o rectificaFuera. */
function columnasCompatibles(enlaces: EnlaceVenta[]) {
  const una = enlaces.length === 1 ? enlaces[0] : null;
  return {
    facturaOriginalId: una?.originalId ?? null,
    rectificaFueraNumero: una && !una.originalId && !una.periodoDesde ? una.numeroOriginal : null,
    rectificaFueraFecha: una && !una.originalId && !una.periodoDesde ? una.fechaOriginal : null,
  };
}

/** El bloque de un borrador de rectificativa ya guardado (enlaces o campos antiguos), para volver a comprobarlo. */
async function bloqueGuardado(f: FacturaConLineas): Promise<BloqueVenta> {
  const filas = await prisma.incomeInvoiceRectificada.findMany({ where: { companyId: f.companyId, rectificativaId: f.id }, orderBy: { createdAt: 'asc' } });
  const motivo = f.causaRectificacion && MOTIVOS_RECT.has(f.causaRectificacion) ? (f.causaRectificacion as BloqueVenta['motivo']) : null;
  const periodo = filas.find((x) => x.periodoDesde && x.periodoHasta);
  const varias = filas.filter((x) => !x.periodoDesde).length > 1;
  const importes = (x: (typeof filas)[number]) =>
    varias ? { base: x.baseRectificada ?? undefined, cuota: x.cuotaRectificada ?? undefined, retencion: x.retencionRectificada ?? undefined } : {};
  const originales = filas.length
    ? filas
        .filter((x) => !x.periodoDesde)
        .map((x) =>
          x.originalId
            ? { id: x.originalId, ...importes(x) }
            : { numero: x.numeroOriginal ?? '', fecha: x.fechaOriginal ?? '', ...(x.partidaPendienteId ? { partidaId: x.partidaPendienteId } : {}), ...importes(x) },
        )
    : f.facturaOriginalId
      ? [{ id: f.facturaOriginalId }]
      : f.rectificaFueraNumero
        ? [{ numero: f.rectificaFueraNumero, fecha: f.rectificaFueraFecha ?? '' }]
        : [];
  return {
    ticket: f.tipoFactura === 'R5',
    forma: f.tipoRectificativa === 'S' ? 'S' : 'I',
    motivo,
    explicacion: (f.motivoRectificacion ?? '').trim(),
    originales,
    periodo: periodo ? { desde: periodo.periodoDesde!, hasta: periodo.periodoHasta! } : null,
    legado: !motivo,
  };
}

/** Lo que prepara un alta antes de guardar nada (lo usan crear y la correccion de un borrador de rectificativa). */
interface AltaPreparada {
  comunes: Prisma.IncomeInvoiceUncheckedCreateInput;
  ctx: ContextoRespuesta;
  serie: string;
  fechaEmision: string;
  fechaVencimiento: string;
  /** Rectificativa: forma y enlaces (con la parte de cada original), o null. */
  rect: { forma: 'I' | 'S'; enlaces: EnlaceVenta[] } | null;
}

/** Partidas de cobro de 2026 que rebajan los enlaces de una rectificativa. */
const partidasDe = (enlaces: EnlaceVenta[]) => [...new Set(enlaces.map((e) => e.partidaPendienteId).filter((x): x is string => !!x))];

/** Partes de las originales de la app para comprobar sus limites. */
const partesDe = (enlaces: EnlaceVenta[]) =>
  enlaces
    .map((e, indice) => ({ e, indice }))
    .filter(({ e }) => !!e.originalId)
    .map(({ e, indice }) => ({
      originalId: e.originalId!,
      base: e.baseRectificada,
      total: (aCentimos(e.baseRectificada) + aCentimos(e.cuotaRectificada) - aCentimos(e.retencionRectificada)) / 100,
      indice,
    }));

/**
 * Comprueba y calcula un alta (borrador, proforma, emitida o rectificativa)
 * sin guardar nada, salvo el cliente nuevo. `opciones` lo fija el servidor;
 * `interno` solo lo usa este servicio.
 *
 * Rectificativas: con el bloque `rectificativa` (rectificativasVenta.service:
 * motivo, forma, originales de la app o de fuera, periodo) o con los campos
 * antiguos (facturaOriginalId o rectificaFuera), que se traducen al bloque con
 * las reglas y los textos de antes.
 */
async function prepararAlta(
  dto: CrearFacturaIngresoDTO,
  opciones: OpcionesAlta,
  interno: Interno & { excluirId?: string },
): Promise<AltaPreparada> {
  const origen: OrigenFactura = opciones.origen ?? 'pantalla';
  if (dto.numero !== undefined && dto.numero !== null && origen !== 'lector') {
    throw badRequest('El número de la factura lo pone la serie al emitirla: no se puede indicar.', { campo: 'numero' });
  }
  // P4: una factura del lector la expidio otro programa y lleva SU numero y SU
  // serie. La app nunca la numera (si no, gastaria numeros de sus series).
  if (origen === 'lector') {
    if (!Number.isSafeInteger(dto.numero) || (dto.numero as number) < 1) {
      throw badRequest('Falta el número de la factura leída. Escríbelo (tal como aparece en la factura) antes de registrarla.', {
        campo: 'numero',
      });
    }
    if (!String(dto.serie ?? '').trim()) {
      throw badRequest('Falta la serie de la factura leída. Escríbela (tal como aparece en la factura) antes de registrarla.', {
        campo: 'serie',
      });
    }
    if (dto.borrador || dto.proforma) throw badRequest('Una factura leída se registra ya emitida: no es un borrador ni una proforma.');
  }
  // Del lector, las cuotas ya fijadas de algunas lineas (nunca desde el cuerpo).
  const lineasPedidas = validarLineas(dto.lineas).map((l, i) =>
    origen === 'lector' && opciones.cuotasFijas?.[i] !== undefined ? { ...l, cuotaFija: opciones.cuotasFijas[i] } : l,
  );
  // Rectificativa: el bloque nuevo o los campos de antes, nunca los dos.
  const hayBloque = dto.rectificativa !== undefined && dto.rectificativa !== null;
  const hayFuera = dto.rectificaFuera !== undefined && dto.rectificaFuera !== null;
  if (hayBloque && (dto.facturaOriginalId || hayFuera || (dto.tipoRectificativa !== undefined && dto.tipoRectificativa !== null))) {
    throw badRequest('La rectificativa va solo en su bloque: sin facturaOriginalId, rectificaFuera ni tipoRectificativa.', {
      codigo: 'RECTIFICATIVA_MEZCLA_CAMPOS',
      campo: 'rectificativa',
    });
  }
  // Rectificativa de una factura de fuera de la app con los campos de antes (una de 2026 que trajo la gestoria, por ejemplo).
  const rectFuera = hayFuera ? leerRectificaFuera(dto.rectificaFuera) : null;
  if (rectFuera && dto.facturaOriginalId) throw badRequest('Indica la factura que rectificas de la app o la de fuera, no las dos.');
  if (dto.proforma && (hayBloque || dto.facturaOriginalId || rectFuera)) throw badRequest('Una proforma no puede ser una rectificativa.');
  const bloque: BloqueVenta | null = hayBloque ? leerBloque(dto.rectificativa) : dto.facturaOriginalId || rectFuera ? bloqueDeCamposAntiguos(dto, rectFuera) : null;
  const esRectificativa = !!bloque;
  const nuevo = !!bloque && !bloque.legado;

  // Campos de antes: el tipo pedido y las reglas y textos de siempre.
  let tipoFactura = nuevo ? '' : validarTipoFactura(dto.tipoFactura, esRectificativa ? 'R1' : 'F1');
  const originalAntigua = bloque?.legado && dto.facturaOriginalId ? (interno.original ?? (await buscarConLineas(dto.companyId, String(dto.facturaOriginalId)))) : null;
  if (!nuevo) {
    if (esRectificativa !== tipoFactura.startsWith('R')) {
      throw badRequest('Una factura rectificativa debe ser de tipo R1 a R5, y solo las rectificativas pueden serlo.');
    }
    if (bloque && dto.tipoRectificativa !== undefined && dto.tipoRectificativa !== null && !['S', 'I'].includes(dto.tipoRectificativa)) {
      throw badRequest('Tipo de rectificativa no válido: S (sustitución) o I (diferencias).');
    }
    if (rectFuera && tipoFactura === 'R5') throw badRequest('La R5 rectifica una factura simplificada de la app: para una de fuera, usa R1 a R4.');
    if (rectFuera && (dto.tipoRectificativa ?? 'I') !== 'I') {
      throw badRequest('La rectificativa de una factura de fuera de la app va por diferencias: escribe solo lo que cambia (en negativo si baja).');
    }
    // La R2 (concurso) y la R3 (impago) aun no: ni con los campos antiguos ni por /credit-note.
    if (bloque) exigirTipoRectificativaDisponible(tipoFactura);
    if (bloque && !dto.borrador && !String(dto.motivoRectificacion ?? '').trim()) {
      throw badRequest('Indica el motivo de la rectificación.', { campo: 'motivoRectificacion' });
    }
  }
  // Red de seguridad de VERI*FACTU: antes de crear nada (cliente, numero...).
  // Emitir aqui es la emision directa y la rectificativa emitida al momento; el
  // lector registra facturas que expidio otro programa y no se bloquea.
  const emiteLaApp = !dto.proforma && !dto.borrador && origen !== 'lector';
  // Un solo instante para la red, la fecha por defecto y la de P3: si la red dio
  // permiso el 31-12, la factura no puede salir con fecha del 1-1.
  const ahora = new Date();
  const hoy = hoyEspana(ahora);
  if (emiteLaApp) {
    await exigirPuedeEmitirFinal(
      dto.companyId,
      ahoraRedSeguridad(ahora),
      esRectificativa
        ? 'Puedes guardar la rectificativa como borrador y emitirla cuando esté activo.'
        : 'Puedes guardarla como borrador o como proforma y emitirla cuando esté activo.',
    );
    await exigirDatosEmisor(dto.companyId);
  }

  const perfil = await perfilEmpresa(dto.companyId);
  if (bloque?.legado && dto.facturaOriginalId && !originalAntigua) throw badRequest('La factura que se rectifica no existe.');
  // Solo se rectifica una factura emitida (ni un borrador ni una proforma: su tipo de cambio no es definitivo).
  if (originalAntigua && originalAntigua.estadoDocumento !== ESTADO_FINAL) {
    throw badRequest(
      originalAntigua.estadoDocumento === ESTADO_PROFORMA
        ? 'Una proforma no se rectifica: mientras esté pendiente, modifícala.'
        : 'Un borrador no se rectifica: modifícalo directamente.',
    );
  }
  if (originalAntigua) exigirR5SobreSimplificada(tipoFactura, originalAntigua);

  const fechaEmision = validarFecha(dto.fechaEmision ?? hoy, 'fecha de emisión');
  if (emiteLaApp) exigirFechaNoFutura(fechaEmision, hoy);
  if (rectFuera) {
    if (rectFuera.fecha > fechaEmision) {
      throw badRequest(`La factura que rectificas (${fechaTexto(rectFuera.fecha)}) no puede ser posterior a la rectificativa.`, { campo: 'rectificaFuera.fecha' });
    }
    // Solo las de antes de llevar la facturacion en la app: las de despues estan en la app y se rectifican desde su ficha.
    if (rectFuera.fecha >= (await inicioLlevanzaApp(dto.companyId))) {
      throw badRequest(`La factura que rectificas es del ${fechaTexto(rectFuera.fecha)}, cuando ya llevabas la facturación en la app: búscala en Ventas y rectifícala desde su ficha.`, {
        campo: 'rectificaFuera.fecha',
      });
    }
  }

  // Plan de la rectificativa: originales, cliente, tipo R, sustitucion y fechas.
  const plan: PlanVenta | null = bloque
    ? await prepararRectificativaVenta(bloque, {
        companyId: dto.companyId,
        fechaEmision,
        borrador: !!dto.borrador,
        monedaCuenta: perfil.monedaCuenta,
        tipoFacturaPedido: nuevo ? (dto.tipoFactura ?? undefined) : tipoFactura,
        customerId: dto.customer?.id ?? null,
        customerNuevo: !!dto.customer?.nuevo,
        excluirId: interno.excluirId,
      })
    : null;
  if (plan && nuevo) tipoFactura = plan.tipoFactura;
  const original: FacturaConLineas | null = plan?.herencia ?? null;
  if (original) comprobarHerencia(original, dto, bloque!.forma);
  const moneda = original ? original.moneda : validarMoneda(dto.moneda ?? perfil.monedaCuenta, perfil.monedasFactura);
  comprobarMonedaLineas(dto.lineas, moneda, false);
  // Las cuentas de las facturas que se rectifican valen aunque se hayan desactivado.
  let lineas = await conCuentasDeVenta(dto.companyId, lineasPedidas, plan?.originalesApp ?? null);

  // Sin forma de pago o sin vencimiento: los de Configuración > Facturación.
  const ajustes = await leerAjustesFacturacion(dto.companyId);
  const fechaVencimiento = validarFecha(dto.fechaVencimiento ?? sumarDiasISO(fechaEmision, ajustes.diasVencimiento), 'fecha de vencimiento');
  if (fechaVencimiento < fechaEmision) throw badRequest('El vencimiento no puede ser anterior a la fecha de emisión.');
  // Una rectificativa del bloque nuevo no lleva fecha de la operacion: la pone el servidor si una R4 sube el IVA.
  if (nuevo && hayValor(dto.fechaOperacion)) {
    throw badRequest('Una rectificativa no lleva fecha de la operación: va en el periodo de su fecha de emisión. Si la corrección sube el IVA por un error, la app la lleva sola al periodo de la factura que rectifica.', {
      codigo: 'SIN_FECHA_OPERACION',
      campo: 'fechaOperacion',
    });
  }
  let fechaOperacion = validarFechaOperacion(dto.fechaOperacion, fechaEmision);
  // Una factura emitida (o registrada desde el lector) lleva asiento en su fecha:
  // no puede caer en un mes bloqueado ni en un ejercicio cerrado. Se comprueba
  // antes de numerarla, para no gastar un numero de la serie.
  if (!dto.proforma && !dto.borrador) {
    await comprobarFechaAbierta(dto.companyId, fechaEmision, dto.numero ? 'registrar la factura' : 'emitir la factura');
  }
  // Operacion de un periodo cuyo 303 presenta la gestoria: se confirma antes de
  // crear nada (el cliente nuevo incluido; al confirmar se repite la peticion).
  // Sin el cliente aun no se sabe el tipo de operacion: se toma el indicado (o el
  // de la original), y si no, el devengo es la fecha de la operacion, que nunca
  // es posterior al de una intracomunitaria (se mira otra vez con el definitivo).
  const emitida = !dto.proforma && !dto.borrador;
  const devengoPrevio = fechaOperacion
    ? fechaDevengoVenta({ tipoOperacion: original?.tipoOperacion ?? dto.tipoOperacion ?? null, fechaOperacion, fechaEmision })
    : fechaEmision;
  const fueraPrevio = emitida ? await devengoEnPeriodoDeFuera(dto.companyId, devengoPrevio, fechaEmision) : null;
  if (fueraPrevio && dto.confirmaDevengoFuera !== true) throw errorDevengoFuera(devengoPrevio, fueraPrevio);
  // Plantilla y envases ANTES del cliente (resolverCliente puede crear uno): una
  // factura rechazada por sus envases no deja nada creado. La plantilla la fija
  // el servidor, nunca el cuerpo: del lector, la estandar; una rectificativa de
  // una factura de la app, la de la original (y su IEEPNR: si lo repercutio y a
  // que tipo); el resto, la de su serie (la proforma, la de la serie P).
  const deOriginal = original ? envasesDeOriginal(original) : null;
  const plantilla: PlantillaVentaId =
    origen === 'lector' ? 'default' : deOriginal ? deOriginal.plantilla : await plantillaDelAlta(dto.companyId, dto, { esRectificativa, tipoFactura });
  const pesoBrutoKg = leerPesoBruto(dto.pesoBrutoKg) ?? null;
  if (pesoBrutoKg !== null && !admiteEnvases(plantilla)) throw errorSinEnvases('pesoBrutoKg');
  const envases = aplicarEnvases(lineas, {
    plantilla,
    repercute: deOriginal ? deOriginal.repercute : perfil.espanola && ajustes.ieepnrRepercute,
    tipo: deOriginal?.tipo ?? ajustes.ieepnrPorKg,
    moneda,
    simetrico: esRectificativa,
    soloKg: esRectificativa && bloque?.forma !== 'S',
  });
  lineas = envases.lineas;
  // Cliente y serie despues de las fechas: una factura rechazada no deja nada creado.
  // Con una original de la app (o una partida de 2026), el cliente es el suyo.
  const cliente = await resolverCliente(dto.companyId, plan?.customerId ? { id: plan.customerId } : dto.customer);
  // La serie de rectificativas de tickets (RT) se crea con la primera R5: esa se
  // resuelve al final de las comprobaciones, para que una R5 rechazada (signo,
  // limites...) no la deje creada. Las demas, aqui, como siempre.
  const serieDeTickets = !dto.proforma && esRectificativa && tipoFactura === 'R5' && !dto.serie;
  const resolverLaSerie = async () =>
    dto.proforma ? { codigo: await resolverSerieProforma(dto.companyId, dto.serie) } : await resolverSerie(dto.companyId, dto.serie, { esRectificativa, tipoFactura, origen });
  const serieAntes = serieDeTickets ? null : await resolverLaSerie();
  if (serieAntes && emiteLaApp) exigirSerieValidaAeat(serieAntes.codigo);

  // Quien revisa la fiscalidad lo decide el servidor, nunca el cuerpo.
  const modo: ModoFiscal = original
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
      tipoFactura: tipoFactura as TipoFactura,
      lineas,
      ...(original ? { heredado: herencia(original) } : {}),
    },
    modo,
  );
  // Rectificativa total: las lineas espejo se copian tal cual de la original
  // (las de crearRectificativa o, por diferencias, unas que lo son exactamente).
  let espejo = interno.importes ?? null;
  if (!espejo) {
    lineas = conFiscalidad(lineas, fiscal);
    // Por diferencias, la retencion de la original (las lineas espejo ya la llevan).
    if (plan) exigirRetencionDeOriginales(plan, lineas);
    if (plan && original && bloque!.forma === 'I' && plan.filas.length === 1 && esEspejoDe(lineas, original)) {
      const copia = lineasEspejo(importesGuardados(original));
      espejo = {
        ...copia,
        lineas: copia.lineas.map((l, i) => {
          const { textoAdicional: _texto, ...resto } = l;
          void _texto;
          return { ...resto, descripcion: lineas[i].descripcion, ...(lineas[i].textoAdicional ? { textoAdicional: lineas[i].textoAdicional } : {}) };
        }),
      };
    }
  }
  // Devengo (fija el tipo de cambio, art. 79.Once LIVA): el de la operacion o el de emision.
  let devengo = fechaDevengoVenta({ tipoOperacion: fiscal.tipoOperacion, fechaOperacion, fechaEmision });

  // Tipo de cambio, ANTES de cualquier transaccion. Emitir exige el definitivo.
  const emite = !dto.proforma && !dto.borrador;
  const tipo = original
    ? tipoHeredado(original, perfil.monedaCuenta)
    : await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda, devengo, manual: dto.tipoCambio, definitivo: emite });
  if (emite && tipo.tipoCambio === null) throw badRequest(mensajeSinTipo(moneda, devengo));

  // Las rectificativas redondean con signo (simetrico): -0,525 da -0,53, como la original da 0,53.
  const importes =
    espejo ??
    calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: moneda === perfil.monedaCuenta, simetrico: esRectificativa, cuotaPorTipo: ivaPorTipo(plantilla) });

  // Cierre del plan con los importes: la parte de cada original, el signo, los
  // plazos y la fecha de la operacion de una R4 que sube el IVA.
  const cierre = plan
    ? cerrarPlan(
        plan,
        {
          base: importes.cuenta.baseTotal,
          cuota: importes.cuenta.ivaTotal,
          retencion: importes.cuenta.retencionTotal,
          total: importes.cuenta.totalFactura,
          lineas: importes.lineas.map((l) => ({
            tipoIva: l.tipoIva,
            cuenta: l.cuentaContable ?? null,
            baseLine: l.cuenta.baseLine,
            ivaImporte: l.cuenta.ivaImporte,
            retencionImporte: l.cuenta.retencionImporte,
          })),
        },
        { fechaEmision, clienteConNif: !!cliente.fiscal.nifCif?.trim(), mensual: await declaraCadaMes(dto.companyId, fechaEmision) },
      )
    : null;
  let avisoR4: AvisoFiscal | null = null;
  if (cierre?.fechaOperacion) {
    fechaOperacion = cierre.fechaOperacion;
    devengo = fechaDevengoVenta({ tipoOperacion: fiscal.tipoOperacion, fechaOperacion, fechaEmision });
    // El periodo de la original lo presenta la gestoria, o su 303 ya esta presentado:
    // se emite si se confirma (409 DEVENGO_FUERA_APP, con motivo rectificar_303 en el segundo caso).
    avisoR4 = emitida ? await exigirPeriodoDeR4(dto.companyId, devengo, fechaEmision, dto.confirmaDevengoFuera === true) : null;
  }
  // Rectificativa por diferencias: no por encima de lo que queda de cada original (se repite dentro de la transaccion).
  if (cierre && bloque!.forma === 'I') await exigirLimites(prisma, dto.companyId, plan!.originalesApp, partesDe(cierre.enlaces), interno.excluirId);
  if (emiteLaApp) exigirLimiteSimplificada(tipoFactura, perfil, importes.cuenta);
  const serie = serieAntes ?? (await resolverLaSerie());
  if (!serieAntes && emiteLaApp) exigirSerieValidaAeat(serie.codigo);

  const comunes: Prisma.IncomeInvoiceUncheckedCreateInput = {
    companyId: dto.companyId,
    origen,
    customerId: cliente.id,
    serie: serie.codigo,
    fechaEmision,
    fechaVencimiento,
    fechaOperacion,
    tipoFactura,
    formaPago: validarFormaPago(dto.formaPago, ajustes.formaPago),
    ...cabecera(importes),
    moneda,
    ...datosTipo(tipo),
    tipoOperacion: fiscal.tipoOperacion,
    causaExencion: fiscal.causaExencion,
    referenciaLegal: fiscal.referenciaLegal,
    // Rectificativa de una factura sin tipo: se clasifica con el mismo pais que la original.
    ...(original && !fiscal.tipoOperacion && !esTipoOperacion(original.tipoOperacion) ? { paisClienteLegacy: paisCongelado(original) } : {}),
    // La plantilla la fija el servidor (dto.plantillaId se ignora).
    plantillaId: plantilla,
    pesoBrutoKg: admiteEnvases(plantilla) ? pesoBrutoKg : null,
    ieepnrPorKg: envases.ieepnrPorKg,
    observaciones: dto.observaciones,
    esRectificativa,
    // Con una sola original, tambien en los campos de antes (Carmen, la cartera y el PDF los leen).
    ...(cierre ? columnasCompatibles(cierre.enlaces) : { facturaOriginalId: null, rectificaFueraNumero: null, rectificaFueraFecha: null }),
    tipoRectificativa: bloque ? bloque.forma : null,
    motivoRectificacion: bloque ? bloque.explicacion || null : null,
    causaRectificacion: bloque?.motivo ?? null,
    lineas: { create: lineasACrear(importes) },
  };
  // Confirmada la venta con la operacion en un periodo de la gestoria: el aviso queda en la respuesta.
  const fuera = !avisoR4 && fueraPrevio ? await devengoEnPeriodoDeFuera(dto.companyId, devengo, fechaEmision) : null;
  const avisoIeepnr = avisoIeepnrFueraDeEspana(fiscal.tipoOperacion, lineas);
  const avisosFiscales: AvisoFiscal[] = [
    ...(fiscal.avisos ?? []),
    ...(avisoIeepnr ? [avisoIeepnr] : []),
    ...(fuera ? [{ codigo: 'DEVENGO_FUERA_APP', mensaje: textoDevengoFuera(devengo, fuera) }] : []),
    ...(avisoR4 ? [avisoR4] : []),
    ...(serie.aviso ? [serie.aviso] : []),
    ...(cierre?.avisos ?? []),
  ];
  return {
    comunes,
    ctx: { monedaCuenta: perfil.monedaCuenta, avisosFiscales, avisoTipoCambio: tipo.aviso },
    serie: serie.codigo,
    fechaEmision,
    fechaVencimiento,
    rect: cierre ? { forma: bloque!.forma, enlaces: cierre.enlaces } : null,
  };
}

/**
 * Crea una factura (borrador, proforma, emitida o rectificativa). Los enlaces
 * de una rectificativa se guardan en la misma transaccion que la factura, en
 * los tres caminos (borrador, lector y emision directa).
 */
async function crear(dto: CrearFacturaIngresoDTO, opciones: OpcionesAlta, interno: Interno): Promise<IncomeInvoiceResp> {
  const a = await prepararAlta(dto, opciones, interno);
  const { comunes, ctx, serie, fechaEmision, fechaVencimiento, rect } = a;
  // Los enlaces y, si ya cuenta (emitida o registrada), el estado de las partidas de 2026 que rebaja.
  const enlazar = async (tx: Tx, id: string, emitida = false) => {
    if (!rect) return;
    await guardarEnlacesVenta(tx, dto.companyId, id, rect.enlaces);
    if (emitida) await recalcularEstadoPartidas(tx, dto.companyId, partidasDe(rect.enlaces));
    // Por sustitucion, lo cobrado a la original cuenta: si ya estaba cobrada, la S nace cobrada.
    if (emitida && rect.forma === 'S') await recalcularEstadoCobroVenta(tx, dto.companyId, id);
  };

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
    return respuesta(proforma, ctx);
  }

  // Borrador: sin numero, no cuenta para nada hasta que se finalice.
  if (dto.borrador) {
    const factura = await transaccion(async (tx) => {
      const f = await tx.incomeInvoice.create({
        data: { ...comunes, estadoDocumento: ESTADO_BORRADOR, estado: 'DRAFT' },
        include: INCLUIR,
      });
      await enlazar(tx, f.id);
      return f;
    });
    return respuesta(factura, ctx);
  }

  // Al emitir se copian el IBAN y el pie de ahora: el PDF ya no cambia con los ajustes.
  const copia = await copiaAlEmitir(dto.companyId, String(comunes.moneda));

  // Factura emitida fuera de la app (lector): conserva su numero original. La
  // comprobacion, el alta y el contador de su serie (historica) van juntos.
  // numeroCompleto es el numero tal como se expidio (art. 63 RIVA: «F2026/0012»,
  // con sus ceros y su separador); serie + numero (entero) sirven para que no
  // se repita y para el contador.
  if (dto.numero) {
    const numero = dto.numero;
    const numeroCompleto = numeroCompletoLeido(opciones.numeroLeido, serie) ?? `${serie}-${numero}`;
    const factura = await transaccion(async (tx) => {
      if (rect) await exigirRectificablesEnTx(tx, dto.companyId, rect);
      const existe = await tx.incomeInvoice.findFirst({
        where: { companyId: dto.companyId, OR: [{ serie, numero }, { numeroCompleto }] },
        select: { numeroCompleto: true },
      });
      if (existe) throw badRequest(`La factura ${existe.numeroCompleto ?? numeroCompleto} ya existe.`, { codigo: 'FACTURA_DUPLICADA', campo: 'numero' });
      const creada = await tx.incomeInvoice.create({
        data: {
          ...comunes,
          ...copia,
          numero,
          numeroCompleto,
          estadoDocumento: ESTADO_FINAL,
          finalizadaEn: new Date(),
          estado: determinarEstado(fechaVencimiento),
        },
        include: INCLUIR,
      });
      await enlazar(tx, creada.id, true);
      await tx.invoiceSeries.updateMany({
        where: { companyId: dto.companyId, codigo: serie, ultimoNumero: { lt: numero } },
        data: { ultimoNumero: numero },
      });
      return creada;
    }, rect ? AISLAMIENTO_RECTIFICATIVAS : undefined);
    return respuesta(factura, ctx);
  }

  // Emision directa: numero de la serie en la misma transaccion. Con una
  // rectificativa, sus previas se leen tras bloquear las originales con READ
  // COMMITTED (AISLAMIENTO_RECTIFICATIVAS), tambien en el lector y al emitir un borrador.
  const factura = await transaccion(async (tx) => {
    if (rect) await exigirRectificablesEnTx(tx, dto.companyId, rect);
    const numero = await asignarNumero(tx, dto.companyId, serie, fechaEmision);
    const creada = await tx.incomeInvoice.create({
      data: {
        ...comunes,
        ...copia,
        numero,
        numeroCompleto: `${serie}-${numero}`,
        estadoDocumento: ESTADO_FINAL,
        finalizadaEn: new Date(),
        estado: determinarEstado(fechaVencimiento),
      },
      include: INCLUIR,
    });
    await enlazar(tx, creada.id, true);
    return creada;
  }, rect ? AISLAMIENTO_RECTIFICATIVAS : undefined);
  return respuesta(factura, ctx);
}

/** Un bloque guardado, en la forma del cuerpo (para volver a pasarlo por leerBloque al corregir el borrador). */
function bloqueApi(b: BloqueVenta): Record<string, unknown> {
  return {
    ticket: b.ticket,
    forma: b.forma,
    motivo: b.motivo,
    explicacion: b.explicacion,
    ...(b.periodo ? { periodo: b.periodo } : { originales: b.originales }),
  };
}

/**
 * Corrige el borrador de una rectificativa con su bloque: se vuelve a
 * comprobar entero, como un alta (prepararAlta), y se cambian en la misma
 * transaccion la cabecera, las lineas y los enlaces. Lo que no llega en el
 * cuerpo se toma del borrador; la moneda, el tipo de cambio y el tipo de
 * operacion solo sin original de la app (con ella se heredan).
 */
async function actualizarBorradorRectificativa(actual: FacturaConLineas, dto: ActualizarBorradorDTO, rectificativa: unknown): Promise<IncomeInvoiceResp> {
  const companyId = actual.companyId;
  const r = (rectificativa && typeof rectificativa === 'object' ? rectificativa : {}) as { originales?: unknown; ticket?: unknown };
  const conApp = Array.isArray(r.originales) && r.originales.some((o) => !!o && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string');
  const deActual = <T,>(v: T | undefined, a: T): T | undefined => (v !== undefined ? v : conApp ? undefined : a);
  const merged: CrearFacturaIngresoDTO = {
    companyId,
    // Sin cliente en el cuerpo y con original de la app: el de la original (lo pone el plan).
    customer: dto.customer ?? (conApp ? {} : { id: actual.customerId }),
    // Si pasa de «Rectificativa o abono» a «de un ticket» (o al reves) sin decir la serie,
    // la de su tipo por defecto (la RT se crea si aun no existe), no la que tenia.
    serie: dto.serie ?? ((r.ticket === true) === (actual.tipoFactura === 'R5') ? actual.serie : undefined),
    fechaEmision: dto.fechaEmision ?? actual.fechaEmision,
    fechaVencimiento: dto.fechaVencimiento ?? actual.fechaVencimiento,
    // Con sus packs, kg y texto (el IEEPNR se vuelve a calcular con el tipo que toque).
    lineas: dto.lineas ?? lineasDocGuardadas(actual).map(({ cuentaContable, ...l }) => ({ ...l, cuenta: cuentaContable ?? null })),
    pesoBrutoKg: dto.pesoBrutoKg !== undefined ? dto.pesoBrutoKg : actual.pesoBrutoKg,
    observaciones: dto.observaciones ?? actual.observaciones ?? undefined,
    borrador: true,
    ...(dto.tipoFactura !== undefined ? { tipoFactura: dto.tipoFactura } : {}),
    formaPago: (dto.formaPago ?? actual.formaPago) as FormaPago,
    moneda: deActual(dto.moneda, actual.moneda),
    tipoCambio: deActual(dto.tipoCambio, actual.fuenteTipoCambio === 'MANUAL' ? actual.tipoCambio : undefined),
    tipoOperacion: deActual(dto.tipoOperacion, actual.tipoOperacion),
    causaExencion: deActual(dto.causaExencion, actual.causaExencion),
    referenciaLegal: deActual(dto.referenciaLegal, actual.referenciaLegal),
    fechaOperacion: dto.fechaOperacion,
    rectificativa,
  };
  const a = await prepararAlta(merged, { origen: (actual.origen as OrigenFactura | null) ?? 'pantalla' }, { excluirId: actual.id });
  const { companyId: _empresa, origen: _origen, ...datos } = a.comunes;
  void _empresa;
  void _origen;
  const factura = await transaccion(async (tx) => {
    // Solo si nadie la ha emitido ni cambiado desde que se leyo.
    const libre = await tx.incomeInvoice.updateMany({
      where: { id: actual.id, companyId, estadoDocumento: ESTADO_BORRADOR, updatedAt: actual.updatedAt },
      data: { updatedAt: new Date() },
    });
    if (libre.count !== 1) throw badRequest('La factura ha cambiado (o se ha emitido) mientras se guardaba: vuelve a abrirla y repite el cambio.');
    await tx.incomeInvoiceLine.deleteMany({ where: { invoiceId: actual.id } });
    const f = await tx.incomeInvoice.update({
      where: { id: actual.id },
      data: { ...(datos as Prisma.IncomeInvoiceUncheckedUpdateInput), estadoDocumento: ESTADO_BORRADOR, estado: 'DRAFT' },
      include: INCLUIR,
    });
    await guardarEnlacesVenta(tx, companyId, actual.id, a.rect?.enlaces ?? []);
    return f;
  });
  return respuesta(factura, a.ctx);
}

export const incomeInvoicesService = {
  /**
   * Crear factura de venta: como borrador (sin numero) o ya emitida.
   * `opciones.origen` lo pone quien llama desde el servidor (lector OCR,
   * copia); lo que llegue en el cuerpo con ese nombre se ignora.
   */
  async crearIngreso(dto: CrearFacturaIngresoDTO, opciones: OpcionesAlta = {}): Promise<IncomeInvoiceResp> {
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
    // El numero solo lo trae una factura del lector (la expidio otro programa).
    // Desde la pantalla o la API lo pone siempre la serie, dentro de la transaccion.
    if (opciones.origen !== 'lector') delete limpio.numero;
    return crear(
      limpio,
      { origen: opciones.origen, ...(opciones.origen === 'lector' ? { numeroLeido: opciones.numeroLeido, cuotasFijas: opciones.cuotasFijas } : {}) },
      {},
    );
  },

  /**
   * Modifica un borrador. Una factura emitida no se toca. El borrador de una
   * rectificativa con el bloque `rectificativa` (o hecho con el bloque nuevo)
   * se vuelve a comprobar entero y cambia lineas y enlaces en la misma
   * transaccion. Un borrador de factura no pasa a rectificativa ni al reves.
   */
  async actualizarBorrador(companyId: string, id: string, dto: ActualizarBorradorDTO): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirEditable(actual, 'modificar');
    exigirNoFinal(actual);
    const conBloque = dto.rectificativa !== undefined && dto.rectificativa !== null;
    if (conBloque && !actual.esRectificativa) {
      throw badRequest('Un borrador de factura no se convierte en rectificativa: crea la rectificativa desde «Nueva factura».', {
        codigo: 'NO_ES_RECTIFICATIVA',
        campo: 'rectificativa',
      });
    }
    if (actual.esRectificativa && actual.estadoDocumento === ESTADO_BORRADOR && (conBloque || actual.causaRectificacion)) {
      return actualizarBorradorRectificativa(actual, dto, conBloque ? dto.rectificativa : bloqueApi(await bloqueGuardado(actual)));
    }
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
      data.serie = (await resolverSerie(companyId, dto.serie, { esRectificativa: actual.esRectificativa, tipoFactura: dto.tipoFactura ?? actual.tipoFactura })).codigo;
    }
    let tipoFactura = actual.tipoFactura;
    if (dto.tipoFactura !== undefined) {
      const t = validarTipoFactura(dto.tipoFactura, 'F1');
      if (actual.esRectificativa !== t.startsWith('R')) throw badRequest('El tipo no corresponde a esta factura.');
      exigirTipoRectificativaDisponible(t);
      data.tipoFactura = t;
      tipoFactura = t;
    }
    if (dto.observaciones !== undefined) data.observaciones = dto.observaciones;
    if (dto.formaPago !== undefined) data.formaPago = validarFormaPago(dto.formaPago);
    // dto.plantillaId se ignora: la plantilla sale de la serie (o de la original), mas abajo.
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

    // Moneda: los precios no se convierten solos.
    const original = actual.esRectificativa && actual.facturaOriginalId ? await buscarConLineas(companyId, actual.facturaOriginalId) : null;
    if (original) comprobarHerencia(original, dto);
    // P9: tambien al cambiar el tipo de un borrador de rectificativa.
    if (dto.tipoFactura !== undefined) exigirR5SobreSimplificada(tipoFactura, original);
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
    let lineas = dto.lineas ? await conCuentasDeVenta(companyId, validarLineas(dto.lineas), original) : lineasDocGuardadas(actual);
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
        ...(original ? { heredado: herencia(original) } : {}),
      },
      original ? 'heredar' : 'guardar',
    );
    data.tipoOperacion = fiscal.tipoOperacion;
    data.causaExencion = fiscal.causaExencion;
    data.referenciaLegal = fiscal.referenciaLegal;
    const normaliza = fiscal.lineas.some((l, i) => l.tipoIva !== (lineas[i].tipoIva ?? 21) || l.tipoRetencion !== (lineas[i].tipoRetencion ?? 0));
    lineas = conFiscalidad(lineas, fiscal);

    // Plantilla: en una rectificativa de una factura de la app, la de la
    // original. Si no, la de la serie (la nueva o la que tenia; una proforma no
    // cambia de serie), que se vuelve a mirar al guardar con lineas o al cambiar
    // de serie. Sin lineas y en la misma serie se queda la guardada: un borrador
    // de antes de que su serie cambiara de plantilla se puede retocar
    // (observaciones, fechas...) sin cambiar de calculo, y se emite con ella.
    // Los envases se comprueban con la plantilla, tambien las lineas guardadas:
    // si pasa a una serie sin envases con kg, 400. El IEEPNR solo se recalcula
    // con lineas en el cuerpo (con el tipo de hoy).
    const deOriginal = original ? envasesDeOriginal(original) : null;
    const cambiaSerie = data.serie !== undefined && data.serie !== actual.serie;
    const plantilla: PlantillaVentaId = deOriginal
      ? deOriginal.plantilla
      : dto.lineas || cambiaSerie
        ? await plantillaDeSerie(companyId, (data.serie as string | undefined) ?? actual.serie)
        : normalizarPlantillaId(actual.plantillaId);
    const ajustes = await leerAjustesFacturacion(companyId);
    const envases = aplicarEnvases(lineas, {
      plantilla,
      repercute: deOriginal ? deOriginal.repercute : dto.lineas ? perfil.espanola && ajustes.ieepnrRepercute : actual.ieepnrPorKg !== null,
      tipo: deOriginal?.tipo ?? (dto.lineas ? ajustes.ieepnrPorKg : (actual.ieepnrPorKg ?? ajustes.ieepnrPorKg)),
      moneda,
      simetrico: actual.esRectificativa,
      soloKg: actual.esRectificativa && actual.tipoRectificativa !== 'S',
      recalcular: !!dto.lineas,
    });
    lineas = envases.lineas;
    data.plantillaId = plantilla;
    data.ieepnrPorKg = envases.ieepnrPorKg;
    const peso = leerPesoBruto(dto.pesoBrutoKg);
    if (peso !== undefined && peso !== null && !admiteEnvases(plantilla)) throw errorSinEnvases('pesoBrutoKg');
    // Peso bruto: el que llegue; si la plantilla nueva no lleva envases, se quita (es solo informativo).
    if (peso !== undefined) data.pesoBrutoKg = peso;
    else if (!admiteEnvases(plantilla) && actual.pesoBrutoKg !== null) data.pesoBrutoKg = null;
    const cambiaPlantilla = plantilla !== normalizarPlantillaId(actual.plantillaId);

    const devengo = fechaDevengoVenta({ tipoOperacion: fiscal.tipoOperacion, fechaOperacion, fechaEmision });
    const devengoAntes = fechaDevengoVenta(actual);

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

    const recalcular =
      !!dto.lineas ||
      normaliza ||
      cambiaPlantilla ||
      moneda !== actual.moneda ||
      (tipo !== null && tipo.tipoCambio !== actual.tipoCambio) ||
      (tipo !== null && tipo.fuente !== actual.fuenteTipoCambio);
    const factura = await transaccion(async (tx) => {
      // Bloquea la fila y comprueba que nadie la ha emitido ni cambiado desde que se leyo
      // (mientras se consultaba el tipo de cambio, otra peticion podria haberla emitido).
      const libre = await tx.incomeInvoice.updateMany({
        where: { id, companyId, estadoDocumento: actual.estadoDocumento, updatedAt: actual.updatedAt },
        data: { updatedAt: new Date() },
      });
      if (libre.count !== 1) {
        throw badRequest('La factura ha cambiado (o se ha emitido) mientras se guardaba: vuelve a abrirla y repite el cambio.');
      }
      if (recalcular) {
        exigirNoFinal(actual);
        const importes = calcularImportesFactura(lineas, { tipoCambio, mismaMoneda: misma, simetrico: actual.esRectificativa, cuotaPorTipo: ivaPorTipo(plantilla) });
        await tx.incomeInvoiceLine.deleteMany({ where: { invoiceId: id } });
        Object.assign(data, cabecera(importes), { lineas: { create: lineasACrear(importes) } });
      }
      return tx.incomeInvoice.update({ where: { id }, data, include: INCLUIR });
    });
    const avisoIeepnr = avisoIeepnrFueraDeEspana(fiscal.tipoOperacion, lineas);
    return aRespuesta(factura, {
      monedaCuenta: perfil.monedaCuenta,
      avisosFiscales: [...(fiscal.avisos ?? []), ...(avisoIeepnr ? [avisoIeepnr] : [])],
      avisoTipoCambio: tipo?.aviso,
    });
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
    // A la serie de facturas por defecto si su plantilla admite lo que trae la
    // proforma; si no, a la primera que lo admita (serieCompatible): con envases
    // (packs, kg, texto o peso bruto), una con la A; con descuento por linea, una
    // sin la A. Si no hay, 400 SIN_SERIE_ENVASES o SIN_SERIE_DESCUENTO. La
    // plantilla es la de esa serie (no la de la proforma).
    const porDefecto = await resolverCodSerieFactura(companyId, {});
    const necesita = necesidadPlantilla(p);
    const serie = necesita ? await serieCompatible(companyId, 'FACTURA', porDefecto, necesita) : porDefecto;
    const plantilla = await plantillaDeSerie(companyId, serie);
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
    // Las lineas pasan como cuerpo: el IEEPNR se recalcula con el tipo de hoy.
    const ajustes = await leerAjustesFacturacion(companyId);
    const envases = aplicarEnvases(lineas, { plantilla, repercute: perfil.espanola && ajustes.ieepnrRepercute, tipo: ajustes.ieepnrPorKg, moneda: p.moneda, simetrico: false });
    lineas = envases.lineas;
    const tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: p.moneda, devengo: hoy, definitivo: false });
    const importes = calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: p.moneda === perfil.monedaCuenta, cuotaPorTipo: ivaPorTipo(plantilla) });

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
          plantillaId: plantilla,
          pesoBrutoKg: admiteEnvases(plantilla) ? p.pesoBrutoKg : null,
          ieepnrPorKg: envases.ieepnrPorKg,
          observaciones: p.observaciones,
          esRectificativa: false,
          proformaId: p.id,
          // Nace de otro documento, como al duplicar (spec verifactu 2.8).
          origen: 'copia',
          estadoDocumento: ESTADO_BORRADOR,
          estado: 'DRAFT',
          lineas: { create: lineasACrear(importes) },
        },
        include: INCLUIR,
      });
    });
    const avisoIeepnr = avisoIeepnrFueraDeEspana(fiscal.tipoOperacion, lineas);
    return aRespuesta(factura, {
      monedaCuenta: perfil.monedaCuenta,
      avisosFiscales: [...(fiscal.avisos ?? []), ...(avisoIeepnr ? [avisoIeepnr] : [])],
      avisoTipoCambio: tipo.aviso,
    });
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
    opciones: { fechaEmision?: string; tipoCambio?: unknown; confirmaDevengoFuera?: boolean } = {},
  ): Promise<IncomeInvoiceResp> {
    const actual = await cargar(companyId, id);
    exigirBorrador(actual, 'volver a emitir');
    // Red de seguridad de VERI*FACTU, fuera de la transaccion y antes de nada. El
    // mismo instante sirve para la fecha por defecto y para P3.
    const ahora = new Date();
    const hoy = hoyEspana(ahora);
    await exigirPuedeEmitirFinal(
      companyId,
      ahoraRedSeguridad(ahora),
      'El borrador sigue guardado: lo podrás pasar a factura cuando VERI*FACTU esté activo.',
    );
    const perfil = await exigirDatosEmisor(companyId);
    if (actual.lineas.length === 0) throw badRequest('La factura no tiene líneas.');
    // Un borrador antiguo de R2 o R3 tampoco se emite: aun no se pueden hacer.
    if (actual.esRectificativa) exigirTipoRectificativaDisponible(actual.tipoFactura);
    if (actual.esRectificativa && !actual.motivoRectificacion?.trim()) {
      throw actual.causaRectificacion
        ? badRequest('Explica en una frase por qué rectificas la factura: es obligatorio y sale en el PDF.', { codigo: 'FALTA_EXPLICACION', campo: 'rectificativa.explicacion' })
        : badRequest('Indica el motivo de la rectificación antes de emitirla.');
    }

    const fechaEmision = validarFecha(opciones.fechaEmision ?? hoy, 'fecha de emisión');
    exigirFechaNoFutura(fechaEmision, hoy);
    exigirSerieValidaAeat(actual.serie);
    // Ni en un mes bloqueado ni en un ejercicio cerrado (antes de numerarla).
    await comprobarFechaAbierta(companyId, fechaEmision, 'emitir la factura');
    // Se mantienen los dias de plazo que tenia el borrador.
    const fechaVencimiento = sumarDias(fechaEmision, plazoDias(actual));
    // Rectificativa: se vuelve a comprobar su bloque (originales, cliente, tipo,
    // sustitucion y fechas) con la fecha de emision definitiva, y su serie.
    const planRect = actual.esRectificativa
      ? await prepararRectificativaVenta(await bloqueGuardado(actual), {
          companyId,
          fechaEmision,
          borrador: false,
          monedaCuenta: perfil.monedaCuenta,
          tipoFacturaPedido: actual.tipoFactura,
          customerId: actual.customerId,
          excluirId: id,
        })
      : null;
    // Una rectificativa con motivo no lleva fecha de la operacion propia: la pone
    // cerrarPlan con la fecha de emision definitiva (R4 que sube el IVA), no la del borrador.
    let fechaOperacion = planRect && !planRect.bloque.legado ? null : actual.fechaOperacion && actual.fechaOperacion !== fechaEmision ? actual.fechaOperacion : null;
    if (planRect && !planRect.bloque.legado) await resolverSerie(companyId, actual.serie, { esRectificativa: true, tipoFactura: actual.tipoFactura });
    // Tipo de operacion definitivo, con el cliente y la empresa de ahora.
    const original = planRect?.herencia ?? null;
    // P9: una R5 solo rectifica una F2, aunque el tipo se cambiara en el borrador.
    exigirR5SobreSimplificada(actual.tipoFactura, original);
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
        ...(original ? { heredado: herencia(original) } : {}),
      },
      original ? 'heredar' : 'emitir',
    );
    const normaliza = fiscal.lineas.some((l, i) => l.tipoIva !== (lineas[i].tipoIva ?? 21) || l.tipoRetencion !== (lineas[i].tipoRetencion ?? 0));
    lineas = conFiscalidad(lineas, fiscal);
    if (planRect) exigirRetencionDeOriginales(planRect, lineas);
    const devengo = fechaDevengoVenta({ tipoOperacion: fiscal.tipoOperacion, fechaOperacion, fechaEmision });
    const devengoBorrador = fechaDevengoVenta(actual);
    // Operacion de un periodo cuyo 303 presenta la gestoria: se emite si se confirma, con el aviso.
    const fuera = await devengoEnPeriodoDeFuera(companyId, devengo, fechaEmision);
    if (fuera && opciones.confirmaDevengoFuera !== true) throw errorDevengoFuera(devengo, fuera);

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
    } else if (actual.fuenteTipoCambio === 'MANUAL' && devengo === devengoBorrador && opciones.tipoCambio !== null) {
      // El manual del borrador se mantiene; con tipoCambio: null se vuelve al del BCE.
      tipo = { tipoCambio: actual.tipoCambio, fechaTipoCambio: actual.fechaTipoCambio, fuente: 'MANUAL', provisional: false };
    } else {
      tipo = await resolverTipoCambio({ monedaCuenta: perfil.monedaCuenta, moneda: actual.moneda, devengo, definitivo: true });
    }
    if (tipo.tipoCambio === null) throw badRequest(mensajeSinTipo(actual.moneda, devengo));

    // EUR -> EUR sin normalizar: no se recalcula nada (igual bit a bit que antes).
    // Rectificativa (tipo heredado): sus importes ya se calcularon con el tipo
    // definitivo al crearla; la total es el espejo exacto de la original, y
    // recalcularla con el redondeo de siempre no daria la pareja a cero.
    const heredado = !misma && (actual.fuenteTipoCambio === 'HEREDADO' || !!original);
    const recalcular = normaliza || (!misma && !heredado);
    exigirNoFinal(actual);
    // Con las lineas guardadas: el IEEPNR guardado no se recalcula; la A, con el IVA por tipo.
    const importes = recalcular
      ? calcularImportesFactura(lineas, { tipoCambio: tipo.tipoCambio, mismaMoneda: misma, simetrico: actual.esRectificativa, cuotaPorTipo: ivaPorTipo(actual.plantillaId) })
      : null;
    exigirLimiteSimplificada(actual.tipoFactura, perfil, importes ? importes.cuenta : actual);
    // IBAN y pie de ahora, copiados en la factura: su PDF ya no cambia con los ajustes.
    const copia = await copiaAlEmitir(companyId, actual.moneda);

    // Rectificativa: la parte de cada original, ni de otra rectificativa ni por
    // encima de lo que queda de cada original (se repite en la transaccion).
    const cuenta = importes ? importes.cuenta : { baseTotal: actual.baseTotal, ivaTotal: actual.ivaTotal, retencionTotal: actual.retencionTotal, totalFactura: actual.totalFactura };
    const cierre = planRect
      ? cerrarPlan(
          planRect,
          {
            base: cuenta.baseTotal,
            cuota: cuenta.ivaTotal,
            retencion: cuenta.retencionTotal,
            total: cuenta.totalFactura,
            lineas: importes
              ? importes.lineas.map((l) => ({ tipoIva: l.tipoIva, cuenta: l.cuentaContable ?? null, baseLine: l.cuenta.baseLine, ivaImporte: l.cuenta.ivaImporte, retencionImporte: l.cuenta.retencionImporte }))
              : lineasImportesDe(actual),
          },
          { fechaEmision, clienteConNif: !!actual.customer.nifCif?.trim(), mensual: await declaraCadaMes(companyId, fechaEmision) },
        )
      : null;
    // R4 que sube el IVA: al periodo de la original, con la fecha de emision de
    // ahora (en el borrador pudo no hacer falta). Si es de la gestoria o su 303
    // ya esta presentado, se confirma (409 DEVENGO_FUERA_APP).
    let avisoR4: AvisoFiscal | null = null;
    if (cierre?.fechaOperacion) {
      fechaOperacion = cierre.fechaOperacion;
      const devengoR4 = fechaDevengoVenta({ tipoOperacion: fiscal.tipoOperacion, fechaOperacion, fechaEmision });
      avisoR4 = await exigirPeriodoDeR4(companyId, devengoR4, fechaEmision, opciones.confirmaDevengoFuera === true);
    }
    const rect = cierre ? { forma: planRect!.bloque.forma, enlaces: cierre.enlaces } : null;
    if (rect && rect.forma === 'I') await exigirLimites(prisma, companyId, planRect!.originalesApp, partesDe(rect.enlaces), id);
    const factura = await transaccion(async (tx) => {
      if (rect) await exigirRectificablesEnTx(tx, companyId, rect, id);
      const numero = await asignarNumero(tx, companyId, actual.serie, fechaEmision);
      // Solo se finaliza si sigue en borrador y sin cambios desde que se leyo (otra
      // peticion podria haberla emitido o modificado: moneda, lineas, tipo...).
      const r = await tx.incomeInvoice.updateMany({
        where: { id, companyId, estadoDocumento: ESTADO_BORRADOR, updatedAt: actual.updatedAt },
        data: {
          numero,
          numeroCompleto: `${actual.serie}-${numero}`,
          estadoDocumento: ESTADO_FINAL,
          finalizadaEn: new Date(),
          fechaEmision,
          fechaVencimiento,
          fechaOperacion,
          // Se conserva el del borrador (pantalla o copia); uno antiguo sin origen lo emite la pantalla.
          origen: actual.origen ?? 'pantalla',
          ...copia,
          estado: determinarEstado(fechaVencimiento),
          ...datosTipo(tipo),
          tipoOperacion: fiscal.tipoOperacion,
          causaExencion: fiscal.causaExencion,
          referenciaLegal: fiscal.referenciaLegal,
          // Rectificativa de una factura sin tipo: el pais de la original, congelado.
          ...(original && !fiscal.tipoOperacion && !actual.paisClienteLegacy ? { paisClienteLegacy: paisCongelado(original) } : {}),
          ...(importes ? cabecera(importes) : {}),
        },
      });
      if (r.count !== 1) {
        const ahora = await tx.incomeInvoice.findUnique({ where: { id }, select: { estadoDocumento: true } });
        throw badRequest(
          ahora?.estadoDocumento === ESTADO_FINAL ? 'La factura ya se había emitido.' : 'La factura ha cambiado mientras se emitía: vuelve a intentarlo.',
        );
      }
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
      if (rect) {
        await guardarEnlacesVenta(tx, companyId, id, rect.enlaces);
        await recalcularEstadoPartidas(tx, companyId, partidasDe(rect.enlaces));
        if (rect.forma === 'S') await recalcularEstadoCobroVenta(tx, companyId, id);
      }
      return tx.incomeInvoice.findUniqueOrThrow({ where: { id }, include: INCLUIR });
    }, rect ? AISLAMIENTO_RECTIFICATIVAS : undefined);
    const avisoIeepnr = avisoIeepnrFueraDeEspana(fiscal.tipoOperacion, lineas);
    const avisosFiscales = [
      ...(fiscal.avisos ?? []),
      ...(avisoIeepnr ? [avisoIeepnr] : []),
      ...(fuera && !avisoR4 ? [{ codigo: 'DEVENGO_FUERA_APP', mensaje: textoDevengoFuera(devengo, fuera) }] : []),
      ...(avisoR4 ? [avisoR4] : []),
      ...(cierre?.avisos ?? []),
    ];
    return respuesta(factura, { monedaCuenta: perfil.monedaCuenta, avisosFiscales, avisoTipoCambio: tipo.aviso });
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
    // Una factura del lector (o de una serie que ya no se usa) esta en una serie
    // desactivada: la copia va a la serie de facturas por defecto.
    let serie: string | undefined = o.serie;
    if (!esProforma && (o.origen === 'lector' || !(await buscarSeriePorCodigo(companyId, o.serie))?.activa)) serie = undefined;
    // Con envases o con descuento por linea, a una serie cuya plantilla lo
    // admita (la propia o la por defecto de su tipo; si no, la primera que valga;
    // si no hay, 400): ver serieCompatible. Las lineas pasan como cuerpo: el
    // IEEPNR se recalcula con el tipo de hoy.
    const necesita = necesidadPlantilla(o);
    if (necesita) {
      const preferida = serie ?? (esProforma ? null : await resolverCodSerieFactura(companyId, {}));
      serie = await serieCompatible(companyId, esProforma ? 'PROFORMA' : 'FACTURA', preferida, necesita);
    }
    return crear(
      {
        companyId,
        customer: { id: o.customerId },
        serie,
        fechaEmision: hoy,
        fechaVencimiento: sumarDias(hoy, plazo),
        tipoFactura: o.tipoFactura as TipoFactura,
        formaPago: o.formaPago as FormaPago,
        pesoBrutoKg: o.pesoBrutoKg,
        observaciones: o.observaciones ?? undefined,
        borrador: !esProforma,
        proforma: esProforma,
        moneda: o.moneda,
        tipoOperacion: o.tipoOperacion === 'EMPRESA_EXTRANJERA' ? null : o.tipoOperacion,
        causaExencion: o.causaExencion,
        referenciaLegal: o.referenciaLegal,
        lineas: lineasDocGuardadas(o).map(({ cuentaContable, ...l }) => ({ ...l, cuenta: cuentaContable ?? null, moneda: o.moneda })),
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
    const resp = await respuesta(f, { monedaCuenta: (await perfilEmpresa(companyId)).monedaCuenta });
    if (f.estadoDocumento === ESTADO_PROFORMA && f.estado === 'ACEPTADA') {
      const generada = await prisma.incomeInvoice.findFirst({ where: { companyId, proformaId: f.id }, select: { id: true } });
      if (generada) resp.facturaGeneradaId = generada.id;
    }
    if (f.estadoDocumento === ESTADO_FINAL) {
      const [rects, restante, asiento, cuentaCobro] = await Promise.all([
        // Las que la rectifican: por sus enlaces (tambien con varias originales) y por facturaOriginalId.
        rectificadaPorDe(companyId, f.id),
        restantePorOriginal(prisma, companyId, [f]),
        // El de la factura, no los de sus cobros (TESORERIA tambien lleva invoiceId).
        prisma.journalEntry.findFirst({
          where: { companyId, invoiceId: f.id, origen: { not: 'TESORERIA' }, estado: { in: ['POSTED', 'PENDING_REVIEW', 'DRAFT'] } },
          select: { id: true, numeroAsiento: true, estado: true },
        }),
        // Para la ventana de cobro: la cuenta del banco que sale en la factura.
        cuentaBancariaDeCobro(companyId, { ibanCobro: f.ibanCobro ?? null, moneda: f.moneda }),
      ]);
      resp.ibanCobro = f.ibanCobro ?? null;
      resp.cuentaBancariaCobroId = cuentaCobro;
      resp.rectificadaPor = rects;
      // Anulada entera: lo que queda por rectificar (la original o su sustituta, mas sus abonos) es cero.
      resp.anuladaPorCompleto = !f.esRectificativa && aCentimos(Number(f.totalFactura)) !== 0 && aCentimos(restante.get(f.id)?.total ?? 1) === 0;
      resp.asiento = asiento ? { id: asiento.id, numero: asiento.numeroAsiento ?? null, estado: String(asiento.estado) } : null;
      // Un abono: lo que no han absorbido sus originales y se puede devolver al cliente.
      if (f.esRectificativa && aCentimos(Number(f.totalFactura)) < 0) resp.aFavor = (await aFavorDeAbonos(prisma, companyId, [f.id])).get(f.id) ?? 0;
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
    comprobarHerencia(original, { moneda: opciones.moneda, tipoCambio: opciones.tipoCambio, tipoOperacion: opciones.tipoOperacion }, tipoRectificativa);

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
        cuenta: l.cuentaContable ?? null,
        // Plantilla A: los packs y los kg en negativo (el IEEPNR va en los importes espejo).
        packs: l.packs ?? null,
        kgPlastico: l.kgPlastico ?? null,
        textoAdicional: l.textoAdicional ?? null,
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
   * Importes en la moneda de cuenta. Una rectificativa por sustitucion (S) con
   * la original en la app lleva la factura corregida entera: cuenta solo su
   * diferencia con la original, como en el 303 y en el resumen fiscal.
   * OJO: filtra por la fecha de la factura (fechaEmision), no por el devengo
   * como el panel y el 303. Hoy ninguna pantalla lo usa.
   */
  async resumenPorPeriodo(companyId: string, desde?: string, hasta?: string) {
    const where: Prisma.IncomeInvoiceWhereInput = { companyId, estadoDocumento: ESTADO_FINAL };
    if (desde || hasta) {
      where.fechaEmision = { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) };
    }

    const filas = await prisma.incomeInvoice.findMany({
      where,
      select: {
        id: true,
        estado: true,
        esRectificativa: true,
        tipoRectificativa: true,
        facturaOriginalId: true,
        baseTotal: true,
        ivaTotal: true,
        retencionTotal: true,
        totalFactura: true,
      },
    });
    const diferencias = await diferenciasDeSustituciones(companyId, filas);
    const facturas = filas.map((f) => {
      const d = diferencias.get(f.id);
      return d ? { ...f, baseTotal: d.base, ivaTotal: d.cuota, retencionTotal: d.retencion, totalFactura: d.total } : f;
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
