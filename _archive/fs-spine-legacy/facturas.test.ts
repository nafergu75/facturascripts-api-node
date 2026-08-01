// Mock de la factoria FS para capturar los params traducidos a la API de FS.
const fsClientMock = {
  listWithMeta: jest.fn().mockResolvedValue({
    items: [{ idfactura: 10, codigo: 'FAC1', codcliente: '1', fecha: '2026-06-10', total: 121 }],
    total: 1,
  }),
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

// Ruta legacy /facturas (FS facturaclientes) retirada en el cleanup del spine FS:
// se prueba el servicio (facturasService.list) directamente; mantiene la cobertura
// del mapeo de query a la API de FacturaScripts. La auth de ruta va en otros tests.
import { facturasService } from '../services/facturas.service';

beforeEach(() => fsClientMock.listWithMeta.mockClear());

describe('facturasService.list (mapeo de query a FacturaScripts)', () => {
  it('mapea page/pageSize/desde/hasta/clienteCodigo a la query real de FS', async () => {
    const res = (await facturasService.list('1', {
      page: '2',
      pageSize: '10',
      desde: '2026-01-01',
      hasta: '2026-12-31',
      clienteCodigo: '1',
    })) as { items: unknown[]; total: number };

    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);

    const [resource, fsParams] = fsClientMock.listWithMeta.mock.calls[0];
    expect(resource).toBe('facturaclientes');
    expect(fsParams).toMatchObject({
      limit: 10,
      offset: 10, // (page 2 - 1) * 10
      'filter[fecha_gte]': '2026-01-01',
      'filter[fecha_lte]': '2026-12-31',
      'filter[codcliente]': '1',
      'sort[fecha]': 'DESC',
    });
  });
});
