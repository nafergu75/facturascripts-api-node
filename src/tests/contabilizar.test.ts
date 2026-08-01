// Mock de la BD (Prisma) y de la factoria FS para probar la orquestacion completa
// factura -> asiento sin depender de FacturaScripts ni MySQL.
// Asiento migrado a Prisma: capturamos los mocks para asertar la persistencia.
const mockJECreate = jest.fn(() => Promise.resolve({ id: 'je-test', numeroAsiento: 'FAC-ING-00001', descripcion: '', estado: 'POSTED', origen: 'FACTURA_INGRESO' }));
const mockJLCreate = jest.fn((a: { data: Record<string, unknown> }) => Promise.resolve(a.data));
jest.mock('../config/database', () => ({
  prisma: {
    journalEntry: { create: mockJECreate, count: jest.fn(() => Promise.resolve(0)) },
    journalEntryLine: { create: mockJLCreate },
  },
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

// FsClient simulado: factura con 1 linea (base 300 @ 21%), sin plan contable
// (fuerza el get-or-create de cuentas/subcuentas).
const fsClientMock = {
  getOne: jest.fn(async (resource: string) => {
    if (resource === 'facturaclientes') {
      return {
        idfactura: 5,
        codigo: 'F2026A1',
        codcliente: '1',
        fecha: '2026-06-10',
        codpago: 'CONT',
        idempresa: 1,
        codejercicio: '2026',
      };
    }
    return {};
  }),
  listWithMeta: jest.fn(async (resource: string) => {
    switch (resource) {
      case 'lineafacturaclientes':
        return { items: [{ pvptotal: 300, iva: 21, cantidad: 2, pvpunitario: 150, descripcion: 'Servicio' }], total: 1 };
      case 'ejercicios':
        return { items: [{ longsubcuenta: 10 }], total: 1 };
      default: // subcuentas / cuentas -> vacio (se crean)
        return { items: [], total: 0 };
    }
  }),
  create: jest.fn(async (resource: string) => {
    switch (resource) {
      case 'cuentas':
        return { idcuenta: 1 };
      case 'subcuentas':
        return { idsubcuenta: Math.floor(Math.random() * 1000) + 1 };
      case 'asientos':
        return { idasiento: 10, concepto: 'Factura venta F2026A1 1' };
      case 'partidas':
        return { idpartida: 1 };
      default:
        return {};
    }
  }),
  update: jest.fn(),
  remove: jest.fn(),
};

jest.mock('../services/facturascripts-client', () => ({
  getFsClientForCompany: jest.fn().mockResolvedValue(fsClientMock),
}));

// Las reglas contables ahora vienen de la BD; usamos las por defecto en el test.
jest.mock('../services/reglasContables.service', () => {
  const { reglasPorDefecto } = jest.requireActual('../domain/reglas-contables.model');
  return { obtenerReglas: jest.fn().mockResolvedValue(reglasPorDefecto()) };
});

// Ruta legacy /facturas/:id/contabilizar retirada en el cleanup del spine FS: se
// prueba el servicio directamente (lee la factura FS legacy -> crea el asiento en
// Prisma). La auth de ruta esta cubierta por otros tests (p.ej. clientes.test).
import { crearAsientoEnFacturascriptsDesdeFactura } from '../services/asientos.service';

describe('crearAsientoEnFacturascriptsDesdeFactura (factura FS -> asiento Prisma)', () => {
  it('genera el asiento (cliente 363 = ventas 300 + IVA 63) en Prisma', async () => {
    const r = (await crearAsientoEnFacturascriptsDesdeFactura('1', '5', 'venta')) as {
      resumen: { debeTotal: number; haberTotal: number; numApuntes: number };
    };
    expect(r.resumen.debeTotal).toBe(363);
    expect(r.resumen.haberTotal).toBe(363);
    expect(r.resumen.numApuntes).toBe(3); // cliente + ventas + IVA
    // el asiento se persiste en Prisma (JournalEntry + 3 lineas), no en FS
    expect(mockJECreate).toHaveBeenCalled();
    const lineas = mockJLCreate.mock.calls.map((c) => c[0].data);
    expect(lineas).toHaveLength(3);
    expect(lineas.map((l) => String(l.debe || l.haber))).toEqual(expect.arrayContaining(['363']));
  });
});
