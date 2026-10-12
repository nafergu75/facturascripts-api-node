/**
 * Bancos con el saldo del extracto a 31-12-2026: el extracto parte de ese
 * saldo y solo cuenta los movimientos posteriores; deshacer devuelve los
 * valores anteriores y quita las cuentas nuevas sin movimientos.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { aplicarBancos, deshacerBancos, saldos572 } from '../services/arranque/bancos.service';
import { generarExtractoBancario } from '../services/extractos.service';

const E = `arr-bancos-${Date.now()}`;

describe('bancos con el saldo del extracto', () => {
  let cuentaId = '';
  const anterior: Record<string, unknown> = {};
  const creado: Record<string, unknown> = {};
  beforeAll(async () => {
    await prisma.company.create({ data: { id: E, name: 'Bancos', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
    const c = await prisma.bankAccount.create({ data: { companyId: E, iban: 'ES0000000000000000000001', subcuentaCodigo: '5720000001', saldoInicial: 5 } });
    cuentaId = c.id;
    for (const [fecha, importe] of [
      ['2026-12-20', 300],
      ['2027-01-10', -100],
      ['2027-02-05', 50],
    ] as const) {
      await prisma.bankMovement.create({ data: { companyId: E, cuentaBancariaId: cuentaId, fecha, importe, concepto: 'x', origen: 'CSV' } });
    }
  });

  it('enlaza las 572 de la apertura, da de alta las nuevas y guarda lo anterior', async () => {
    const apertura = saldos572([
      { cuenta: '5720000001', debe: 1000, haber: 0 },
      { cuenta: '5720000002', debe: 200, haber: 0 },
      { cuenta: '4300000001', debe: 50, haber: 0 },
    ]);
    expect([...apertura.keys()]).toEqual(['5720000001', '5720000002']);
    const r = await prisma.$transaction((tx) =>
      aplicarBancos(tx, E, 2026, apertura, { '5720000001': { saldoExtracto: 990 }, '5720000002': { saldoExtracto: 200, nueva: { iban: 'ES0000000000000000000002' } } }, anterior, creado),
    );
    expect(r).toEqual({ tocadas: 2, altas: 1 });
    expect(await prisma.bankAccount.findUnique({ where: { id: cuentaId } })).toMatchObject({ saldoInicial: 990, fechaSaldoInicial: '2026-12-31', saldoContableInicial: 1000 });
    expect(anterior.bancos).toEqual([{ id: cuentaId, saldoInicial: 5, fechaSaldoInicial: null, saldoContableInicial: null }]);
    expect(creado.bancos).toHaveLength(1);
  });

  it('el extracto parte del saldo a 31-12 y no cuenta lo anterior', async () => {
    const todo = await generarExtractoBancario(E, cuentaId);
    expect(todo).toMatchObject({ saldoInicial: 990, saldoFinal: 940, numMovimientos: 2 });
    const desdeFebrero = await generarExtractoBancario(E, cuentaId, { desde: '2027-02-01' });
    expect(desdeFebrero).toMatchObject({ saldoInicial: 890, saldoFinal: 940, numMovimientos: 1 });
  });

  it('deshacer devuelve los valores anteriores y quita la cuenta nueva sin movimientos', async () => {
    const r = await prisma.$transaction((tx) => deshacerBancos(tx, E, anterior, creado));
    expect(r).toEqual({ restauradas: 1, borradas: 1, quedan: 0 });
    expect(await prisma.bankAccount.findUnique({ where: { id: cuentaId } })).toMatchObject({ saldoInicial: 5, fechaSaldoInicial: null, saldoContableInicial: null });
    expect(await prisma.bankAccount.count({ where: { companyId: E } })).toBe(1);
    // Sin fecha del saldo inicial, el extracto vuelve a contar todo desde cero.
    expect(await generarExtractoBancario(E, cuentaId)).toMatchObject({ saldoInicial: 0, numMovimientos: 3 });
  });
});
