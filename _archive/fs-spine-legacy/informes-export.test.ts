// Tras ADR-002 Paso 3, todo lee de Prisma, no de FacturaScripts:
//  - exportarA3 -> asientos POSTED (`journalEntry`)
//  - libro de IVA y P&G -> facturas (`incomeInvoice` ventas / `expenseInvoice` gastos)
jest.mock('../config/database', () => ({
  prisma: {
    journalEntry: {
      findMany: jest.fn(async () => [
        {
          id: 'a1',
          fecha: new Date(Date.UTC(2026, 1, 10)),
          numeroAsiento: '1',
          descripcion: 'Asiento test',
          estado: 'POSTED',
          lineas: [{ accountCode: '4300000001', debe: 1760, haber: 0 }],
        },
      ]),
    },
    incomeInvoice: {
      findMany: jest.fn(async () => [
        {
          numeroCompleto: 'F1',
          fechaEmision: '2026-02-10',
          estado: 'PENDING',
          baseTotal: 1500,
          customer: { nifCif: 'B1', nombreFiscal: 'Cli', pais: 'ES' },
          lineas: [
            { tipoIva: 21, baseLine: 1000, ivaImporte: 210 },
            { tipoIva: 10, baseLine: 500, ivaImporte: 50 },
          ],
        },
      ]),
    },
    expenseInvoice: {
      findMany: jest.fn(async () => [
        {
          numeroCompleto: 'G1',
          fechaEmision: '2026-03-15',
          estado: 'CONFIRMED',
          baseTotal: 300,
          supplier: { nifCif: 'B2', nombreFiscal: 'Prov', pais: 'ES' },
          lineas: [{ tipoIva: 21, baseLine: 300, ivaImporte: 63 }],
        },
      ]),
    },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));
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

import { exportarLibroIvaCSV, exportarPerdidasGananciasCSV, exportarA3 } from '../services/informesExport.service';

/** Mock de FS: 1 venta con 2 tipos de IVA + 1 compra, con sus lineas. */
function prepararFacturas(): void {
  fsClientMock.listWithMeta.mockImplementation((recurso: string) => {
    if (recurso === 'facturaclientes') {
      return Promise.resolve({ items: [{ idfactura: 1, codigo: 'F1', cifnif: 'B1', nombrecliente: 'Cli', fecha: '10-02-2026', codcliente: '1' }], total: 1 });
    }
    if (recurso === 'lineafacturaclientes') {
      return Promise.resolve({ items: [
        { idfactura: 1, pvptotal: 1000, iva: 21 },
        { idfactura: 1, pvptotal: 500, iva: 10 },
      ], total: 2 });
    }
    if (recurso === 'facturaproveedores') {
      return Promise.resolve({ items: [{ idfactura: 9, codigo: 'G1', cifnif: 'B2', nombre: 'Prov', fecha: '15-03-2026', codproveedor: 'P1' }], total: 1 });
    }
    if (recurso === 'lineafacturaproveedores') {
      return Promise.resolve({ items: [{ idfactura: 9, pvptotal: 300, iva: 21 }], total: 1 });
    }
    if (recurso === 'asientos') {
      return Promise.resolve({ items: [{ idasiento: 1, numero: 1, fecha: '2026-02-10', concepto: 'Asiento test' }], total: 1 });
    }
    if (recurso === 'partidas') {
      return Promise.resolve({ items: [{ idasiento: 1, codsubcuenta: '4300000001', debe: 1760, haber: 0, concepto: 'c' }], total: 1 });
    }
    return Promise.resolve({ items: [], total: 0 });
  });
}

describe('Informes y exportaciones', () => {
  beforeEach(() => prepararFacturas());

  it('libro de IVA de ingresos: una fila por factura y tipo de IVA (año completo)', async () => {
    const csv = await exportarLibroIvaCSV('co', 2026, 'ingresos');
    const filas = csv.trim().split('\r\n');
    expect(filas[0]).toContain('base_imponible;tipo_iva;cuota_iva');
    expect(filas).toHaveLength(3); // cabecera + 2 tipos de IVA de F1
    expect(filas.some((f) => f.includes('1000.00;21;210.00'))).toBe(true);
    expect(filas.some((f) => f.includes('500.00;10;50.00'))).toBe(true);
    expect(csv).not.toContain('G1'); // las compras no van al libro de ingresos
  });

  it('libro de IVA de gastos: solo compras', async () => {
    const csv = await exportarLibroIvaCSV('co', 2026, 'gastos');
    expect(csv).toContain('G1');
    expect(csv).toContain('300.00;21;63.00');
    expect(csv).not.toContain('F1');
  });

  it('P&G por mes con fila TOTAL (filtra por periodo)', async () => {
    const csv = await exportarPerdidasGananciasCSV('co', 2026, { desde: '2026-01-01', hasta: '2026-12-31' });
    const filas = csv.trim().split('\r\n');
    expect(filas[0]).toBe('mes;ingresos;gastos;resultado');
    expect(filas.some((f) => f.startsWith('2026-02;1500.00;0.00;1500.00'))).toBe(true);
    expect(filas.some((f) => f.startsWith('2026-03;0.00;300.00;-300.00'))).toBe(true);
    expect(filas[filas.length - 1]).toBe('TOTAL;1500.00;300.00;1200.00');
  });

  it('export A3: una linea de ancho fijo por apunte (fecha+cuenta+concepto+debe+haber)', async () => {
    const dat = await exportarA3('co', 2026);
    const lineas = dat.trim().split('\r\n');
    expect(lineas).toHaveLength(1);
    expect(lineas[0].startsWith('20260210')).toBe(true); // fecha yyyymmdd
    expect(lineas[0]).toContain('4300000001');
    expect(lineas[0].endsWith('000000000176000' + '000000000000000')).toBe(true); // debe 1760.00, haber 0
  });
});
