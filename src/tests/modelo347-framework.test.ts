import { generarLineaDeclarante347, generarLineaDeclarado347 } from '../aeat/modelo347/modelo347.encoder';
import { generarFichero347 } from '../aeat/modelo347/modelo347.file';
import { declarado347Schema } from '../aeat/modelo347/modelo347.schema';

describe('Modelo 347 framework (validacion Zod + encoder por diseno)', () => {
  it('Tipo 1: 500 chars, campos en posicion oficial', () => {
    const l = generarLineaDeclarante347({ nif: 'B12345678', razonSocial: 'MI EMPRESA SL', ejercicio: 2026, numPersonas: 2, importeTotal: 9000 });
    expect(l).toHaveLength(500);
    expect(l.slice(0, 4)).toBe('1347');
    expect(l.slice(4, 8)).toBe('2026'); // ejercicio pos 5
    expect(l.slice(8, 17)).toBe('B12345678'); // NIF pos 9
    expect(l.slice(135, 144)).toBe('000000002'); // numPersonas pos 136
    expect(l.slice(144, 160)).toBe(' 000000000900000'); // importe total pos 145 (signo+15)
  });

  it('Tipo 2: 500 chars, NIF declarado/clave/importe en posicion', () => {
    const l = generarLineaDeclarado347({ nifDeclarante: 'B12345678', nifDeclarado: 'A11111111', razonSocial: 'CLIENTE UNO', clave: 'B', importeAnual: 5000, ejercicio: 2026 });
    expect(l).toHaveLength(500);
    expect(l.slice(0, 4)).toBe('2347');
    expect(l.slice(17, 26)).toBe('A11111111'); // NIF declarado pos 18
    expect(l.slice(81, 82)).toBe('B'); // clave pos 82
    expect(l.slice(82, 98)).toBe(' 000000000500000'); // importe pos 83
  });

  it('valida con Zod: rechaza NIF y clave invalidos', () => {
    expect(() => declarado347Schema.parse({ nifDeclarante: 'B12345678', nifDeclarado: 'X', razonSocial: 'X', clave: 'Z', importeAnual: 1, ejercicio: 2026 })).toThrow();
    expect(() => generarLineaDeclarado347({ nifDeclarante: 'mal', nifDeclarado: 'A1', razonSocial: 'X', clave: 'A', importeAnual: 1, ejercicio: 2026 })).toThrow();
  });

  it('fichero completo: 1 tipo1 + N tipo2 separados por CRLF', () => {
    const f = generarFichero347(
      { nif: 'B12345678', razonSocial: 'MI EMPRESA SL', ejercicio: 2026, numPersonas: 2, importeTotal: 9000 },
      [
        { nifDeclarante: 'B12345678', nifDeclarado: 'A11111111', razonSocial: 'CLIENTE UNO', clave: 'B', importeAnual: 5000, ejercicio: 2026 },
        { nifDeclarante: 'B12345678', nifDeclarado: 'A22222222', razonSocial: 'PROV DOS', clave: 'A', importeAnual: 4000, ejercicio: 2026 },
      ],
    );
    const regs = f.split('\r\n').filter((r) => r.length);
    expect(regs).toHaveLength(3);
    expect(regs.every((r) => r.length === 500)).toBe(true);
  });
});
