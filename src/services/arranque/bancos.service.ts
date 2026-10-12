/**
 * Bancos de la carga: cada 572 de la apertura se enlaza con su cuenta de
 * Tesoreria (la que ya existe con esa subcuenta, la que elige la persona o una
 * nueva con su IBAN) y se le pone el saldo del extracto a 31-12:
 *
 *  - saldoInicial = saldo del extracto (lo da el banco);
 *  - fechaSaldoInicial = 31-12 del año que lleva la gestoria: el extracto y el
 *    cuadre de bancos parten de ahi y solo cuentan los movimientos posteriores;
 *  - saldoContableInicial = saldo de la 572 en la apertura, para enseñar la
 *    diferencia (partidas en transito).
 *
 * Los valores anteriores de cada cuenta se guardan en la carga para deshacer.
 */
import type { TransaccionBD } from '../../config/database';
import type { AjusteBanco } from './datos';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ValorAnteriorBanco {
  id: string;
  saldoInicial: number;
  fechaSaldoInicial: string | null;
  saldoContableInicial: number | null;
}

/** Saldo de cada 572 en unas lineas de apertura. */
export function saldos572(lineas: Array<{ cuenta: string; debe: number; haber: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lineas) if (l.cuenta.startsWith('572')) m.set(l.cuenta, r2((m.get(l.cuenta) ?? 0) + l.debe - l.haber));
  return m;
}

/**
 * Aplica los saldos de los extractos. `anterior.bancos` y `creado.bancos` se
 * completan (solo la primera vez que se toca cada cuenta). Devuelve cuantas
 * cuentas se han tocado y cuantas se han dado de alta.
 */
export async function aplicarBancos(
  tx: TransaccionBD,
  companyId: string,
  anioOrigen: number,
  apertura: Map<string, number>,
  ajustes: Record<string, AjusteBanco>,
  anterior: Record<string, unknown>,
  creado: Record<string, unknown>,
): Promise<{ tocadas: number; altas: number }> {
  const previos = (anterior.bancos as ValorAnteriorBanco[] | undefined) ?? [];
  const altas = (creado.bancos as string[] | undefined) ?? [];
  let tocadas = 0;
  let nuevas = 0;
  const cuentas = await tx.bankAccount.findMany({ where: { companyId } });
  for (const [codigo, saldoApertura] of apertura) {
    const a = ajustes[codigo];
    if (!a) continue;
    let cuenta = a.bankAccountId ? cuentas.find((c) => c.id === a.bankAccountId && c.subcuentaCodigo === codigo) : cuentas.find((c) => c.subcuentaCodigo === codigo && c.activa);
    if (!cuenta && a.nueva) {
      cuenta = await tx.bankAccount.create({ data: { companyId, iban: a.nueva.iban, bancoNombre: a.nueva.bancoNombre ?? null, subcuentaCodigo: codigo } });
      cuentas.push(cuenta);
      altas.push(cuenta.id);
      nuevas++;
    }
    if (!cuenta) continue;
    if (!previos.some((p) => p.id === cuenta!.id) && !altas.includes(cuenta.id)) {
      previos.push({
        id: cuenta.id,
        saldoInicial: Number(cuenta.saldoInicial),
        fechaSaldoInicial: cuenta.fechaSaldoInicial,
        saldoContableInicial: cuenta.saldoContableInicial === null ? null : Number(cuenta.saldoContableInicial),
      });
    }
    await tx.bankAccount.update({
      where: { id: cuenta.id },
      data: {
        ...(a.saldoExtracto !== null ? { saldoInicial: a.saldoExtracto, fechaSaldoInicial: `${anioOrigen}-12-31` } : {}),
        saldoContableInicial: saldoApertura,
      },
    });
    tocadas++;
  }
  anterior.bancos = previos;
  creado.bancos = altas;
  return { tocadas, altas: nuevas };
}

/** Deshace lo que hizo aplicarBancos: valores anteriores y bajas de las cuentas dadas de alta sin movimientos. */
export async function deshacerBancos(tx: TransaccionBD, companyId: string, anterior: Record<string, unknown>, creado: Record<string, unknown>): Promise<{ restauradas: number; borradas: number; quedan: number }> {
  let restauradas = 0;
  for (const p of (anterior.bancos as ValorAnteriorBanco[] | undefined) ?? []) {
    const r = await tx.bankAccount.updateMany({
      where: { id: p.id, companyId },
      data: { saldoInicial: p.saldoInicial, fechaSaldoInicial: p.fechaSaldoInicial, saldoContableInicial: p.saldoContableInicial },
    });
    restauradas += r.count;
  }
  let borradas = 0;
  let quedan = 0;
  for (const id of (creado.bancos as string[] | undefined) ?? []) {
    const movimientos = await tx.bankMovement.count({ where: { companyId, cuentaBancariaId: id } });
    if (movimientos) {
      // Ya tiene movimientos de 2027: se queda, sin el saldo inicial de la carga.
      await tx.bankAccount.updateMany({ where: { id, companyId }, data: { saldoInicial: 0, fechaSaldoInicial: null, saldoContableInicial: null } });
      quedan++;
    } else {
      borradas += (await tx.bankAccount.deleteMany({ where: { id, companyId } })).count;
    }
  }
  return { restauradas, borradas, quedan };
}
