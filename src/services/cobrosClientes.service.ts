import { prisma } from '../config/database';
import { aCentimos } from '../utils/money';
import { hoyEspana } from '../utils/fechas';
import { calcularPendiente, cobradoPorFactura, totalCobradoEntre } from './cobrosPagos.service';

/**
 * Resumen de cobros de clientes para el panel: lo que queda por cobrar (y lo
 * vencido), lo cobrado en el año y las próximas facturas a cobrar.
 *
 * Solo cuentan las facturas de venta emitidas: estadoDocumento FINAL y sin el
 * estado 'DRAFT', porque antes del 06-10-2026 un borrador era estado 'DRAFT' y
 * al crear estadoDocumento quedó como FINAL (igual que en los movimientos y los
 * impuestos). Los borradores y las proformas no son facturas. Lo pendiente de
 * cada factura sale de calcularPendiente (cobrosPagos), igual que en la ficha
 * de la factura y en el mayor de clientes: total menos cobros activos, y una
 * factura marcada como cobrada a mano sin cobros registrados cuenta como
 * cobrada entera. Todo a fecha de hoy (hora peninsular): un cobro con fecha
 * posterior todavía no ha entrado.
 */

/** Factura de venta emitida, con lo justo para el resumen. */
export interface FacturaVentaCobro {
  id: string;
  numeroCompleto: string | null;
  cliente: string;
  customerId?: string;
  fechaEmision: string;
  fechaVencimiento: string;
  totalFactura: number;
  estado: string;
  facturaOriginalId: string | null;
  /** Solo rectificativas: 'S' (por sustitución) o 'I' (por diferencias). */
  tipoRectificativa?: string | null;
}

export interface FacturaPorCobrar {
  id: string;
  numeroCompleto: string | null;
  cliente: string;
  customerId?: string;
  fechaEmision: string;
  fechaVencimiento: string;
  total: number;
  /** Cobrado hasta hoy (más lo cobrado a la factura que sustituye, si es una rectificativa por sustitución). */
  cobrado: number;
  /** Lo que restan sus rectificativas en negativo. total - cobrado - abonado = pendiente. */
  abonado: number;
  pendiente: number;
  vencida: boolean;
  /** Días desde el vencimiento (0 si no ha vencido). */
  diasRetraso: number;
}

export interface Cifra {
  numero: number;
  importe: number;
}

export interface ResumenCobrosClientes {
  anio: number;
  /** Fecha con la que se ha calculado lo pendiente y lo vencido (AAAA-MM-DD, hora peninsular). */
  hoy: string;
  /** Todas las facturas con algo pendiente, de cualquier año. */
  pendientes: Cifra;
  /** Las pendientes cuyo vencimiento ya ha pasado. */
  vencidas: Cifra;
  /** Las pendientes que ya tienen algún cobro parcial. */
  parcialmenteCobradas: Cifra;
  /** Facturas emitidas en el año y cobradas enteras (importe: lo neto tras sus rectificativas). */
  cobradas: Cifra;
  /** Suma de los cobros registrados con fecha en el año, hasta hoy (sean de facturas de ese año o de antes). */
  cobradoEnElAnio: number;
  /** Hasta 8 facturas pendientes, primero las que vencen (o vencieron) antes. */
  proximas: FacturaPorCobrar[];
  criterio: Record<'pendientes' | 'vencidas' | 'cobradas' | 'cobradoEnElAnio' | 'rectificativas', string>;
}

export const CRITERIO_COBROS: ResumenCobrosClientes['criterio'] = {
  pendientes:
    'Facturas de venta emitidas (sin borradores ni proformas) de cualquier año con importe pendiente a fecha de hoy: total menos los cobros activos, descontando sus rectificativas. Un cobro con fecha posterior a hoy no resta hasta que llega esa fecha. Una deuda antigua sigue pendiente aunque se mire otro año.',
  vencidas: 'Pendientes cuyo vencimiento es anterior a hoy (hora peninsular).',
  cobradas:
    'Facturas emitidas en el año elegido (por fecha de emisión) sin nada pendiente a fecha de hoy, incluidas las marcadas como cobradas a mano. El importe es lo neto tras sus rectificativas (total menos abonos). Una factura anulada entera por una rectificativa no cuenta.',
  cobradoEnElAnio:
    'Suma de los cobros registrados con fecha en el año elegido, hasta hoy. No incluye las facturas marcadas como cobradas a mano sin registrar el cobro, porque no tienen fecha de cobro.',
  rectificativas:
    'Una rectificativa en negativo no es un cobro pendiente: resta de lo pendiente de la factura que rectifica mientras esta tenga algo por cobrar (sin bajar de cero). Si la original ya estaba cobrada, el abono se debe al cliente y no cuenta como pendiente. Una rectificativa por sustitución (tipo S) ocupa el lugar de la original: la original deja de contar y lo que se le cobró se descuenta de la sustituta. Las rectificativas en positivo por diferencias se tratan como una factura más.',
};

