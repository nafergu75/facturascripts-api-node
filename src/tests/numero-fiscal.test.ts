/**
 * Nombre del numero fiscal de un cliente o proveedor segun su pais (la tabla
 * del servidor; la de las pantallas es la misma, en web/lib/fiscal.ts) y las
 * formas de un NIF espanol y de los NIF-IVA de la UE sin prefijo.
 */
import {
  nombreNumeroFiscal,
  nombrePaisEs,
  numeroFiscalEnFrase,
  pareceNifEspanol,
  prefijoNifIvaDePais,
  tieneFormaNifIvaUe,
} from '../domain/numero-fiscal';

describe('nombreNumeroFiscal', () => {
  it.each([
    ['ES', 'NIF'],
    ['', 'NIF'],
    [null, 'NIF'],
    ['FR', 'NIF-IVA (VAT)'],
    ['DE', 'NIF-IVA (VAT)'],
    ['EL', 'NIF-IVA (VAT)'],
    ['DO', 'RNC'],
    ['DOM', 'RNC'],
    ['US', 'EIN'],
    ['MX', 'RFC'],
    ['AR', 'CUIT'],
    ['CL', 'RUT'],
    ['UY', 'RUT'],
    ['CO', 'NIT'],
    ['PE', 'RUC'],
    ['EC', 'RUC'],
    ['VE', 'RIF'],
    ['BR', 'CNPJ'],
    ['MA', 'ICE'],
    ['GB', 'VAT number'],
    ['UK', 'VAT number'],
    ['CH', 'UID (VAT)'],
    ['JP', 'Número fiscal (Tax ID)'],
    ['HK', 'Número fiscal (Tax ID)'],
  ])('%s -> %s', (pais, nombre) => {
    expect(nombreNumeroFiscal(pais)).toBe(nombre);
  });

  it('en ingles (PDF de las empresas de fuera): VAT No. en la UE y Tax ID si no hay uno propio', () => {
    expect(nombreNumeroFiscal('FR', 'en')).toBe('VAT No.');
    expect(nombreNumeroFiscal('JP', 'en')).toBe('Tax ID');
    expect(nombreNumeroFiscal('US', 'en')).toBe('EIN');
  });

  it('dentro de una frase, el generico va en minuscula', () => {
    expect(`Falta el ${numeroFiscalEnFrase('JP')} del cliente.`).toBe('Falta el número fiscal (Tax ID) del cliente.');
    expect(`Falta el ${numeroFiscalEnFrase('DO')} del cliente.`).toBe('Falta el RNC del cliente.');
  });

  it('nombre del pais en castellano', () => {
    expect(nombrePaisEs('FR')).toBe('Francia');
    expect(nombrePaisEs('DO')).toBe('República Dominicana');
  });
});

describe('formas', () => {
  it('NIF espanol: DNI, NIE y CIF, con o sin ES y con separadores; un EIN, un RNC o un NIF-IVA no', () => {
    for (const nif of ['12345678Z', 'X1234567L', 'B12345674', 'ES B-12345674', '1234567L']) expect(pareceNifEspanol(nif)).toBe(true);
    for (const nif of ['12-3456789', '131123456', 'FR40303265045', '001234567000089', 'DEMA800101AB1', '']) expect(pareceNifEspanol(nif)).toBe(false);
  });

  it('NIF-IVA de cada Estado sin el prefijo', () => {
    expect(prefijoNifIvaDePais('GR')).toBe('EL');
    expect(prefijoNifIvaDePais('FR')).toBe('FR');
    expect(prefijoNifIvaDePais('ES')).toBeNull();
    expect(prefijoNifIvaDePais('US')).toBeNull();
    expect(tieneFormaNifIvaUe('FR', '40303265045')).toBe(true);
    expect(tieneFormaNifIvaUe('FR', '4030326504')).toBe(false);
    expect(tieneFormaNifIvaUe('DE', '123456789')).toBe(true);
    expect(tieneFormaNifIvaUe('DE', 'MA800101AB1')).toBe(false);
    expect(tieneFormaNifIvaUe('NL', '123456789B01')).toBe(true);
    expect(tieneFormaNifIvaUe('AT', 'U12345678')).toBe(true);
    expect(tieneFormaNifIvaUe('XX', '123')).toBe(false);
  });
});
