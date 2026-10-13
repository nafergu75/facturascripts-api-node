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
 *
 * Si el IBAN escrito para una 572 ya es de una cuenta de Tesoreria con otra
 * subcuenta (se dio de alta antes de traer la contabilidad, por ejemplo desde la
 * ventana de cobro, con la 57200001), no se crea otra cuenta con el mismo IBAN:
 * esa cuenta pasa a la 572 de la gestoria, para que el saldo de apertura y los
 * cobros vayan a la misma. Lo que ya se hubiera apuntado en la subcuenta de
 * antes se queda alli (se avisa). Deshacer le devuelve su subcuenta.
 */
import type { TransaccionBD } from '../../config/database';
import type { AjusteBanco } from './datos';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ValorAnteriorBanco {
  id: string;
  saldoInicial: number;
  fechaSaldoInicial: string | null;
  saldoContableInicial: number | null;
  /** Solo si la carga le cambio la subcuenta (cuenta enlazada por su IBAN). */
  subcuentaCodigo?: string;
  activa?: boolean;
}

/** IBAN sin espacios ni guiones y en mayusculas (como lo guarda Tesoreria). */
const normalizarIban = (iban: string) => iban.replace(/[\s-]+/g, '').toUpperCase();

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
): Promise<{ tocadas: number; altas: number; avisos?: string[] }> {
  const previos = (anterior.bancos as ValorAnteriorBanco[] | undefined) ?? [];
  const altas = (creado.bancos as string[] | undefined) ?? [];
  const avisos: string[] = [];
  let tocadas = 0;
  let nuevas = 0;
  const cuentas = await tx.bankAccount.findMany({ where: { companyId } });
  const guardarAnterior = (cuenta: (typeof cuentas)[number], extra: Partial<ValorAnteriorBanco> = {}) => {
    if (previos.some((p) => p.id === cuenta.id) || altas.includes(cuenta.id)) return;
    previos.push({
      id: cuenta.id,
      saldoInicial: Number(cuenta.saldoInicial),
      fechaSaldoInicial: cuenta.fechaSaldoInicial,
      saldoContableInicial: cuenta.saldoContableInicial === null ? null : Number(cuenta.saldoContableInicial),
      ...extra,
    });
  };
  for (const [codigo, saldoApertura] of apertura) {
    const a = ajustes[codigo];
    if (!a) continue;
    let cuenta = a.bankAccountId ? cuentas.find((c) => c.id === a.bankAccountId && c.subcuentaCodigo === codigo) : cuentas.find((c) => c.subcuentaCodigo === codigo && c.activa);
    if (!cuenta && a.nueva) {
      const iban = normalizarIban(a.nueva.iban);
      const mismoIban = cuentas.find((c) => normalizarIban(c.iban) === iban);
      if (mismoIban && mismoIban.subcuentaCodigo !== codigo && apertura.has(mismoIban.subcuentaCodigo)) {
        // Ya es la cuenta de otra 572 de la apertura: no se le quita ni se duplica.
        avisos.push(`El IBAN de la ${codigo} ya es de la cuenta bancaria de la ${mismoIban.subcuentaCodigo}: revisa el IBAN.`);
        continue;
      }
      if (mismoIban) {
        // La de otra subcuenta pasa a esta 572 (y una desactivada de esta misma, se reactiva).
        guardarAnterior(mismoIban, { subcuentaCodigo: mismoIban.subcuentaCodigo, activa: mismoIban.activa });
        if (mismoIban.subcuentaCodigo !== codigo) {
          avisos.push(
            `La cuenta bancaria del IBAN acabado en ${iban.slice(-4)} tenía la subcuenta ${mismoIban.subcuentaCodigo} y pasa a la ${codigo}. ` +
              `Si ya habías apuntado cobros o pagos en la ${mismoIban.subcuentaCodigo}, siguen allí: pásalos a la ${codigo} con un asiento.`,
          );
        }
        cuenta = await tx.bankAccount.update({ where: { id: mismoIban.id }, data: { subcuentaCodigo: codigo, activa: true } });
        cuentas.splice(cuentas.indexOf(mismoIban), 1, cuenta);
      } else {
        cuenta = await tx.bankAccount.create({ data: { companyId, iban, bancoNombre: a.nueva.bancoNombre ?? null, subcuentaCodigo: codigo } });
        cuentas.push(cuenta);
        altas.push(cuenta.id);
        nuevas++;
      }
    }
    if (!cuenta) continue;
    guardarAnterior(cuenta);
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
  return { tocadas, altas: nuevas, ...(avisos.length ? { avisos } : {}) };
}

/** Deshace lo que hizo aplicarBancos: valores anteriores y bajas de las cuentas dadas de alta sin movimientos. */
export async function deshacerBancos(tx: TransaccionBD, companyId: string, anterior: Record<string, unknown>, creado: Record<string, unknown>): Promise<{ restauradas: number; borradas: number; quedan: number }> {
  let restauradas = 0;
  for (const p of (anterior.bancos as ValorAnteriorBanco[] | undefined) ?? []) {
    const r = await tx.bankAccount.updateMany({
      where: { id: p.id, companyId },
      data: {
        saldoInicial: p.saldoInicial,
        fechaSaldoInicial: p.fechaSaldoInicial,
        saldoContableInicial: p.saldoContableInicial,
        // La cuenta que la carga enlazo por su IBAN vuelve a su subcuenta.
        ...(p.subcuentaCodigo !== undefined ? { subcuentaCodigo: p.subcuentaCodigo } : {}),
        ...(p.activa !== undefined ? { activa: p.activa } : {}),
      },
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
