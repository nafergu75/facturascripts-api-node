/**
 * Facturas de gasto (ExpenseInvoice): reglas puras que comparten el alta, la
 * edicion y la anulacion, el listado y los modelos fiscales (303, 390, 347,
 * 349, 111, 115 y 190). Sin acceso a la BD.
 *
 * Los importes se suman en centimos (utils/money), como en nominas/fiscal.ts.
 */
import type { Prisma } from '@prisma/client';
import { aCentimos } from '../utils/money';

export const TIPOS_GASTO = ['COMPRA', 'SERVICIO_PROFESIONAL', 'ALQUILER', 'SUMINISTROS'] as const;
export type TipoGasto = (typeof TIPOS_GASTO)[number];

export const esTipoGasto = (v: unknown): v is TipoGasto => typeof v === 'string' && (TIPOS_GASTO as readonly string[]).includes(v);

/** Etiqueta en pantalla, cuenta de gasto por defecto, cuenta del acreedor y retenciones admitidas. */
export const TIPO_GASTO_INFO: Record<TipoGasto, { texto: string; cuenta: string; acreedor: '400' | '410'; retenciones: number[] }> = {
  COMPRA: { texto: 'Compras de mercaderías', cuenta: '600', acreedor: '400', retenciones: [0] },
  SERVICIO_PROFESIONAL: { texto: 'Profesionales independientes', cuenta: '623', acreedor: '410', retenciones: [0, 1, 2, 7, 15, 19] },
  ALQUILER: { texto: 'Alquileres', cuenta: '621', acreedor: '410', retenciones: [0, 19] },
  SUMINISTROS: { texto: 'Suministros y otros servicios', cuenta: '628', acreedor: '410', retenciones: [0] },
};

/** Tipos de IVA que admite una factura de gasto. */
export const TIPOS_IVA_GASTO = [0, 4, 5, 10, 21] as const;

/** Estados de las facturas anteriores al alta con asiento: se pueden contabilizar con el boton. */
export const ESTADOS_SIN_CONTABILIZAR = ['PENDING', 'OVERDUE', 'CONFIRMED'];

/** Texto del estado de la factura (no el de pago). */
export function textoEstadoGasto(estado: string): string {
  if (estado === 'DRAFT') return 'Pendiente de revisar';
  if (estado === 'ACCOUNTED') return 'Contabilizada';
  if (estado === 'ANULADA') return 'Anulada';
  return 'Sin contabilizar';
}

/** Texto del estado de pago. Una factura vencida sin pagar del todo sale como «Vencida». */
export function textoEstadoPago(estadoPago: string, vencida: boolean): string {
  if (estadoPago === 'PAGADA') return 'Pagada';
  if (vencida) return 'Vencida';
  if (estadoPago === 'PARCIAL') return 'Pagada en parte';
  return 'Pendiente de pago';
}

export const esVencida = (f: { estado: string; estadoPago: string; fechaVencimiento: string }, hoy: string): boolean =>
  f.estado !== 'ANULADA' && f.estadoPago !== 'PAGADA' && f.fechaVencimiento < hoy;

/** Filtro de "vigentes" para resumenes no fiscales: ni borradores del lector ni anuladas. */
export const GASTO_VIGENTE: { estado: { notIn: string[] } } = { estado: { notIn: ['DRAFT', 'ANULADA'] } };

/** Fecha del asiento, del libro de IVA y de los modelos: la de registro si la hay. */
export const fechaContableGasto = (f: { fechaEmision: string; fechaRegistro?: string | null }): string => f.fechaRegistro || f.fechaEmision;

/** Numero del proveedor normalizado para el indice unico: mayusculas y sin espacios. */
export const normalizarNumeroProveedor = (s: string): string => s.trim().toUpperCase().replace(/\s+/g, '');

/** Tipo de retencion del libro de retenciones segun el tipo de gasto. */
export const tipoRetencionLibro = (tipoGasto: string): 'ARRENDAMIENTO' | 'PROFESIONAL' => (tipoGasto === 'ALQUILER' ? 'ARRENDAMIENTO' : 'PROFESIONAL');

