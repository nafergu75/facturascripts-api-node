// Numero con que se guarda una factura de venta registrada desde un lector: el
// que aparece en ella (art. 63 RIVA), no la serie y el numero reconstruidos.
import { numeroCompletoLeido } from '../services/income-invoices.service';

describe('numeroCompletoLeido', () => {
  it('conserva los ceros y el separador de la factura', () => {
    expect(numeroCompletoLeido('F2026/0012', 'F2026')).toBe('F2026/0012');
    expect(numeroCompletoLeido('EXT-2026/7', 'EXT-2026')).toBe('EXT-2026/7');
    expect(numeroCompletoLeido(' FX-0007 ', 'FX')).toBe('FX-0007');
  });

  it('sin serie en la factura, delante va el ano que se le pone (la 15 de 2027 y la de 2028 no se llaman igual)', () => {
    expect(numeroCompletoLeido('0015', '2027')).toBe('2027-0015');
    expect(numeroCompletoLeido('15', '2028')).toBe('2028-15');
  });

  it('sin numero, o demasiado largo para guardarlo: null (se usa serie-numero)', () => {
    expect(numeroCompletoLeido(null, '2026')).toBeNull();
    expect(numeroCompletoLeido('   ', '2026')).toBeNull();
    expect(numeroCompletoLeido(`A${'1'.repeat(70)}`, 'A')).toBeNull();
  });
});
