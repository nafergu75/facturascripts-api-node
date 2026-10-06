import { randomUUID } from 'crypto';
import { prisma } from '../../config/database';
import { badRequest } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';

/** Cliente de una transaccion interactiva de Prisma. */
export type Tx = Parameters<Extract<Parameters<typeof prisma.$transaction>[0], (...args: never[]) => unknown>>[0];

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LineaNueva {
  cuenta: string;
  nombre: string;
  debe: number;
  haber: number;
  referencia?: string;
}

export interface AsientoNuevo {
  fecha: string; // yyyy-mm-dd
  concepto: string;
  origen: 'APERTURA' | 'REGULARIZACION' | 'CIERRE' | 'IMPORTACION';
  lineas: LineaNueva[];
}

const PREFIJO: Record<AsientoNuevo['origen'], string> = {
  APERTURA: 'APERT',
  REGULARIZACION: 'REGUL',
  CIERRE: 'CIERRE',
  IMPORTACION: 'IMP',
};

/**
 * Graba varios asientos POSTED dentro de una transaccion, con numero
 * correlativo por prefijo (APERT-00001...). Toma el mayor numero existente,
 * no el recuento: si se anula o borra alguno no se repiten numeros.
 * Rechaza cualquier asiento que no cuadre al centimo.
 */
export async function grabarAsientos(tx: Tx, companyId: string, asientos: AsientoNuevo[]): Promise<Array<{ id: string; numero: string }>> {
  for (const a of asientos) {
    const debe = round2(a.lineas.reduce((s, l) => s + l.debe, 0));
    const haber = round2(a.lineas.reduce((s, l) => s + l.haber, 0));
    if (aCentimos(debe) !== aCentimos(haber)) {
      throw badRequest(`El asiento "${a.concepto}" no cuadra: Debe ${debe.toFixed(2)} y Haber ${haber.toFixed(2)}.`);
    }
    if (a.lineas.length === 0) throw badRequest(`El asiento "${a.concepto}" no tiene apuntes.`);
  }

  const siguiente = new Map<string, number>();
  const numerar = async (prefijo: string): Promise<string> => {
    if (!siguiente.has(prefijo)) {
      const existentes = await tx.journalEntry.findMany({
        where: { companyId, numeroAsiento: { startsWith: `${prefijo}-` } },
        select: { numeroAsiento: true },
      });
      let max = 0;
      for (const e of existentes) {
        const n = Number(e.numeroAsiento.slice(prefijo.length + 1));
        if (Number.isInteger(n) && n < 10_000_000 && n > max) max = n;
      }
      siguiente.set(prefijo, max + 1);
    }
    const n = siguiente.get(prefijo)!;
    siguiente.set(prefijo, n + 1);
    return `${prefijo}-${String(n).padStart(5, '0')}`;
  };

  const cabeceras: Array<{ id: string; companyId: string; fecha: Date; numeroAsiento: string; descripcion: string; origen: string; estado: string }> = [];
  const lineas: Array<{ id: string; entryId: string; accountCode: string; accountName: string; debe: number; haber: number; referencia: string | null; companyId: string }> = [];
  for (const a of asientos) {
    const id = randomUUID();
    const numero = await numerar(PREFIJO[a.origen]);
    cabeceras.push({
      id,
      companyId,
      fecha: new Date(`${a.fecha}T00:00:00.000Z`),
      numeroAsiento: numero,
      descripcion: a.concepto.slice(0, 190),
      origen: a.origen,
      estado: 'POSTED',
    });
    for (const l of a.lineas) {
      lineas.push({
        id: randomUUID(),
        entryId: id,
        accountCode: l.cuenta,
        accountName: (l.nombre || `Cuenta ${l.cuenta}`).slice(0, 190),
        debe: round2(l.debe),
        haber: round2(l.haber),
        referencia: l.referencia ? l.referencia.slice(0, 190) : null,
        companyId,
      });
    }
  }

  // createMany en tandas: un diario de un año puede tener miles de apuntes.
  for (let i = 0; i < cabeceras.length; i += 500) {
    await tx.journalEntry.createMany({ data: cabeceras.slice(i, i + 500) });
  }
  for (let i = 0; i < lineas.length; i += 1000) {
    await tx.journalEntryLine.createMany({ data: lineas.slice(i, i + 1000) });
  }
  return cabeceras.map((c) => ({ id: c.id, numero: c.numeroAsiento }));
}

/** Anula (estado REVERSED) asientos: dejan de contar en libros y estados, pero quedan como rastro. */
export async function anularAsientos(tx: Tx, companyId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await tx.journalEntry.updateMany({ where: { companyId, id: { in: ids } }, data: { estado: 'REVERSED' } });
  return r.count;
}

/** Rango [1 ene, 1 ene siguiente) de un ejercicio natural. */
export function rangoEjercicio(ejercicio: number): { gte: Date; lt: Date } {
  return { gte: new Date(Date.UTC(ejercicio, 0, 1)), lt: new Date(Date.UTC(ejercicio + 1, 0, 1)) };
}

/** Opciones de las transacciones largas (importar un diario puede llevar segundos). */
export const OPCIONES_TX = { timeout: 60_000, maxWait: 10_000 };
