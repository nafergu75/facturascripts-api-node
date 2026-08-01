import { prisma } from '../config/database';

/** Linea (apunte) simplificada de un asiento. */
export interface LineaAsientoSimple {
  subcuenta: string;
  debe: number;
  haber: number;
}

/** Asiento simplificado para los estados financieros. */
export interface AsientoSimple {
  idasiento?: number | string;
  fecha: string; // yyyy-mm-dd
  numero: string | number;
  concepto: string;
  lineas: LineaAsientoSimple[];
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

  const entries = await prisma.journalEntry.findMany({
    where: { companyId, estado: 'POSTED', fecha: { gte: desde, lt: hasta } },
    include: { lineas: true },
    orderBy: { fecha: 'asc' },
  });

  return entries.map((a) => ({
    idasiento: a.id,
    fecha: a.fecha.toISOString().slice(0, 10),
    numero: a.numeroAsiento,
    concepto: a.descripcion,
    lineas: a.lineas.map((l) => ({
      subcuenta: l.accountCode,
      debe: Number(l.debe ?? 0),
      haber: Number(l.haber ?? 0),
    })),
  }));
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
