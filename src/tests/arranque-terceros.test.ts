/**
 * Mayor de clientes y proveedores tras traer la contabilidad de 2026: si 2026
 * lo llevo la gestoria, el mayor de 2027 parte de la apertura importada (que
 * trae el saldo de cada subcuenta) y no suma el diario historico. Sin base de
 * datos.
 */
import { describe, it, expect } from '@jest/globals';
import { asientosParaTerceros, type AsientoInforme } from '../services/informesContables.calculo';

const asiento = (id: string, fecha: string, tipo: AsientoInforme['tipo'], lineas: Array<[string, number, number]>): AsientoInforme => ({
  id,
  fecha,
  numero: id,
  concepto: id,
  tipo,
  invoiceId: null,
  invoiceType: null,
  lineas: lineas.map(([cuenta, debe, haber]) => ({ cuenta, nombre: '', debe, haber, referencia: null })),
});

describe('asientos del mayor de terceros', () => {
  const todos = [
    asiento('HIST-1', '2026-01-01', 'APERTURA', [['4300000001', 100, 0], ['1000000000', 0, 100]]),
    asiento('HIST-2', '2026-05-01', 'NORMAL', [['4300000001', 40, 0], ['7000000000', 0, 40]]),
    asiento('APERT-1', '2027-01-01', 'APERTURA', [['4300000001', 150, 0], ['1000000000', 0, 150]]),
    asiento('FAC-1', '2027-02-01', 'NORMAL', [['4300000001', 10, 0], ['7000000000', 0, 10]]),
  ];

  it('sin año externo: toda la historia, sin la apertura de 2027 (como hasta ahora)', () => {
    expect(asientosParaTerceros(todos, '2027-12-31').map((a) => a.id)).toEqual(['HIST-1', 'HIST-2', 'FAC-1']);
  });

  it('con 2026 externo: desde la apertura de 2027, que trae el saldo que dio la gestoría', () => {
    expect(asientosParaTerceros(todos, '2027-12-31', '2027-01-01').map((a) => a.id)).toEqual(['APERT-1', 'FAC-1']);
  });
});