/** Tipo de gasto que corresponde a la cuenta sugerida por el lector. */
export function tipoGastoDeCuenta(cuenta: string | null | undefined): TipoGasto {
  const c = String(cuenta ?? '');
  if (c.startsWith('621')) return 'ALQUILER';
  if (c.startsWith('623')) return 'SERVICIO_PROFESIONAL';
  if (c.startsWith('600')) return 'COMPRA';
  return 'SUMINISTROS';
}

export interface DatosFiscalesGasto {
  estado: string;
  fechaEmision: string;
  fechaRegistro?: string | null;
  anuladaEn?: string | null;
  anulacionAsientoId?: string | null;
}

/**
 * Donde y con que signo cuenta una factura de gasto en los modelos:
 *  - DRAFT (del lector, asiento sin aprobar): no cuenta.
 *  - ANULADA sin contraasiento (se anulo con el periodo abierto): no cuenta.
 *  - ANULADA con contraasiento: suma en su periodo y resta en el de la anulacion.
 *  - El resto (contabilizadas y anteriores sin contabilizar): en su fecha contable.
 */
export function aparicionesFiscales(f: DatosFiscalesGasto): Array<{ fecha: string; signo: 1 | -1 }> {
  if (f.estado === 'DRAFT') return [];
  const contable = fechaContableGasto(f);
  if (f.estado === 'ANULADA') {
    if (!f.anulacionAsientoId || !f.anuladaEn) return [];
    return [
      { fecha: contable, signo: 1 },
      { fecha: f.anuladaEn, signo: -1 },
    ];
  }
  return [{ fecha: contable, signo: 1 }];
}

/** Las apariciones de una factura con fecha entre `desde` y `hasta` (ambas incluidas). */
export const aparicionesEntre = (f: DatosFiscalesGasto, desde: string, hasta: string) =>
  aparicionesFiscales(f).filter((a) => a.fecha >= desde && a.fecha <= hasta);

/**
 * Donde cuenta una factura de gasto en los modelos de RETENCIONES (111, 115 y
 * 190). Estos no admiten casillas negativas ni compensan con otro periodo:
 * una anulada nunca resta. Si su retencion ya se declaro (el 111 o el 115 de
 * su periodo esta presentado) se queda en ese periodo, que habra que
 * rectificar si no se llego a pagar; si no, no cuenta en ninguno.
 */
export function aparicionesRetencionEntre(
  f: DatosFiscalesGasto,
  desde: string,
  hasta: string,
  retencionDeclarada: boolean,
): Array<{ fecha: string; signo: 1 }> {
  if (f.estado === 'ANULADA') {
    const contable = fechaContableGasto(f);
    return retencionDeclarada && f.anulacionAsientoId && contable >= desde && contable <= hasta ? [{ fecha: contable, signo: 1 }] : [];
  }
  return aparicionesEntre(f, desde, hasta).map((a) => ({ fecha: a.fecha, signo: 1 as const }));
}

/** Periodos en que se puede haber presentado el modelo de una fecha: su trimestre y su mes. */
export const periodosDeFecha = (fecha: string): string[] => [`${Math.ceil(Number(fecha.slice(5, 7)) / 3)}T`, fecha.slice(5, 7)];

/**
 * where de Prisma con las facturas que PUEDEN aparecer entre `desde` y `hasta`.
 * Despues se filtra con aparicionesFiscales (o aparicionesEntre).
 */
export function whereGastosFiscales(companyId: string, desde: string, hasta: string): Prisma.ExpenseInvoiceWhereInput {
  const rango = { gte: desde, lte: hasta };
  const porFechaContable: Prisma.ExpenseInvoiceWhereInput[] = [{ fechaRegistro: rango }, { fechaRegistro: null, fechaEmision: rango }];
  return {
    companyId,
    OR: [
      { estado: { notIn: ['DRAFT', 'ANULADA'] }, OR: porFechaContable },
      { estado: 'ANULADA', anulacionAsientoId: { not: null }, OR: [...porFechaContable, { anuladaEn: rango }] },
    ],
  };
}

const euros = (centimos: number) => Math.round(centimos) / 100;

