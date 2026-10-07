// Pais y moneda preferida del cliente: el pais decide el tipo de operacion de
// IVA que se sugiere; la moneda solo la propone el formulario de la factura.
jest.mock('../config/database', () => ({
  prisma: {
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
  },
}));

import { prisma } from '../config/database';
import { clientesService, leerMonedaPreferida, leerPais } from '../services/clientes.service';

const db = prisma as unknown as {
  customer: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
};

describe('leerPais', () => {
  it('normaliza a ISO-2 (ISO-3, EL y UK) y rechaza lo que no es un codigo', () => {
    expect(leerPais('us')).toBe('US');
    expect(leerPais('FRA')).toBe('FR');
    expect(leerPais('EL')).toBe('GR');
    expect(leerPais('UK')).toBe('GB');
    expect(() => leerPais('Francia')).toThrow(/dos letras/);
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
});
