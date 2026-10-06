import { prisma } from '../config/database';
import { aCentimos } from '../utils/money';
import { calcularPendiente, cobradoPorFactura, totalCobradoEntre } from './cobrosPagos.service';

/**
 * Resumen de cobros de clientes para el panel: lo que queda por cobrar (y lo
 * vencido), lo cobrado en el año y las próximas facturas a cobrar.
 *
 * Solo cuentan las facturas de venta emitidas (FINAL): los borradores y las
 * proformas no son facturas. Lo pendiente de cada factura sale de
 * calcularPendiente (cobrosPagos), igual que en la ficha de la factura y en el
 * mayor de clientes: total menos cobros activos, y una factura marcada como
 * cobrada a mano sin cobros registrados cuenta como cobrada entera.
 */

/** Factura de venta emitida, con lo justo para el resumen. */
export interface FacturaVentaCobro {
  id: string;
  numeroCompleto: string | null;
  cliente: string;
  fechaEmision: string;
  fechaVencimiento: string;
  totalFactura: number;
  estado: string;
  facturaOriginalId: string | null;
}

export interface FacturaPorCobrar {
  id: string;
  numeroCompleto: string | null;
  cliente: string;
  fechaEmision: string;
  fechaVencimiento: string;
  total: number;
  cobrado: number;
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
  /** Fecha con la que se ha calculado lo vencido (AAAA-MM-DD). */
  hoy: string;
  /** Todas las facturas con algo pendiente, de cualquier año. */
  pendientes: Cifra;
  /** Las pendientes cuyo vencimiento ya ha pasado. */
  vencidas: Cifra;
  /** Las pendientes que ya tienen algún cobro parcial. */
  parcialmenteCobradas: Cifra;
  /** Facturas emitidas en el año y cobradas enteras (importe: su total). */
  cobradas: Cifra;
  /** Suma de los cobros registrados con fecha en el año (sean de facturas de ese año o de antes). */
  cobradoEnElAnio: number;
  /** Hasta 8 facturas pendientes, primero las que vencen (o vencieron) antes. */
  proximas: FacturaPorCobrar[];
  criterio: Record<'pendientes' | 'vencidas' | 'cobradas' | 'cobradoEnElAnio' | 'rectificativas', string>;
}

export const CRITERIO_COBROS: ResumenCobrosClientes['criterio'] = {
  pendientes:
    'Facturas de venta emitidas (sin borradores ni proformas) de cualquier año con importe pendiente: total menos cobros activos, descontando sus rectificativas. Una deuda antigua sigue pendiente aunque se mire otro año.',
  vencidas: 'Pendientes cuyo vencimiento es anterior a hoy.',
  cobradas:
    'Facturas emitidas en el año elegido (por fecha de emisión) sin nada pendiente de sus propios cobros, incluidas las marcadas como cobradas a mano. El importe es su total.',
  cobradoEnElAnio:
    'Suma de los cobros registrados con fecha en el año elegido. No incluye las facturas marcadas como cobradas a mano sin registrar el cobro, porque no tienen fecha de cobro.',
  rectificativas:
    'Una rectificativa en negativo no es un cobro pendiente: resta de lo pendiente de la factura que rectifica mientras esta tenga algo por cobrar (sin bajar de cero). Si la original ya estaba cobrada, el abono se debe al cliente y no cuenta aquí. Las rectificativas en positivo se tratan como una factura más.',
};

const MAX_PROXIMAS = 8;
const DIA_MS = 86_400_000;
const hoyISO = (): string => new Date().toISOString().slice(0, 10);
const aEuros = (centimos: number): number => centimos / 100;

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / DIA_MS);
}

/**
 * Calcula el resumen a partir de las facturas emitidas y lo cobrado por factura
 * (cobros activos). Puro: sin BD ni reloj.
 */
export function resumirCobrosClientes(
  facturas: FacturaVentaCobro[],
  cobradoPorId: Map<string, number>,
  opciones: { anio: number; hoy: string; cobradoEnElAnio: number },
): ResumenCobrosClientes {
  const pendientePropio = (f: FacturaVentaCobro) => calcularPendiente('INGRESO', f.totalFactura, f.estado, cobradoPorId.get(f.id) ?? 0);

  // Rectificativas en negativo: lo que les queda (en centimos, negativo) se
  // descuenta de la factura original.
  const abonosPorOriginal = new Map<string, number>();
  for (const f of facturas) {
    if (aCentimos(f.totalFactura) >= 0 || !f.facturaOriginalId) continue;
    const abono = aCentimos(pendientePropio(f));
    if (abono < 0) abonosPorOriginal.set(f.facturaOriginalId, (abonosPorOriginal.get(f.facturaOriginalId) ?? 0) + abono);
  }

  const prefijoAnio = `${opciones.anio}-`;
  const pendientes: FacturaPorCobrar[] = [];
  const cobradas = { numero: 0, centimos: 0 };

  for (const f of facturas) {
    const total = aCentimos(f.totalFactura);
    if (total <= 0) continue; // rectificativas en negativo (ya aplicadas) y facturas a cero
    const cobrado = cobradoPorId.get(f.id) ?? 0;
    const propio = aCentimos(pendientePropio(f));
    const pendiente = Math.max(0, propio + (abonosPorOriginal.get(f.id) ?? 0));

    if (pendiente > 0) {
      const diasRetraso = Math.max(0, diasEntre(f.fechaVencimiento, opciones.hoy));
      pendientes.push({
        id: f.id,
        numeroCompleto: f.numeroCompleto,
        cliente: f.cliente,
        fechaEmision: f.fechaEmision,
        fechaVencimiento: f.fechaVencimiento,
        total: aEuros(total),
        cobrado,
        pendiente: aEuros(pendiente),
        vencida: f.fechaVencimiento < opciones.hoy,
        diasRetraso,
      });
    } else if (propio <= 0 && f.fechaEmision.startsWith(prefijoAnio)) {
      // Cobrada por sus propios cobros (no anulada por una rectificativa).
      cobradas.numero++;
      cobradas.centimos += total;
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
    .slice(0, MAX_PROXIMAS);

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

/** Resumen de cobros de clientes de la empresa para el año indicado. */
export async function resumenCobrosClientes(companyId: string, anio: number, hoy: string = hoyISO()): Promise<ResumenCobrosClientes> {
  const [filas, cobrado, cobradoEnElAnio] = await Promise.all([
    prisma.incomeInvoice.findMany({
      where: { companyId, estadoDocumento: 'FINAL' },
      select: {
        id: true,
        numeroCompleto: true,
        fechaEmision: true,
        fechaVencimiento: true,
        totalFactura: true,
        estado: true,
        facturaOriginalId: true,
        customer: { select: { nombreFiscal: true } },
      },
    }),
    cobradoPorFactura(companyId, 'INGRESO'),
    totalCobradoEntre(companyId, 'INGRESO', `${anio}-01-01`, `${anio}-12-31`),
  ]);
  const facturas: FacturaVentaCobro[] = filas.map(({ customer, ...f }) => ({
    ...f,
    totalFactura: Number(f.totalFactura),
    cliente: customer.nombreFiscal,
  }));
  return resumirCobrosClientes(facturas, cobrado, { anio, hoy, cobradoEnElAnio });
}
