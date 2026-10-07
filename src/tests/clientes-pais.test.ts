// Pais y moneda preferida del cliente: el pais decide el tipo de operacion de
// IVA que se sugiere; la moneda solo la propone el formulario de la factura.
jest.mock('../config/database', () => {
  const prisma: Record<string, unknown> = {
    incomeInvoice: { updateMany: jest.fn(async () => ({ count: 2 })) },
    customer: {
      findFirst: jest.fn(),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'c1', activo: true, ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'c1',
        nombreFiscal: 'Cliente',
        nifCif: 'B46123456',
        activo: true,
        pais: 'ES',
        ...data,
      })),
    },
  };
  prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});

import { prisma } from '../config/database';
import { clientesService, leerMonedaPreferida, leerPais, paisTrasModificar } from '../services/clientes.service';

const db = prisma as unknown as {
  customer: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  incomeInvoice: { updateMany: jest.Mock };
};

describe('leerPais', () => {
  it('normaliza a ISO-2 (ISO-3, EL y UK) y rechaza lo que no es un codigo', () => {
    expect(leerPais('us')).toBe('US');
    expect(leerPais('FRA')).toBe('FR');
    expect(leerPais('EL')).toBe('GR');
    expect(leerPais('UK')).toBe('GB');
    expect(() => leerPais('Francia')).toThrow(/dos letras/);
  });

  it('un codigo que no es un pais (SP pensando en Espana) o el nombre (España) da 400: el cliente no pasa por extranjero', () => {
    for (const p of ['SP', 'sp', 'EU', 'XX']) expect(() => leerPais(p)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/no existe/) }));
    expect(() => leerPais('España')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => leerPais('SP', 'B46123456')).toThrow(/no existe/);
  });

  it('una ficha antigua con SP se puede guardar sin tocar el pais', () => {
    expect(paisTrasModificar({ pais: 'SP', nifCif: 'B46123456' }, 'SP', undefined)).toBeUndefined();
    expect(paisTrasModificar({ pais: 'SP', nifCif: 'B46123456' }, 'ES', undefined)).toBe('ES');
  });

  it('sin pais (o ES) y con NIF-IVA de otro Estado de la UE, el del prefijo', () => {
    expect(leerPais(undefined, 'FR40303265045')).toBe('FR');
    expect(leerPais('ES', 'DE123456789')).toBe('DE');
    expect(leerPais('', 'B46123456')).toBeUndefined();
    expect(leerPais('US', 'FR40303265045')).toBe('US');
  });
});

describe('leerMonedaPreferida', () => {
  it('EUR o USD, o null; las desactivadas dan 400', () => {
    expect(leerMonedaPreferida('usd')).toBe('USD');
    expect(leerMonedaPreferida('')).toBeNull();
    expect(leerMonedaPreferida(null)).toBeNull();
    expect(() => leerMonedaPreferida('GBP')).toThrow(/EUR, USD/);
  });
});

describe('clientesService', () => {
  it('alta con pais, direccion y moneda preferida; la respuesta los devuelve', async () => {
    const c = (await clientesService.create('1', {
      nombreFiscal: 'Coffee LLC',
      nifCif: '84-1234567',
      pais: 'US',
      direccion: '245 Wythe Avenue',
      cp: 'NY 11249',
      municipio: 'Brooklyn',
      monedaPreferida: 'USD',
    })) as Record<string, unknown>;
    expect(db.customer.create.mock.calls[0][0].data).toMatchObject({ pais: 'US', cp: 'NY 11249', monedaPreferida: 'USD' });
    expect(c).toMatchObject({ pais: 'US', municipio: 'Brooklyn', monedaPreferida: 'USD' });
  });

  it('sin pais: Espana', async () => {
    db.customer.create.mockClear();
    await clientesService.create('1', { nombreFiscal: 'Panaderia', nifCif: 'B46123456' });
    expect(db.customer.create.mock.calls[0][0].data).toMatchObject({ pais: 'ES', monedaPreferida: null });
  });

  it('al modificar se puede cambiar el pais y quitar la moneda preferida', async () => {
    db.customer.findFirst.mockResolvedValue({ id: 'c1', pais: 'ES', nifCif: 'B46123456' });
    await clientesService.update('1', 'c1', { pais: 'MX', monedaPreferida: '' });
    expect(db.customer.update.mock.calls[0][0].data).toMatchObject({ pais: 'MX', monedaPreferida: null });
  });

  it('antes de cambiar el pais se congela el de antes en sus facturas sin tipo de operacion', async () => {
    db.customer.update.mockClear();
    db.incomeInvoice.updateMany.mockClear();
    db.customer.findFirst.mockResolvedValue({ id: 'c1', pais: 'ES', nifCif: 'B46123456' });
    await clientesService.update('1', 'c1', { pais: 'US' });
    expect(db.incomeInvoice.updateMany).toHaveBeenCalledWith({
      where: { companyId: '1', customerId: 'c1', tipoOperacion: null, paisClienteLegacy: null, estadoDocumento: { not: 'PROFORMA' } },
      data: { paisClienteLegacy: 'ES' },
    });
    expect(db.customer.update.mock.calls[0][0].data).toMatchObject({ pais: 'US' });
  });

  it('guardar la ficha sin tocar el pais no lo reescribe ni congela nada', async () => {
    db.customer.update.mockClear();
    db.incomeInvoice.updateMany.mockClear();
    // ES con NIF-IVA frances (cliente anterior): se guarda la direccion y el pais se queda en ES.
    db.customer.findFirst.mockResolvedValue({ id: 'c1', pais: 'ES', nifCif: 'FR12345678901' });
    await clientesService.update('1', 'c1', { pais: 'ES', nifCif: 'FR12345678901', direccion: 'Rue 1' });
    expect(db.customer.update.mock.calls[0][0].data).not.toHaveProperty('pais');
    expect(db.incomeInvoice.updateMany).not.toHaveBeenCalled();
    // 'FRA' importado de FacturaScripts: el formulario manda 'FR' y se queda 'FRA'.
    db.customer.findFirst.mockResolvedValue({ id: 'c1', pais: 'FRA', nifCif: 'FR12345678901' });
    await clientesService.update('1', 'c1', { pais: 'FR', direccion: 'Rue 2' });
    expect(db.customer.update.mock.calls[1][0].data).not.toHaveProperty('pais');
    expect(db.incomeInvoice.updateMany).not.toHaveBeenCalled();
  });
});

describe('paisTrasModificar', () => {
  const existe = { pais: 'ES', nifCif: 'B46123456' };
  it('undefined si no cambia (aunque se escriba distinto); el nuevo si cambia', () => {
    expect(paisTrasModificar(existe, 'es', undefined)).toBeUndefined();
    expect(paisTrasModificar({ pais: 'FRA', nifCif: 'FR1' }, 'FR', undefined)).toBeUndefined();
    expect(paisTrasModificar(existe, undefined, undefined)).toBeUndefined();
    expect(paisTrasModificar(existe, 'US', undefined)).toBe('US');
    // Cambia el NIF a uno con prefijo de otro Estado de la UE: el pais del prefijo.
    expect(paisTrasModificar(existe, undefined, 'DE123456789')).toBe('DE');
    expect(paisTrasModificar(existe, 'ES', 'DE123456789')).toBe('DE');
    expect(() => paisTrasModificar(existe, 'Francia', undefined)).toThrow(/dos letras/);
  });
});