const MAX_PROXIMAS = 8;
const DIA_MS = 86_400_000;
const aEuros = (centimos: number): number => centimos / 100;

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
}

function sumarEn(mapa: Map<string, number>, id: string, centimos: number): void {
  mapa.set(id, (mapa.get(id) ?? 0) + centimos);
}

/**
 * Calcula el resumen a partir de las facturas emitidas y lo cobrado por factura
 * (cobros activos). Puro: sin BD ni reloj.
 *
 * `cobradoPorId` son todos los cobros activos y `opciones.cobradoHastaHoy` los
 * que tienen fecha hasta hoy (por defecto, todos). Lo pendiente se calcula con
 * los de hasta hoy; el resto solo sirve para no tomar por "cobrada a mano" una
 * factura cuyo cobro tiene fecha futura.
 */
export function resumirCobrosClientes(
  facturas: FacturaVentaCobro[],
  cobradoPorId: Map<string, number>,
  opciones: { anio: number; hoy: string; cobradoEnElAnio: number; cobradoHastaHoy?: Map<string, number>; maxProximas?: number },
): ResumenCobrosClientes {
  const hastaHoy = opciones.cobradoHastaHoy ?? cobradoPorId;
  /** Pendiente propio en céntimos (sin contar rectificativas), con la regla de cobrosPagos. */
  const pendientePropio = (f: FacturaVentaCobro) =>
    aCentimos(calcularPendiente('INGRESO', f.totalFactura, f.estado, cobradoPorId.get(f.id) ?? 0, hastaHoy.get(f.id) ?? 0));

  // Rectificativas por sustitución: la original deja de contar y cuenta la
  // sustituta. Si una original tiene varias, la última emitida.
  const existe = new Set(facturas.map((f) => f.id));
  const sustituta = new Map<string, string>();
  const emisionSustituta = new Map<string, string>();
  for (const f of facturas) {
    const original = f.facturaOriginalId;
    if (f.tipoRectificativa !== 'S' || !original || original === f.id || !existe.has(original)) continue;
    const previa = emisionSustituta.get(original);
    if (previa === undefined || previa <= f.fechaEmision) {
      sustituta.set(original, f.id);
      emisionSustituta.set(original, f.fechaEmision);
    }
  }
  /** La factura que cuenta en lugar de `id`: la última de su cadena de sustituciones. */
  const vigente = (id: string): string => {
    const vistas = new Set<string>();
    let actual = id;
    while (sustituta.has(actual) && !vistas.has(actual)) {
      vistas.add(actual);
      actual = sustituta.get(actual)!;
    }
    return actual;
  };

  // Lo cobrado a una factura sustituida (también lo cobrado a mano) se
  // descuenta de la que la sustituye.
  const traspasado = new Map<string, number>();
  for (const f of facturas) {
    if (!sustituta.has(f.id)) continue;
    const cobrado = aCentimos(f.totalFactura) - pendientePropio(f);
    if (cobrado > 0) sumarEn(traspasado, vigente(f.id), cobrado);
  }

  // Rectificativas en negativo por diferencias: lo que les queda (en céntimos,
  // negativo) se descuenta de la factura que rectifican.
  const abonos = new Map<string, number>();
  for (const f of facturas) {
    if (aCentimos(f.totalFactura) >= 0 || !f.facturaOriginalId || f.tipoRectificativa === 'S' || sustituta.has(f.id)) continue;
    const abono = pendientePropio(f);
    if (abono < 0) sumarEn(abonos, vigente(f.facturaOriginalId), abono);
  }

  const prefijoAnio = `${opciones.anio}-`;
  const pendientes: FacturaPorCobrar[] = [];
  const cobradas = { numero: 0, centimos: 0 };

  for (const f of facturas) {
    const total = aCentimos(f.totalFactura);
    // Fuera: rectificativas en negativo (ya aplicadas), facturas a cero y facturas sustituidas.
    if (total <= 0 || sustituta.has(f.id)) continue;
    const traspaso = traspasado.get(f.id) ?? 0;
    const abono = abonos.get(f.id) ?? 0;
    const pendiente = Math.max(0, pendientePropio(f) - traspaso + abono);
    const neto = total + abono;

    if (pendiente > 0) {
      pendientes.push({
        id: f.id,
        numeroCompleto: f.numeroCompleto,
        cliente: f.cliente,
        ...(f.customerId ? { customerId: f.customerId } : {}),
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        total: aEuros(total),
        cobrado: aEuros(aCentimos(hastaHoy.get(f.id) ?? 0) + traspaso),
        abonado: abono === 0 ? 0 : aEuros(-abono),
        pendiente: aEuros(pendiente),
        vencida: f.fechaVencimiento < opciones.hoy,
        diasRetraso: Math.max(0, diasEntre(f.fechaVencimiento, opciones.hoy)),
      });
    } else if (neto > 0 && f.fechaEmision.startsWith(prefijoAnio)) {
      // Cobrada del todo: por sus cobros, a mano, o lo que quedaba tras una rectificativa.
      cobradas.numero++;
      cobradas.centimos += neto;
    }
  }

  const suma = (lista: FacturaPorCobrar[]): Cifra => ({
    numero: lista.length,
    importe: aEuros(lista.reduce((s, f) => s + aCentimos(f.pendiente), 0)),
  });

  const proximas = [...pendientes]
    .sort(
      (a, b) =>
        a.fechaVencimiento.localeCompare(b.fechaVencimiento) ||
        a.fechaEmision.localeCompare(b.fechaEmision) ||
        (a.numeroCompleto ?? '').localeCompare(b.numeroCompleto ?? '', 'es', { numeric: true }),
    )
    .slice(0, opciones.maxProximas ?? MAX_PROXIMAS);

  return {
    anio: opciones.anio,
    hoy: opciones.hoy,
    pendientes: suma(pendientes),
    vencidas: suma(pendientes.filter((f) => f.vencida)),
    parcialmenteCobradas: suma(pendientes.filter((f) => aCentimos(f.cobrado) > 0)),
    cobradas: { numero: cobradas.numero, importe: aEuros(cobradas.centimos) },
    cobradoEnElAnio: aEuros(aCentimos(opciones.cobradoEnElAnio)),
    proximas,
    criterio: CRITERIO_COBROS,
  };
}

