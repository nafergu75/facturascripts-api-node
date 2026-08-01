// Mock de la factoria FS para buscarClientes.
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
// Asiento migrado a Prisma: capturamos journalEntry.create para asertar.
const mockJECreate = jest.fn(() => Promise.resolve({ id: 'je-test', numeroAsiento: 'TES-00001', descripcion: '', estado: 'POSTED', origen: 'TESORERIA' }));
// Clientes migrado a Prisma: buscarClientes usa prisma.customer.findMany.
const mockCustomerFindMany = jest.fn();
jest.mock('../config/database', () => ({
  prisma: {
    journalEntry: { create: mockJECreate, count: jest.fn(() => Promise.resolve(0)) },
    journalEntryLine: { create: jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve(a.data)) },
    customer: { findMany: mockCustomerFindMany },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

import { crearSerie, obtenerSeriePorDefecto, listarSeries, resolverCodSerieFactura } from '../services/series.service';
import { crearSubcuentaGastoEmpresa } from '../services/planContable.service';
import { calcularEstadoCobroConCobros, registrarCobro } from '../services/cobros.service';
import { buscarClientes } from '../services/clientes.service';

describe('Feature 1 - Series de factura', () => {
  const company = 'serie-co-1';

  it('marca una sola serie por defecto por tipo', async () => {
    await crearSerie(company, { codigo: 'B2026', descripcion: 'Nueva', tipoDocumento: 'FACTURA', activa: true, porDefecto: true });
    const series = await listarSeries(company, 'FACTURA');
    const porDefecto = series.filter((s) => s.porDefecto);
    expect(porDefecto).toHaveLength(1);
    expect(porDefecto[0].codigo).toBe('B2026');
  });

  it('resuelve el codserie por defecto cuando el DTO no trae serie', async () => {
    const cod = await resolverCodSerieFactura(company, {});
    expect(cod).toBe('B2026');
  });

  it('obtenerSeriePorDefecto siembra serie A si la empresa es nueva', async () => {
    const def = await obtenerSeriePorDefecto('serie-co-nueva', 'FACTURA');
    expect(def?.codigo).toBe('A');
  });
});

describe('Feature 2 - Subcuentas de gasto', () => {
  it('crea 6270001 a partir de la cuenta base 627', async () => {
    const sub = await crearSubcuentaGastoEmpresa('gasto-co', '627', 'Luz oficina');
    expect(sub.codigo).toBe('6270001');
    expect(sub.cuentaBaseCodigo).toBe('627');
  });

  it('autoincrementa el correlativo en la segunda subcuenta', async () => {
    const sub = await crearSubcuentaGastoEmpresa('gasto-co', '627', 'Luz almacen');
    expect(sub.codigo).toBe('6270002');
  });

  it('rechaza cuentas que no son de gasto', async () => {
    await expect(crearSubcuentaGastoEmpresa('gasto-co', '430', 'X')).rejects.toThrow();
  });
});

describe('Feature 3 - Estado de cobro', () => {
  it('pendiente sin cobros', () => {
    const e = calcularEstadoCobroConCobros({ idfactura: 'F1', total: 121 }, [], '2026-06-10');
    expect(e.estadoCobro).toBe('pendiente');
    expect(e.importePendiente).toBe(121);
  });

  it('vencida si pasa el vencimiento y sigue pendiente', () => {
    const e = calcularEstadoCobroConCobros({ idfactura: 'F2', total: 100, vencimiento: '2026-01-01' }, [], '2026-06-10');
    expect(e.estadoCobro).toBe('vencida');
  });

  it('parcial y luego cobrada al registrar cobros (via unica con asiento)', async () => {
    // El cobro unificado crea vencimiento + asiento de tesoreria: mockear FS.
    fsClientMock.getOne.mockResolvedValue({ idfactura: 'F3', total: 200, codcliente: '1' });
    fsClientMock.listWithMeta.mockResolvedValue({ items: [{ codejercicio: '2026', idempresa: 1, longsubcuenta: 10 }], total: 1 });
    fsClientMock.create.mockImplementation((recurso: string) =>
      recurso === 'asientos' ? Promise.resolve({ idasiento: 7 }) : Promise.resolve({ idsubcuenta: 1, idcuenta: 1 }),
    );

    mockJECreate.mockClear();
    const parcial = await registrarCobro('co', 'F3', 50, '2026-03-01');
    expect(parcial.estadoCobro).toBe('parcial');
    expect(parcial.importeCobrado).toBe(50);
    const total = await registrarCobro('co', 'F3', 150, '2026-03-05');
    expect(total.estadoCobro).toBe('cobrada');
    expect(total.importePendiente).toBe(0);
    expect(total.fechaUltimoCobro).toBe('2026-03-05');
    // VIA UNICA: el cobro directo TAMBIEN ha generado 2 asientos de tesoreria (Prisma).
    expect(mockJECreate).toHaveBeenCalledTimes(2);
  });
});

describe('Feature 4 - Buscador de clientes (Prisma)', () => {
  beforeEach(() => mockCustomerFindMany.mockReset());

  it('mapea el resultado de Prisma y delega el filtro (OR + take) a la BD', async () => {
    // El filtro lo aplica Prisma (where OR contains); el mock devuelve la fila ya filtrada.
    mockCustomerFindMany.mockResolvedValue([
      { id: '1', nombreFiscal: 'Construcciones Pepe', nifCif: 'B11111111', email: 'pepe@obra.com', telefono: '600111222', activo: true },
    ]);
    const r = await buscarClientes('co', 'pepe', 10);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: '1', nombre: 'Construcciones Pepe', nif: 'B11111111', telefono: '600111222' });
    // Se delega el filtro a Prisma con un OR por nombre/nif/email y el limit.
    const arg = mockCustomerFindMany.mock.calls[0][0];
    expect(arg.take).toBe(10);
    expect(Array.isArray(arg.where.OR)).toBe(true);
  });

  it('sin query no añade OR y respeta el limit', async () => {
    mockCustomerFindMany.mockResolvedValue([{ id: '1', nombreFiscal: 'A', nifCif: 'B1', email: null, telefono: null, activo: true }]);
    const r = await buscarClientes('co', '', 1);
    expect(r).toHaveLength(1);
    const arg = mockCustomerFindMany.mock.calls[0][0];
    expect(arg.take).toBe(1);
    expect(arg.where.OR).toBeUndefined();
  });
});
