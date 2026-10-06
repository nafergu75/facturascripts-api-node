// Cuadre de asientos: debe y haber tienen que ser iguales al centimo.
//
// Regresion: se aceptaba |debe - haber| <= 0,01. Con Float eso deja pasar la
// mayoria de descuadres de un centimo: 1000,01 - 1000 = 0,00999... (aceptado),
// mientras 121,01 - 121 = 0,0100...05 se rechaza. Entre 0,01 y 1.000 EUR se
// aceptaban 81.551 de 99.999 pares que difieren en un centimo.
jest.mock('../config/database', () => ({ prisma: {} }));

import { cuadraEnCentimos, aCentimos } from '../utils/money';
import { accountingEngineService } from '../services/accounting-engine.service';

describe('cuadraEnCentimos', () => {
  it('acepta importes iguales aunque la suma en Float arrastre decimales', () => {
    expect(cuadraEnCentimos(0.1 + 0.2, 0.3)).toBe(true);
    expect(cuadraEnCentimos(100 + 21, 121)).toBe(true);
  });

  it('rechaza una diferencia de un centimo en cualquier sentido', () => {
    expect(cuadraEnCentimos(1000.01, 1000)).toBe(false);
    expect(cuadraEnCentimos(0.03, 0.02)).toBe(false);
    expect(cuadraEnCentimos(121, 121.01)).toBe(false);
  });

  it('aCentimos redondea al centimo mas cercano', () => {
    expect(aCentimos(10.005)).toBe(1001);
    expect(aCentimos(-0.015)).toBe(-2);
    expect(aCentimos(1.1 + 2.2)).toBe(330);
  });
});

describe('contabilizar una factura descuadrada en un centimo', () => {
  it('se rechaza en vez de crear un asiento descuadrado', async () => {
    const db = {
      journalEntry: { create: jest.fn(async () => ({ id: 'a1' })) },
      journalEntryLine: { create: jest.fn(async ({ data }: { data: unknown }) => data) },
      vATBook: { create: jest.fn() },
    };
    await expect(
      accountingEngineService.contabilizarFacturaIngreso(
        'c1',
        'inv',
        {
          baseTotal: 1000,
          ivaTotal: 0,
          ivaRate: 0,
          retencionTotal: 0,
          retencionRate: 0,
          totalFactura: 1000.01,
          fechaEmision: '2026-10-06',
          numeroFactura: 'F-9',
          clienteId: 'c',
          clienteNif: 'B1',
          clienteNombre: 'Cliente',
        },
        db as never,
      ),
    ).rejects.toThrow(/desequilibrado/);
    expect(db.vATBook.create).not.toHaveBeenCalled();
  });
});
