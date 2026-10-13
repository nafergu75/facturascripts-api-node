// Contrato de la API de tesoreria que consume el frontend: traduce el booleano
// `conciliado` del esquema al `estado` que espera la pantalla, calcula saldos
// y rechaza conciliaciones que el backend aun no sabe contabilizar.
//
// Prisma y el modulo de bancos se mockean para no depender de la BD.
jest.mock('../config/database', () => {
  const prisma: Record<string, unknown> = {
    bankAccount: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    bankMovement: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    // La subcuenta indicada ya esta en el plan: no se da de alta.
    chartOfAccounts: { findFirst: jest.fn(async () => ({ id: 'plan57200001' })), create: jest.fn() },
    // Lecturas con bloqueo (SELECT ... FOR UPDATE): la subcuenta esta en el plan y,
    // salvo que la prueba diga otra cosa, no hay cuentas bancarias.
    $queryRaw: jest.fn(async (sql: TemplateStringsArray) => (sql.join('?').includes('FROM ChartOfAccounts') ? [{ id: 'plan57200001' }] : [])),
    // Empresa de EE. UU.: sus cuentas van en USD (la moneda de su contabilidad).
    legalConfig: { findUnique: jest.fn(async () => ({ pais: 'US', monedaCuenta: 'USD' })) },
  };
  prisma.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma, connectDatabase: jest.fn(), disconnectDatabase: jest.fn() };
});
jest.mock('../services/bancos.service', () => ({ importarMovimientosDesdeCSV: jest.fn() }));
jest.mock('../services/conciliacionConfirmar.service', () => ({ conciliarMovimientoConFactura: jest.fn() }));

import { prisma } from '../config/database';
import { importarMovimientosDesdeCSV } from '../services/bancos.service';
import { conciliarMovimientoConFactura } from '../services/conciliacionConfirmar.service';
import { treasuryService } from '../services/treasury.service';

const db = prisma as unknown as {
  bankAccount: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
  bankMovement: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
  $queryRaw: jest.Mock;
};

/** Las cuentas de la empresa que devuelve la lectura con bloqueo de BankAccount (una sola vez). */
const conCuentasBloqueadas = (filas: Array<{ id: string; iban: string; activa: number }>) =>
  db.$queryRaw.mockImplementationOnce(async () => filas);

const cuenta = {
  id: 'acc1',
  companyId: 'c1',
  iban: 'ES9121000418450200051332',
  bic: null,
  bancoNombre: 'Banco Demo',
  subcuentaCodigo: '57200001',
  saldoInicial: 1000,
  activa: true,
  createdAt: new Date('2026-01-01'),
};

const mov = (id: string, importe: number, conciliado: boolean) => ({
  id,
  companyId: 'c1',
  cuentaBancariaId: 'acc1',
  fecha: '2026-03-01',
  importe,
  concepto: 'x',
  referencia: null,
  origen: 'csv',
  conciliado,
  createdAt: new Date(),
});

beforeEach(() => jest.clearAllMocks());

