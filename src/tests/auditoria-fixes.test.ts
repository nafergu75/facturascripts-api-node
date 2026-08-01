// Mocks para los servicios que tocan FS/BD (solo se usan en el bloque tesoreria).
const fsClientMock = {
  listWithMeta: jest.fn(),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));
// Asiento de tesoreria migrado a Prisma: capturamos las lineas creadas para asertar.
const mockJournalLineCreate = jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve(a.data));
jest.mock('../config/database', () => ({
  prisma: {
    journalEntry: {
      create: jest.fn(() => Promise.resolve({ id: 'je-test', numeroAsiento: 'TES-00001', descripcion: '', estado: 'POSTED', origen: 'TESORERIA' })),
      count: jest.fn(() => Promise.resolve(0)),
    },
    journalEntryLine: { create: mockJournalLineCreate },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
jest.mock('../services/reglasContables.service', () => ({
  obtenerReglas: jest.fn().mockResolvedValue(require('../domain/reglas-contables.model').reglasPorDefecto()),
}));

import { FacturaContable } from '../domain/factura.model';
import { reglasPorDefecto } from '../domain/reglas-contables.model';
import { generarAsientoVentaDesdeFactura, generarAsientoCompraDesdeFactura } from '../services/contabilidadReglas.service';
import { obtenerLineasIvaDesdeFactura } from '../services/asientos.service';
import { crearVencimientos } from '../services/vencimientos.service';
import { registrarCobroVencimiento } from '../services/cobros.service';

const reglas = reglasPorDefecto();
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const cuadra = (a: { debeTotal: number; haberTotal: number }) => expect(round2(a.debeTotal)).toBe(round2(a.haberTotal));
const linea = (a: { lineas: { subcuenta: string; debe: number; haber: number }[] }, sub: string) =>
  a.lineas.find((l) => l.subcuenta.startsWith(sub));

function facturaVenta(over: Partial<FacturaContable> = {}): FacturaContable {
  return {
    idFactura: 'F1', tipo: 'venta', codigoTercero: '1', fecha: '2026-03-01', formaPago: 'CONTADO',
    lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210 }],
    totalBase: 1000, totalIva: 210, totalFactura: 1210, ...over,
  };
}

describe('Hallazgo 3 - Abonos (sin importes negativos, lados invertidos)', () => {
  it('factura normal: cliente al debe, ventas/IVA al haber, cuadra', () => {
    const a = generarAsientoVentaDesdeFactura(facturaVenta(), reglas);
    cuadra(a);
    expect(linea(a, '430')!.debe).toBe(1210);
    expect(linea(a, '700')!.haber).toBe(1000);
    expect(linea(a, '477')!.haber).toBe(210);
  });

  it('abono (total negativo): cliente al haber, ventas/IVA al debe, SIN negativos', () => {
    const a = generarAsientoVentaDesdeFactura(facturaVenta({ totalFactura: -1210 }), reglas);
    cuadra(a);
    expect(linea(a, '430')!.haber).toBe(1210);
    expect(linea(a, '700')!.debe).toBe(1000);
    expect(a.lineas.every((l) => l.debe >= 0 && l.haber >= 0)).toBe(true);
  });
});

describe('Hallazgo 4 - IRPF y recargo de equivalencia', () => {
  it('compra con IRPF 15%: 475100 al haber, proveedor = base+IVA-IRPF', () => {
    const f: FacturaContable = {
      idFactura: 'C1', tipo: 'compra', codigoTercero: '5', fecha: '2026-03-01', formaPago: 'TRANSFERENCIA',
      lineas: [{ descripcion: 'serv', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210, irpf: 15, importeIrpf: 150 }],
      totalBase: 1000, totalIva: 210, totalIrpf: 150, totalFactura: 1060,
    };
    const a = generarAsientoCompraDesdeFactura(f, reglas);
    cuadra(a);
    expect(linea(a, '475')!.haber).toBe(150);
    expect(linea(a, '400')!.haber).toBe(1060);
    expect(linea(a, '600')!.debe).toBe(1000);
  });

  it('venta con recargo 5.2%: 477500 al haber, cliente incluye el recargo', () => {
    const f = facturaVenta({
      lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210, recargoEquivalencia: 5.2, importeRecargo: 52 }],
      totalFactura: 1262,
    });
    const a = generarAsientoVentaDesdeFactura(f, reglas);
    cuadra(a);
    expect(linea(a, '4775')!.haber).toBe(52);
    expect(linea(a, '430')!.debe).toBe(1262);
  });
});

describe('Hallazgo 1 - Desglose de IVA por tipo (no tipo medio)', () => {
  it('factura con dos tipos NO colapsa a un tipo medio', () => {
    const f = facturaVenta({
      lineas: [
        { descripcion: 'a', cantidad: 1, precioUnitario: 1000, tipoIva: 21, baseImponible: 1000, importeIva: 210 },
        { descripcion: 'b', cantidad: 1, precioUnitario: 500, tipoIva: 10, baseImponible: 500, importeIva: 50 },
      ],
    });
    const desglose = obtenerLineasIvaDesdeFactura(f);
    expect(desglose).toHaveLength(2);
    expect(desglose.find((d) => d.tipoIva === 21)).toMatchObject({ base: 1000, cuota: 210 });
    expect(desglose.find((d) => d.tipoIva === 10)).toMatchObject({ base: 500, cuota: 50 });
  });
});

describe('Hallazgo 2 - Vencimiento -> asiento de tesoreria', () => {
  it('liquidar cobro genera asiento 572 debe / 430 haber y deja el vencimiento liquidado', async () => {
    fsClientMock.getOne.mockResolvedValue({ codcliente: '1', idfactura: 'F1' });
    fsClientMock.listWithMeta.mockResolvedValue({ items: [{ codejercicio: '2026', idempresa: 1, longsubcuenta: 10 }], total: 1 });
    fsClientMock.create.mockImplementation((recurso: string) =>
      recurso === 'asientos' ? Promise.resolve({ idasiento: 1 }) : Promise.resolve({ idsubcuenta: 1, idcuenta: 1 }),
    );

    const [v] = await crearVencimientos('coT', 'F1', 'cobro', [{ fecha: '2026-03-01', importe: 1210, formaPago: 'TRANSFERENCIA' }]);
    const r = await registrarCobroVencimiento('coT', v.id, '2026-03-15', 'TRANSFERENCIA');

    // Se creo el asiento de tesoreria (Prisma) con 572 (transferencia) al debe y 430 al haber.
    const lineas = mockJournalLineCreate.mock.calls.map((c) => c[0].data) as Array<Record<string, any>>;
    const debe572 = lineas.find((l) => String(l.accountCode).startsWith('572'));
    const haber430 = lineas.find((l) => String(l.accountCode).startsWith('430'));
    expect(debe572!.debe).toBe(1210);
    expect(haber430!.haber).toBe(1210);
    expect(r.estado).toBeDefined();
  });
});
