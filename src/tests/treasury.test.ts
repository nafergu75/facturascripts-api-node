// Contrato de la API de tesoreria que consume el frontend: traduce el booleano
// `conciliado` del esquema al `estado` que espera la pantalla, calcula saldos
// y rechaza conciliaciones que el backend aun no sabe contabilizar.
//
// Prisma y el modulo de bancos se mockean para no depender de la BD.
jest.mock('../config/database', () => ({
  prisma: {
    bankAccount: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
    bankMovement: { findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
    // Empresa de EE. UU.: sus cuentas van en USD (la moneda de su contabilidad).
    legalConfig: { findUnique: jest.fn(async () => ({ pais: 'US', monedaCuenta: 'USD' })) },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
jest.mock('../services/bancos.service', () => ({ importarMovimientosDesdeCSV: jest.fn() }));
jest.mock('../services/conciliacionConfirmar.service', () => ({ conciliarMovimientoConFactura: jest.fn() }));

import { prisma } from '../config/database';
import { importarMovimientosDesdeCSV } from '../services/bancos.service';
import { conciliarMovimientoConFactura } from '../services/conciliacionConfirmar.service';
import { treasuryService } from '../services/treasury.service';

const db = prisma as unknown as {
  bankAccount: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock };
  bankMovement: { findMany: jest.Mock; count: jest.Mock; groupBy: jest.Mock };
};

const cuenta = {
  id: 'acc1',
  companyId: 'c1',
  iban: 'ES9121000418450200051332',
  bic: null,
  bancoNombre: 'Banco Demo',
  subcuentaCodigo: '572000',
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
      subcuentaCodigo: '572000',
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

  it('no crea dos cuentas con el mismo IBAN', async () => {
    db.bankAccount.findFirst.mockResolvedValue(cuenta);
    await expect(
      treasuryService.crearCuentaBancaria('c1', { iban: cuenta.iban, subcuentaCodigo: '572000' }),
    ).rejects.toThrow(/Ya existe/);
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
