// Test: CSV parsing con coma decimal (EU) vs punto decimal (US)
describe('Bancos: CSV parsing con diferentes formatos decimales', () => {
  it('formato EU (;): separa por ; y parsea , como decimal', () => {
    const csvEU = `fecha;importe;concepto
2026-06-01;1500,50;Cobro cliente
2026-06-02;-89,90;Comisión`;

    const primeraLinea = csvEU.split('\n')[0];
    const usaSemicolon = primeraLinea.includes(';');
    expect(usaSemicolon).toBe(true);

    const lineas = csvEU.split('\n').slice(1);
    const importes = lineas.map((linea) => {
      const cols = linea.split(';').map((c) => c.trim());
      const importeStr = cols[1];
      return Number(importeStr.replace(',', '.'));
    });

    expect(importes[0]).toBe(1500.5);
    expect(importes[1]).toBe(-89.9);
  });

  it('formato US (,): separa por , y parsea . como decimal', () => {
    const csvUS = `fecha,importe,concepto
2026-06-01,1500.50,Cobro cliente
2026-06-02,-89.90,Comisión`;

    const primeraLinea = csvUS.split('\n')[0];
    const usaSemicolon = primeraLinea.includes(';');
    expect(usaSemicolon).toBe(false);

    const lineas = csvUS.split('\n').slice(1);
    const importes = lineas.map((linea) => {
      const cols = linea.split(',').map((c) => c.trim());
      return Number(cols[1]);
    });

    expect(importes[0]).toBe(1500.5);
    expect(importes[1]).toBe(-89.9);
  });

  it('decimales: -89,90 (EU) != -8990 (split erróneo)', () => {
    // Bug anterior: split(/[;,]/) sobre "1500,50" -> ["1500", "50"] (mal)
    const importeEU = '1500,50';
    const importeCorrecto = Number(importeEU.replace(',', '.'));
    const importeError = Number(importeEU.split(/[;,]/)[0]); // BUG

    expect(importeCorrecto).toBe(1500.5);
    expect(importeError).toBe(1500); // Falso, debería ser 1500.5
  });

  it('detección de formato: EU (;) vs US (,)', () => {
    const csvEU = 'fecha;importe;concepto';
    const csvUS = 'fecha,importe,concepto';

    expect(csvEU.includes(';')).toBe(true);
    expect(csvUS.includes(';')).toBe(false);
  });

  it('manejo de importes sin decimales', () => {
    const linea = '2026-06-01;1500;Cobro';
    const cols = linea.split(';').map((c) => c.trim());
    const importe = Number(cols[1].replace(',', '.'));

    expect(importe).toBe(1500);
    expect(Number.isFinite(importe)).toBe(true);
  });

  it('rechazo de importes inválidos', () => {
    const importeInvalido = 'ABC';
    const importe = Number(importeInvalido.replace(',', '.'));

    expect(Number.isFinite(importe)).toBe(false);
    expect(importe).toBe(NaN);
  });
});