/**
 * Importe con IVA de una factura de gasto que va al 347: sin las lineas con
 * retencion de IRPF (profesionales y alquileres), que ya se declaran en el 190
 * y en el 180 (art. 33.2 del RD 1065/2007). Sin lineas, toda la factura o nada.
 */
export function importe347Gasto(f: {
  baseTotal: number;
  ivaTotal: number;
  retencionTotal: number;
  lineas?: Array<{ tipoRetencion: number; baseLine: number; ivaImporte: number }>;
}): number {
  const lineas = f.lineas ?? [];
  if (!lineas.length) return aCentimos(Number(f.retencionTotal) || 0) > 0 ? 0 : euros(aCentimos(Number(f.baseTotal) || 0) + aCentimos(Number(f.ivaTotal) || 0));
  return euros(
    lineas.filter((l) => !(Number(l.tipoRetencion) > 0)).reduce((a, l) => a + aCentimos(Number(l.baseLine) || 0) + aCentimos(Number(l.ivaImporte) || 0), 0),
  );
}

/**
 * Base sujeta a retencion y cuota por porcentaje, a partir de las lineas. Sin
 * lineas, o si las lineas no cuadran con la cabecera (facturas antiguas), la
 * cabecera: el porcentaje guardado o, si es 0, el que resulta de la cuota.
 */
export function desgloseRetencionGasto(f: {
  baseTotal: number;
  retencionTotal: number;
  tipoRetencion?: number | null;
  lineas?: Array<{ tipoRetencion: number; baseLine: number; retencionImporte: number }>;
}): Array<{ porcentaje: number; base: number; cuota: number }> {
  const total = aCentimos(Number(f.retencionTotal) || 0);
  if (total === 0) return [];
  const lineas = (f.lineas ?? []).filter((l) => Number(l.tipoRetencion) > 0);
  const deLineas = lineas.reduce((a, l) => a + aCentimos(Number(l.retencionImporte) || 0), 0);
  if (lineas.length && deLineas === total) {
    const grupos = new Map<number, { base: number; cuota: number }>();
    for (const l of lineas) {
      const g = grupos.get(Number(l.tipoRetencion)) ?? { base: 0, cuota: 0 };
      g.base += aCentimos(Number(l.baseLine) || 0);
      g.cuota += aCentimos(Number(l.retencionImporte) || 0);
      grupos.set(Number(l.tipoRetencion), g);
    }
    return [...grupos]
      .sort((a, b) => b[0] - a[0])
      .map(([porcentaje, g]) => ({ porcentaje, base: euros(g.base), cuota: euros(g.cuota) }));
  }
  const base = Number(f.baseTotal) || 0;
  const porcentaje = Number(f.tipoRetencion) > 0 ? Number(f.tipoRetencion) : base ? Math.round((euros(total) / base) * 100) : 0;
  return [{ porcentaje, base: euros(aCentimos(base)), cuota: euros(total) }];
}

/**
 * Tipos de cabecera de la factura: el IVA de la mayor base y la retencion de
 * la mayor base con retencion (0 si no hay). Antes se quedaban en 21 y 0 por
 * defecto y el 111 salia como «Profesionales (0 %)».
 */
export function cabeceraTipos(lineas: Array<{ tipoIva: number; tipoRetencion: number; baseLine: number }>): { tipoIva: number; tipoRetencion: number } {
  const mayor = (filtro: (l: { tipoRetencion: number }) => boolean, campo: 'tipoIva' | 'tipoRetencion') => {
    const bases = new Map<number, number>();
    for (const l of lineas.filter(filtro)) bases.set(l[campo], (bases.get(l[campo]) ?? 0) + aCentimos(Math.abs(l.baseLine)));
    let mejor: number | null = null;
    let mejorBase = -1;
    for (const [tipo, base] of bases) {
      if (base > mejorBase) {
        mejor = tipo;
        mejorBase = base;
      }
    }
    return mejor;
  };
  return {
    tipoIva: mayor(() => true, 'tipoIva') ?? 21,
    tipoRetencion: mayor((l) => l.tipoRetencion > 0, 'tipoRetencion') ?? 0,
  };
}
