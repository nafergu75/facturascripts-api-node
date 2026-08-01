jest.mock('../config/database', () => ({ prisma: {}, connectDatabase: jest.fn(), disconnectDatabase: jest.fn() }));
const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};
jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

import { crearFacturaIngreso, crearFacturaRectificativa } from '../services/facturas.service';

beforeEach(() => {
  fsClientMock.create.mockReset();
  fsClientMock.update.mockReset();
  fsClientMock.getOne.mockReset();
  // listWithMeta: almacenes/formapagos/impuestos (defaults para crear factura)
  fsClientMock.listWithMeta.mockImplementation((rec: string) => {
    if (rec === 'almacenes') return Promise.resolve({ items: [{ codalmacen: 'ALG' }], total: 1 });
    if (rec === 'formapagos') return Promise.resolve({ items: [{ codpago: 'CONT' }], total: 1 });
    if (rec === 'impuestos') return Promise.resolve({ items: [{ codimpuesto: 'IVA21', iva: 21 }, { codimpuesto: 'IVA10', iva: 10 }], total: 2 });
    return Promise.resolve({ items: [], total: 0 });
  });
  // create: facturaclientes -> idfactura 100; lineas -> id; clientes -> codcliente
  fsClientMock.create.mockImplementation((rec: string) => {
    if (rec === 'facturaclientes') return Promise.resolve({ idfactura: 100, numero: 25, codigo: 'A25' });
    if (rec === 'clientes') return Promise.resolve({ codcliente: 'CNEW' });
    return Promise.resolve({ id: 1 });
  });
  // getOne: la ficha del cliente (FS denormaliza cifnif/nombrecliente en cabecera)
  fsClientMock.getOne.mockImplementation((rec: string) =>
    rec === 'clientes' ? Promise.resolve({ codcliente: '1', cifnif: 'B1', nombre: 'Cli' }) : Promise.resolve({}),
  );
  fsClientMock.update.mockImplementation((_r: string, _id: string, data: Record<string, unknown>) => Promise.resolve({ ...data, numero: 25, codigo: 'A25' }));
});

describe('Crear factura de ingreso (flujo Quipu sobre FacturaScripts)', () => {
  it('calcula base/IVA/retencion/total y crea cabecera+lineas+totales', async () => {
    const r = await crearFacturaIngreso('1', {
      customer: { id: '1' },
      serie: 'A',
      fechaEmision: '2030-05-10', // futura -> vencimiento no pasado -> PENDING
      lineas: [{ descripcion: 'Consultoria', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }],
      observaciones: 'gracias',
    });
    // 1000 base, 210 IVA, 150 IRPF, total = 1000+210-150 = 1060
    expect(r.baseTotal).toBe(1000);
    expect(r.ivaTotal).toBe(210);
    expect(r.retencionTotal).toBe(150);
    expect(r.totalFactura).toBe(1060);
    expect(r.numeroCompleto).toBe('A25');
    expect(r.estado).toBe('PENDING');
    expect(r.fechaVencimiento).toBe('2030-05-25'); // emision + 15 dias
    // cabecera + 1 linea creadas
    expect(fsClientMock.create).toHaveBeenCalledWith('facturaclientes', expect.objectContaining({ codcliente: '1', codserie: 'A' }));
    expect(fsClientMock.create).toHaveBeenCalledWith('lineafacturaclientes', expect.objectContaining({ idfactura: '100', pvptotal: 1000, iva: 21, irpf: 15 }));
    // totales fijados en la cabecera
    expect(fsClientMock.update).toHaveBeenCalledWith('facturaclientes', '100', expect.objectContaining({ neto: 1000, totaliva: 210, totalirpf: 150, total: 1060 }));
  });

  it('aplica descuento de linea y multiples tipos de IVA', async () => {
    const r = await crearFacturaIngreso('1', {
      customer: { id: '1' },
      lineas: [
        { descripcion: 'A', cantidad: 2, precioUnitario: 500, descuentoPorcentaje: 10, tipoIva: 21 }, // base 900, iva 189
        { descripcion: 'B', cantidad: 1, precioUnitario: 200, tipoIva: 10 }, // base 200, iva 20
      ],
    });
    expect(r.baseTotal).toBe(1100);
    expect(r.ivaTotal).toBe(209);
    expect(r.totalFactura).toBe(1309);
  });

  it('crea cliente nuevo al vuelo si no se pasa customer.id', async () => {
    const r = await crearFacturaIngreso('1', {
      customer: { nuevo: { nombreFiscal: 'Cliente SA', nifCif: 'B12345678', email: 'c@x.com' } },
      lineas: [{ descripcion: 'X', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    });
    expect(fsClientMock.create).toHaveBeenCalledWith('clientes', expect.objectContaining({ cifnif: 'B12345678', nombre: 'Cliente SA' }));
    expect(r.customerId).toBe('CNEW');
  });

  it('rectificativa: niega las lineas de la original y enlaza idfacturarect', async () => {
    fsClientMock.getOne.mockResolvedValue({ idfactura: 100, codigo: 'A25', codcliente: '1', codserie: 'A' });
    fsClientMock.listWithMeta.mockImplementation((rec: string) =>
      rec === 'lineafacturaclientes'
        ? Promise.resolve({ items: [{ idfactura: 100, descripcion: 'Consultoria', cantidad: 1, pvpunitario: 1000, dtopor: 0, iva: 21, irpf: 15 }], total: 1 })
        : Promise.resolve({ items: [], total: 0 }),
    );
    const r = await crearFacturaRectificativa('1', '100');
    expect(r.esRectificativa).toBe(true);
    expect(r.facturaOriginalId).toBe('100');
    // total negado: 1000 base -> -1000, total -1060
    expect(r.baseTotal).toBe(-1000);
    expect(r.totalFactura).toBe(-1060);
    expect(fsClientMock.create).toHaveBeenCalledWith('facturaclientes', expect.objectContaining({ idfacturarect: '100' }));
  });

  it('rechaza factura sin lineas', async () => {
    await expect(crearFacturaIngreso('1', { customer: { id: '1' }, lineas: [] })).rejects.toThrow(/al menos una linea/);
  });
});
