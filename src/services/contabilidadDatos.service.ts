import { prisma } from '../config/database';

/** Linea (apunte) simplificada de un asiento. */
export interface LineaAsientoSimple {
  subcuenta: string;
  debe: number;
  haber: number;
}

/**
 * Clase de asiento para los estados financieros. Los de regularizacion y cierre
 * dejan a cero las cuentas al final del año: si se suman como uno normal, la
 * PyG y el balance de un ejercicio cerrado salen a cero.
 */
export type TipoAsiento = 'NORMAL' | 'APERTURA' | 'REGULARIZACION' | 'CIERRE';

/** Asiento simplificado para los estados financieros. */
export interface AsientoSimple {
  idasiento?: number | string;
  fecha: string; // yyyy-mm-dd
  numero: string | number;
  concepto: string;
  tipo?: TipoAsiento;
  lineas: LineaAsientoSimple[];
}

/**
 * Tipo de un asiento por su origen o, en los creados antes de guardar el origen
 * (el cierre los guardaba como AJUSTE_MANUAL), por su concepto.
 */
export function tipoAsiento(origen: string | null | undefined, concepto: string | null | undefined): TipoAsiento {
  const o = (origen ?? '').toUpperCase();
  const c = (concepto ?? '').trim().toLowerCase();
  if (o === 'APERTURA' || c.startsWith('apertura ejercicio')) return 'APERTURA';
  if (o === 'REGULARIZACION' || c.startsWith('regularizacion ejercicio') || c.startsWith('regularización ejercicio')) return 'REGULARIZACION';
  if (o === 'CIERRE' || o === 'CIERRE_AUTOMATICO' || c.startsWith('cierre ejercicio') || c.startsWith('cierre contable')) return 'CIERRE';
  return 'NORMAL';
}

