// Libro registro de IVA al contabilizar facturas.
//
// Regresion: se guardaba UN registro por factura con el tipo de la primera
// linea, y `tipoIva || 21` convertia el 0 (exenta) en 21. Una factura exenta
// acababa al 21% y una factura 21% + 10% quedaba entera al tipo de la linea 0,
// descuadrando el desglose por tipos del modelo 303.
//
// El servicio acepta un cliente de BD inyectado (tx), asi que se prueba con un
// doble en memoria, sin MySQL.
jest.mock('../config/database', () => ({ prisma: {} }));

import { accountingEngineService, desgloseIvaPorTipo } from '../services/accounting-engine.service';

function dbFalsa() {
  const libroIva: Array<Record<string, unknown>> = [];
  const db = {
    journalEntry: { create: jest.fn(async () => ({ id: 'asiento-1' })) },
    journalEntryLine: { create: jest.fn(async ({ data }: { data: unknown }) => data) },
    vATBook: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => libroIva.push(data)) },
    retentionBook: { create: jest.fn(async () => ({})) },
  };
  return { db, libroIva };
}

const ingresoBase = {
  retencionTotal: 0,
  retencionRate: 0,
  fechaEmision: '2026-10-06',
  numeroFactura: 'F-1',
  clienteId: 'c1',
  clienteNif: 'B12345678',
  clienteNombre: 'Cliente SL',
};

describe('desgloseIvaPorTipo', () => {
  it('agrupa las lineas por tipo y redondea a centimos', () => {
    expect(
      desgloseIvaPorTipo([
        { tipoIva: 21, baseLine: 100, ivaImporte: 21 },
        { tipoIva: 10, baseLine: 50, ivaImporte: 5 },
        { tipoIva: 21, baseLine: 0.1, ivaImporte: 0.021 },
      ]),
    ).toEqual([
      { tipoIva: 21, base: 100.1, cuota: 21.02 },
      { tipoIva: 10, base: 50, cuota: 5 },
    ]);
  });

  it('respeta el tipo 0 (exenta) en vez de convertirlo en 21', () => {
    expect(desgloseIvaPorTipo([{ tipoIva: 0, baseLine: 300, ivaImporte: 0 }])).toEqual([
      { tipoIva: 0, base: 300, cuota: 0 },
    ]);
  });
});

describe('libro de IVA al contabilizar una factura de ingreso', () => {
  it('registra una factura exenta al 0%', async () => {
    const { db, libroIva } = dbFalsa();
    await accountingEngineService.contabilizarFacturaIngreso(
      'c1',
      'inv-1',
      {
        ...ingresoBase,
        baseTotal: 300,
        ivaTotal: 0,
        ivaRate: 0,
        totalFactura: 300,
        desgloseIva: [{ tipoIva: 0, base: 300, cuota: 0 }],
      },
      db as never,
    );
    expect(libroIva).toHaveLength(1);
    expect(libroIva[0]).toMatchObject({ tipoIva: 0, baseImponible: 300, cuotaIva: 0, tipoLibro: 'EMITIDAS' });
  });

  it('registra un apunte por cada tipo de IVA de la factura', async () => {
    const { db, libroIva } = dbFalsa();
    await accountingEngineService.contabilizarFacturaIngreso(
      'c1',
      'inv-2',
      {
        ...ingresoBase,
        baseTotal: 150,
        ivaTotal: 26,
        ivaRate: 21,
        totalFactura: 176,
        desgloseIva: [
          { tipoIva: 21, base: 100, cuota: 21 },
          { tipoIva: 10, base: 50, cuota: 5 },
        ],
      },
      db as never,
    );
    expect(libroIva.map((r) => [r.tipoIva, r.baseImponible, r.cuotaIva])).toEqual([
      [21, 100, 21],
      [10, 50, 5],
    ]);
  });

  it('sin desglose, usa los totales y el tipo de la factura', async () => {
    const { db, libroIva } = dbFalsa();
    await accountingEngineService.contabilizarFacturaIngreso(
      'c1',
      'inv-3',
      { ...ingresoBase, baseTotal: 100, ivaTotal: 21, ivaRate: 21, totalFactura: 121 },
      db as never,
    );
    expect(libroIva).toEqual([expect.objectContaining({ tipoIva: 21, baseImponible: 100, cuotaIva: 21 })]);
  });
});

describe('libro de IVA al contabilizar una factura de gasto', () => {
  it('registra un apunte por cada tipo de IVA soportado', async () => {
    const { db, libroIva } = dbFalsa();
    await accountingEngineService.contabilizarFacturaGasto(
      'c1',
      'g-1',
      {
        baseTotal: 150,
        ivaTotal: 26,
        ivaRate: 21,
        retencionTotal: 0,
        retencionRate: 0,
        totalFactura: 176,
        fechaEmision: '2026-10-06',
        numeroFactura: 'P-1',
        proveedorId: 'p1',
        proveedorNif: 'B87654321',
        proveedorNombre: 'Proveedor SL',
        desgloseIva: [
          { tipoIva: 21, base: 100, cuota: 21 },
          { tipoIva: 10, base: 50, cuota: 5 },
        ],
      },
      db as never,
    );
    expect(libroIva.map((r) => [r.tipoLibro, r.tipoIva, r.cuotaIva])).toEqual([
      ['RECIBIDAS', 21, 21],
      ['RECIBIDAS', 10, 5],
    ]);
  });
});
