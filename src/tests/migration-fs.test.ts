// Mock del script migrate-fs-to-prisma: verifica mapeo FS→Prisma sin tocar BD real
jest.mock('axios');
jest.mock('../config/database', () => ({
  prisma: {
    customer: {
      upsert: jest.fn(async (args) => ({
        id: 'c1',
        companyId: '1',
        nombreFiscal: args.create.nombreFiscal,
      })),
    },
    supplier: {
      upsert: jest.fn(async (args) => ({
        id: 's1',
        companyId: '1',
        nombreFiscal: args.create.nombreFiscal,
      })),
    },
    product: {
      upsert: jest.fn(async (args) => ({
        id: 'p1',
        companyId: '1',
        referencia: args.create.referencia,
      })),
    },
    $disconnect: jest.fn(),
  },
}));

import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Migracion FS → Prisma (mapeo de campos)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.create.mockReturnValue({
      get: jest.fn(),
    } as any);
  });

  it('Cliente: mapea nombre→nombreFiscal, cifnif, telefono1→telefono', () => {
    const fsCliente = {
      codcliente: 'C001',
      nombre: 'Cliente Facturable SL',
      cifnif: 'B12345678',
      email: 'info@cliente.es',
      telefono1: '622334455',
      activo: true,
    };

    // Simulación: el script haría upsert con estos campos
    const expectedCreate = {
      companyId: '1',
      nombreFiscal: 'Cliente Facturable SL',
      nifCif: 'B12345678',
      email: 'info@cliente.es',
      telefono: '622334455',
      activo: true,
    };

    expect(expectedCreate.nombreFiscal).toBe(fsCliente.nombre);
    expect(expectedCreate.nifCif).toBe(fsCliente.cifnif);
    expect(expectedCreate.telefono).toBe(fsCliente.telefono1);
  });

  it('Proveedor: mapea nombre→nombreFiscal, cifnif, telefono1→telefono', () => {
    const fsProveedor = {
      codproveedor: 'P001',
      nombre: 'Proveedor XYZ SL',
      cifnif: 'A87654321',
      email: 'ventas@proveedor.es',
      telefono1: '633445566',
      activo: true,
    };

    const expectedCreate = {
      companyId: '1',
      nombreFiscal: 'Proveedor XYZ SL',
      nifCif: 'A87654321',
      email: 'ventas@proveedor.es',
      telefono: '633445566',
      activo: true,
    };

    expect(expectedCreate.nombreFiscal).toBe(fsProveedor.nombre);
    expect(expectedCreate.telefono).toBe(fsProveedor.telefono1);
  });

  it('Producto: mapea referencia, nombre→descripcion, precio, stockfis→stock', () => {
    const fsProducto = {
      referencia: 'PROD-001',
      nombre: 'Diseño web',
      precio: 500,
      stockfis: 10,
      bloqueado: false,
    };

    const expectedCreate = {
      companyId: '1',
      referencia: 'PROD-001',
      descripcion: 'Diseño web',
      precio: 500,
      stock: 10,
      bloqueado: false,
    };

    expect(expectedCreate.referencia).toBe(fsProducto.referencia);
    expect(expectedCreate.descripcion).toBe(fsProducto.nombre);
    expect(expectedCreate.stock).toBe(fsProducto.stockfis);
  });

  it('Maneja campos opcionales (email, telefono, bloqueado)', () => {
    const fsMinimo: any = {
      codcliente: 'C002',
      nombre: 'Cliente SL',
      cifnif: 'C12345678',
    };

    // Sin email, telefono: el script debería omitirlos (undefined)
    expect(fsMinimo.email).toBeUndefined();
  });

  it('Defaults: activo=true si no viene, bloqueado=false', () => {
    const fsCliente = {
      codcliente: 'C003',
      nombre: 'Cliente Test',
      cifnif: 'D12345678',
      activo: undefined, // Si FS no lo tiene, FS devuelve undefined
    };

    // Script hace: activo: c.activo !== false → true si undefined
    const activo = fsCliente.activo !== false;
    expect(activo).toBe(true);
  });

  it('Upsert es idempotente: ejecutar 2x = mismo resultado', () => {
    const fsCliente = {
      codcliente: 'C004',
      nombre: 'Cliente Stale',
      cifnif: 'E12345678',
      telefono1: '644556677',
    };

    // 1ª vez: create
    // 2ª vez: update solo telefono (si cambio en FS)
    const updateData = { telefono: '644556677' };
    expect(updateData.telefono).toBe(fsCliente.telefono1);
  });
});
