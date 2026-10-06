// Importacion de extractos CSV: prueba el servicio real (el test historico de
// bancos-csv-decimal reimplementa el parseo dentro del propio test y no
// ejercita bancos.service).
//
// Regresiones:
// - "1.234,56" (miles con punto) daba NaN y la linea se descartaba EN SILENCIO:
//   el extracto se importaba incompleto sin avisar.
// - Fechas no validadas: cualquier texto acababa en `fecha`.
jest.mock('../config/database', () => {
  const creados: Array<Record<string, unknown>> = [];
  return {
    __creados: creados,
    prisma: {
      bankAccount: { findUnique: jest.fn(async () => ({ id: 'acc1', companyId: 'c1' })) },
      bankMovement: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const fila = { id: `m${creados.length + 1}`, referencia: null, conciliado: false, ...data };
          creados.push(fila);
          return fila;
        }),
      },
    },
  };
});

import * as database from '../config/database';
import { importarMovimientosDesdeCSV, parsearImporte } from '../services/bancos.service';

const creados = (database as unknown as { __creados: Array<Record<string, unknown>> }).__creados;

beforeEach(() => {
  creados.length = 0;
});

describe('parsearImporte', () => {
  it('formato europeo con miles y decimales', () => {
    expect(parsearImporte('1.234,56', true)).toBe(1234.56);
    expect(parsearImporte('-12.345.678,9', true)).toBe(-12345678.9);
    expect(parsearImporte('89,90', true)).toBe(89.9);
    expect(parsearImporte('1500', true)).toBe(1500);
    expect(parsearImporte(' 1.234,56 € ', true)).toBe(1234.56);
  });

  it('formato con punto decimal', () => {
    expect(parsearImporte('1234.56', false)).toBe(1234.56);
    expect(parsearImporte('-89.90', false)).toBe(-89.9);
  });

  it('devuelve NaN para lo que no es un importe', () => {
    expect(parsearImporte('ABC', true)).toBeNaN();
    expect(parsearImporte('1,2,3', true)).toBeNaN();
    expect(parsearImporte('', true)).toBeNaN();
  });
});

describe('importarMovimientosDesdeCSV', () => {
  it('importa importes con separador de miles', async () => {
    const csv = 'fecha;importe;concepto\n01/06/2026;1.234,56;Cobro grande\n2026-06-02;-89,90;Comision';
    const movs = await importarMovimientosDesdeCSV('c1', 'acc1', csv);
    expect(movs.map((m) => [m.fecha, m.importe])).toEqual([
      ['2026-06-01', 1234.56],
      ['2026-06-02', -89.9],
    ]);
  });

  it('si una linea no se entiende, rechaza el extracto entero sin importar nada', async () => {
    const csv = 'fecha;importe;concepto\n2026-06-01;100,00;Bien\n2026-06-02;ABC;Mal importe\n32/13/2026;5,00;Mala fecha';
    await expect(importarMovimientosDesdeCSV('c1', 'acc1', csv)).rejects.toThrow(/linea 3.*linea 4/s);
    expect(creados).toHaveLength(0);
  });
});