/** Facturas de venta emitidas de la empresa (sin borradores ni proformas), con su cliente. */
async function facturasEmitidas(companyId: string): Promise<FacturaVentaCobro[]> {
  const filas = await prisma.incomeInvoice.findMany({
    // estado DRAFT: borradores de antes de estadoDocumento, que quedaron como FINAL.
    where: { companyId, estadoDocumento: 'FINAL', estado: { not: 'DRAFT' } },
    select: {
      id: true,
      numeroCompleto: true,
      fechaEmision: true,
      fechaVencimiento: true,
      totalFactura: true,
      estado: true,
      facturaOriginalId: true,
      tipoRectificativa: true,
      customerId: true,
      customer: { select: { nombreFiscal: true } },
    },
  });
  return filas.map(({ customer, ...f }) => ({
    ...f,
    totalFactura: Number(f.totalFactura),
    cliente: customer.nombreFiscal,
  }));
}

/** Resumen de cobros de clientes de la empresa para el año indicado, a fecha de `hoy`. */
export async function resumenCobrosClientes(companyId: string, anio: number, hoy: string = hoyEspana()): Promise<ResumenCobrosClientes> {
  const finAnio = `${anio}-12-31`;
  const [facturas, cobrado, cobradoHastaHoy, cobradoEnElAnio] = await Promise.all([
    facturasEmitidas(companyId),
    cobradoPorFactura(companyId, 'INGRESO'),
    cobradoPorFactura(companyId, 'INGRESO', hoy),
    totalCobradoEntre(companyId, 'INGRESO', `${anio}-01-01`, finAnio < hoy ? finAnio : hoy),
  ]);
  // El resumen del panel no lleva el id del cliente (su respuesta no cambia).
  const sinCliente = facturas.map(({ customerId: _customerId, ...f }) => f);
  return resumirCobrosClientes(sinCliente, cobrado, { anio, hoy, cobradoEnElAnio, cobradoHastaHoy });
}

export interface FacturasPorCobrar {
  hoy: string;
  /** Todas las facturas con algo pendiente, de cualquier año, primero las que vencen (o vencieron) antes. */
  facturas: FacturaPorCobrar[];
  pendientes: Cifra;
  vencidas: Cifra;
}

/**
 * Lista completa de facturas de venta pendientes de cobro a fecha de `hoy`, con
 * las mismas reglas que el resumen del panel (rectificativas, cobros con fecha
 * futura, cobradas a mano). Solo lectura. La usa Carmen.
 */
export async function facturasPorCobrar(companyId: string, hoy: string = hoyEspana()): Promise<FacturasPorCobrar> {
  const [facturas, cobrado, cobradoHastaHoy] = await Promise.all([
    facturasEmitidas(companyId),
    cobradoPorFactura(companyId, 'INGRESO'),
    cobradoPorFactura(companyId, 'INGRESO', hoy),
  ]);
  const r = resumirCobrosClientes(facturas, cobrado, {
    anio: Number(hoy.slice(0, 4)),
    hoy,
    cobradoEnElAnio: 0,
    cobradoHastaHoy,
    maxProximas: Number.POSITIVE_INFINITY,
  });
  return { hoy, facturas: r.proximas, pendientes: r.pendientes, vencidas: r.vencidas };
}
