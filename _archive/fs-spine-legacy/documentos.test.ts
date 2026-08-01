// Verifica que pedidos/albaranes/presupuestos mapean al recurso FS correcto
// y reutilizan el mismo filtrado/paginacion que facturas.
const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({ items: [{ codigo: 'X1' }], total: 1 }),
  getOne: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
};

jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

jest.mock('../config/database', () => ({
  prisma: {},
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

// Rutas legacy /pedidos, /albaranes, /presupuestos, /inventario retiradas en F-D
// del cleanup del spine FS: se prueba directamente los servicios (leen del FS legacy).
import { pedidosService } from '../services/pedidos.service';
import { albaranesService } from '../services/albaranes.service';
import { presupuestosService } from '../services/presupuestos.service';

const casos: Array<[string, (cid: string, p: Record<string, unknown>) => Promise<unknown>]> = [
  ['pedidos -> pedidoclientes', (cid, p) => pedidosService.list(cid, p)],
  ['albaranes -> albaranclientes', (cid, p) => albaranesService.list(cid, p)],
  ['presupuestos -> presupuestoclientes', (cid, p) => presupuestosService.list(cid, p)],
];

describe('Documentos de venta (servicios pedidos/albaranes/presupuestos)', () => {
  beforeEach(() => fsClientMock.listWithMeta.mockClear());

  it.each(casos)('%s mapea al recurso FS correcto con filtros', async (desc, svc) => {
    const res = (await svc('1', { page: '1', pageSize: '15', desde: '2026-01-01', clienteCodigo: '1' })) as {
      items: unknown[];
    };

    expect(res.items).toHaveLength(1);

    const [resourceArg, fsParams] = fsClientMock.listWithMeta.mock.calls[0];
    const recursoEsperado = desc.split(' -> ')[1];
    expect(resourceArg).toBe(recursoEsperado);
    expect(fsParams).toMatchObject({
      limit: 15,
      offset: 0,
      'filter[fecha_gte]': '2026-01-01',
      'filter[codcliente]': '1',
      'sort[fecha]': 'DESC',
    });
  });
});