/** Saldo acumulado de una subcuenta. saldoDeudor = debe - haber. */
export interface SaldoSubcuenta {
  subcuenta: string;
  debe: number;
  haber: number;
  saldoDeudor: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Obtiene los asientos POSTED del ejercicio desde la BD propia (Prisma
 * `JournalEntry`/`JournalEntryLine`), el spine contable canónico. ANTES leía de
 * FacturaScripts; migrado en ADR-002 Paso 3 para que los estados financieros y
 * los modelos AEAT funcionen sin FacturaScripts levantado.
 *
 * Solo cuenta asientos en estado POSTED (definitivos), igual que /reports: los
 * borradores (DRAFT/PENDING_REVIEW) y los anulados (REVERSED) no entran en los
 * estados oficiales. El ejercicio se filtra por el año natural de `fecha`.
 *
 * Resiliencia: si `prisma.journalEntry` no está disponible (p.ej. tests con
 * prisma mockeado), devuelve []. Mantiene la firma `(companyId, ejercicio)`,
 * así que ningún consumidor cambia (cuentas anuales, IS, cierre, cuadre,
 * conciliación, extractos, export, IVA-desde-asientos).
 */
export async function obtenerAsientosEjercicio(companyId: string, ejercicio: number): Promise<AsientoSimple[]> {
  if (typeof (prisma as { journalEntry?: { findMany?: unknown } })?.journalEntry?.findMany !== 'function') {
    return [];
  }

  const desde = new Date(Date.UTC(ejercicio, 0, 1));
  const hasta = new Date(Date.UTC(ejercicio + 1, 0, 1));
  return leerAsientos({ companyId, estado: 'POSTED', fecha: { gte: desde, lt: hasta } });
}

/**
 * Todos los asientos POSTED hasta el final del ejercicio (incluidos los de años
 * anteriores). Las cuentas de balance arrastran saldo de un año a otro, asi que
 * el balance no se puede sacar solo con los asientos del año si no hay asiento
 * de apertura.
 */
export async function obtenerAsientosHastaFinDe(companyId: string, ejercicio: number): Promise<AsientoSimple[]> {
  if (typeof (prisma as { journalEntry?: { findMany?: unknown } })?.journalEntry?.findMany !== 'function') {
    return [];
  }
  const hasta = new Date(Date.UTC(ejercicio + 1, 0, 1));
  return leerAsientos({ companyId, estado: 'POSTED', fecha: { lt: hasta } });
}

async function leerAsientos(where: Record<string, unknown>): Promise<AsientoSimple[]> {
  const entries = await prisma.journalEntry.findMany({
    where,
    include: { lineas: true },
    orderBy: { fecha: 'asc' },
  });

  return entries.map((a) => ({
    idasiento: a.id,
    fecha: a.fecha.toISOString().slice(0, 10),
    numero: a.numeroAsiento,
    concepto: a.descripcion,
    tipo: tipoAsiento((a as { origen?: string | null }).origen, a.descripcion),
    lineas: a.lineas.map((l) => ({
      subcuenta: l.accountCode,
      debe: Number(l.debe ?? 0),
      haber: Number(l.haber ?? 0),
    })),
  }));
}

export interface SaldosEjercicio {
  /** Saldo deudor acumulado de cada cuenta de balance (grupos 1-5) al cierre. */
  balance: Map<string, number>;
  /** Saldo deudor de cada cuenta 6/7 por los asientos del ejercicio. */
  pyg: Map<string, number>;
  /** Resultado (haber - debe de 6/7) de años anteriores que no se regularizo. */
  resultadoAnteriores: number;
}

/**
 * Saldos para los estados financieros de un ejercicio a partir de los asientos
 * hasta su cierre. Sin regularizacion ni cierre (ver TipoAsiento). Si hay un
 * asiento de apertura, se parte de el (ya trae los saldos anteriores); si no,
 * se acumula desde el primer asiento.
 */
export function saldosDelEjercicio(asientos: AsientoSimple[], ejercicio: number): SaldosEjercicio {
  const fin = `${ejercicio}-12-31`;
  const validos = asientos.filter((a) => a.fecha <= fin && a.tipo !== 'REGULARIZACION' && a.tipo !== 'CIERRE');
  const inicio = validos.filter((a) => a.tipo === 'APERTURA').reduce((m, a) => (a.fecha > m ? a.fecha : m), '');
  const anioIni = `${ejercicio}-01-01`;

  const balance = new Map<string, number>();
  const pyg = new Map<string, number>();
  let resultadoAnteriores = 0;
  for (const a of validos) {
    if (inicio && a.fecha < inicio) continue;
    for (const l of a.lineas) {
      const deudor = l.debe - l.haber;
      if (l.subcuenta.startsWith('6') || l.subcuenta.startsWith('7')) {
        if (a.fecha >= anioIni) pyg.set(l.subcuenta, round2((pyg.get(l.subcuenta) ?? 0) + deudor));
        else resultadoAnteriores = round2(resultadoAnteriores - deudor);
      } else {
        balance.set(l.subcuenta, round2((balance.get(l.subcuenta) ?? 0) + deudor));
      }
    }
  }
  return { balance, pyg, resultadoAnteriores };
}

/** Acumula saldos por subcuenta a partir de los asientos. */
export function calcularSaldosPorSubcuenta(asientos: AsientoSimple[]): Map<string, SaldoSubcuenta> {
  const mapa = new Map<string, SaldoSubcuenta>();
  for (const a of asientos) {
    for (const l of a.lineas) {
      const s = mapa.get(l.subcuenta) ?? { subcuenta: l.subcuenta, debe: 0, haber: 0, saldoDeudor: 0 };
      s.debe = round2(s.debe + l.debe);
      s.haber = round2(s.haber + l.haber);
      s.saldoDeudor = round2(s.debe - s.haber);
      mapa.set(l.subcuenta, s);
    }
  }
  return mapa;
}

/** Suma (haber - debe) de las subcuentas cuyo codigo empieza por alguno de los prefijos. */
export function saldoAcreedor(saldos: Map<string, SaldoSubcuenta>, prefijos: string[]): number {
  let total = 0;
  for (const s of saldos.values()) {
    if (prefijos.some((p) => s.subcuenta.startsWith(p))) total += s.haber - s.debe;
  }
  return round2(total);
}

/** Suma (debe - haber) de las subcuentas cuyo codigo empieza por alguno de los prefijos. */
export function saldoDeudor(saldos: Map<string, SaldoSubcuenta>, prefijos: string[]): number {
  let total = 0;
  for (const s of saldos.values()) {
    if (prefijos.some((p) => s.subcuenta.startsWith(p))) total += s.debe - s.haber;
  }
  return round2(total);
}