describe('tesoreria', () => {
  it('traduce conciliado a estado y filtra por estado', async () => {
    db.bankAccount.findFirst.mockResolvedValue(cuenta);
    db.bankMovement.findMany.mockResolvedValue([mov('m1', 50, true)]);

    const res = await treasuryService.listarMovimientos('c1', 'acc1', 'conciliado');

    expect(db.bankMovement.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'c1',
      cuentaBancariaId: 'acc1',
      conciliado: true,
    });
    expect(res[0]).toMatchObject({ id: 'm1', estado: 'conciliado', tipo: 'entrada' });
  });

  it('rechaza un filtro de estado desconocido', async () => {
    db.bankAccount.findFirst.mockResolvedValue(cuenta);
    await expect(treasuryService.listarMovimientos('c1', 'acc1', 'rechazado')).rejects.toThrow(/pendiente/);
  });

  it('no deja ver movimientos de una cuenta de otra empresa', async () => {
    db.bankAccount.findFirst.mockResolvedValue(null);
    await expect(treasuryService.listarMovimientos('c2', 'acc1')).rejects.toThrow(/no encontrada/);
    expect(db.bankMovement.findMany).not.toHaveBeenCalled();
  });

  it('crea la cuenta normalizando el IBAN y guardando el saldo inicial', async () => {
    db.bankAccount.findFirst.mockResolvedValue(null);
    db.bankAccount.create.mockImplementation(({ data }) => Promise.resolve({ ...cuenta, ...data }));

    const res = await treasuryService.crearCuentaBancaria('c1', {
      iban: 'es91 2100 0418 4502 0005 1332',
      subcuentaCodigo: '57200001',
      saldoInicial: 250.5,
    });

    expect(db.bankAccount.create.mock.calls[0][0].data).toMatchObject({
      iban: 'ES9121000418450200051332',
      saldoInicial: 250.5,
      moneda: 'USD',
    });
    expect(res.estado).toBe('activa');
    expect(res.moneda).toBe('USD');
  });

  it('en una empresa de EE. UU. vale un numero de cuenta sin IBAN; lo que parece un IBAN se comprueba', async () => {
    db.bankAccount.findFirst.mockResolvedValue(null);
    db.bankAccount.create.mockImplementation(({ data }) => Promise.resolve({ ...cuenta, ...data }));
    const res = await treasuryService.crearCuentaBancaria('c1', { iban: '0001 2345-6789', subcuentaCodigo: '57200001' });
    expect(res.iban).toBe('000123456789');
    await expect(treasuryService.crearCuentaBancaria('c1', { iban: 'ES9121000418450200051333', subcuentaCodigo: '57200001' })).rejects.toMatchObject({
      statusCode: 400,
      details: { campo: 'iban' },
    });
  });

  it('no crea dos cuentas con el mismo IBAN (lo mira con bloqueo, dentro de la transaccion)', async () => {
    conCuentasBloqueadas([{ id: 'acc1', iban: 'ES91 2100 0418 4502 0005 1332', activa: 1 }]);
    await expect(
      treasuryService.crearCuentaBancaria('c1', { iban: cuenta.iban, subcuentaCodigo: '57200001' }),
    ).rejects.toThrow(/Ya tienes dada de alta una cuenta con el IBAN/);
    expect(db.bankAccount.create).not.toHaveBeenCalled();
  });

  it('el IBAN de una cuenta desactivada la vuelve a activar tal como estaba', async () => {
    conCuentasBloqueadas([{ id: 'acc1', iban: cuenta.iban, activa: 0 }]);
    db.bankAccount.update.mockImplementation(({ data }) => Promise.resolve({ ...cuenta, ...data }));
    const res = await treasuryService.crearCuentaBancaria('c1', { iban: cuenta.iban, subcuentaCodigo: '57200009', saldoInicial: 5 });
    expect(db.bankAccount.update).toHaveBeenCalledWith({ where: { id: 'acc1' }, data: { activa: true } });
    expect(db.bankAccount.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ id: 'acc1', subcuentaCodigo: '57200001', saldoInicial: 1000, estado: 'activa', reactivada: true });
  });

  it('avisa de la cuenta cuya subcuenta no es de bancos (dada de alta antes de comprobarlo)', async () => {
    db.bankAccount.findMany.mockResolvedValue([{ ...cuenta, subcuentaCodigo: '0001', movimientos: [] }, { ...cuenta, id: 'acc2', movimientos: [] }]);
    const [mala, buena] = await treasuryService.listarCuentasBancarias('c1');
    expect(mala.avisoSubcuenta).toMatch(/«0001» no es de bancos.*no se pueden apuntar cobros ni pagos/);
    expect(buena.avisoSubcuenta).toBeUndefined();
  });

  it('resumen: saldo actual = saldo inicial + movimientos, redondeado a centimos', async () => {
    db.bankAccount.findMany.mockResolvedValue([cuenta]);
    db.bankMovement.count.mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    db.bankMovement.groupBy.mockResolvedValue([{ cuentaBancariaId: 'acc1', _sum: { importe: 0.1 + 0.2 } }]);

    const res = await treasuryService.obtenerResumen('c1');

    expect(res).toMatchObject({ cuentasActivas: 1, conciliados: 2, pendientes: 3, saldoTotal: 1000.3 });
    expect(res.cuentas[0].saldoActual).toBe(1000.3);
  });

  it('sube el extracto con el parser de bancos y devuelve detalles con estado', async () => {
    db.bankAccount.findFirst.mockResolvedValue(cuenta);
    (importarMovimientosDesdeCSV as jest.Mock).mockResolvedValue([{ id: 'm1', conciliado: false }]);

    const res = await treasuryService.subirExtracto('c1', 'acc1', '2026-03-01;10,50;Cobro');

    expect(importarMovimientosDesdeCSV).toHaveBeenCalledWith('c1', 'acc1', '2026-03-01;10,50;Cobro');
    expect(res).toEqual({ movimientosCreados: 1, detalles: [{ id: 'm1', conciliado: false, estado: 'pendiente' }] });
  });

  it('concilia un cobro con factura de venta', async () => {
    (conciliarMovimientoConFactura as jest.Mock).mockResolvedValue({ movimientoConciliado: true });
    await treasuryService.conciliarMovimiento('c1', 'm1', 'factura_ingreso', ' f1 ');
    expect(conciliarMovimientoConFactura).toHaveBeenCalledWith('c1', 'm1', 'f1');
  });

  it('rechaza conciliar con factura de gasto o asiento en vez de fingirlo', async () => {
    await expect(treasuryService.conciliarMovimiento('c1', 'm1', 'factura_gasto', 'g1')).rejects.toThrow(
      /no esta disponible/,
    );
    await expect(treasuryService.conciliarMovimiento('c1', 'm1', 'asiento', 'a1')).rejects.toThrow(
      /no esta disponible/,
    );
    expect(conciliarMovimientoConFactura).not.toHaveBeenCalled();
  });
});
