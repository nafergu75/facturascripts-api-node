import {
  generarFichero303Validado,
  generarFichero390Validado,
  generarFichero349Validado,
  generarFichero111Validado,
  generarFichero115Validado,
  generarFichero200Validado,
} from '../aeat';
import { PeriodoFiscal } from '../domain/impuestos.model';

const periodo2T: PeriodoFiscal = {
  ejercicio: 2026,
  periodo: '2T',
  tipo: 'trimestral',
  fechaInicio: '2026-04-01',
  fechaFin: '2026-06-30',
};

describe('Framework AEAT (Punto 1) - validacion Zod + delegacion al generador', () => {
  it('303: valida y genera fichero de 1581 chars con NIF en posicion', () => {
    const f = generarFichero303Validado({
      nif: 'B12345678',
      razonSocial: 'MI EMPRESA SL',
      datos: {
        periodo: periodo2T,
        ivaDevengado: [{ tipo: 21, base: 1000, cuota: 210 }],
        totalBaseDevengada: 1000,
        totalCuotaDevengada: 210,
        ivaDeducible: [],
        totalBaseDeducible: 0,
        totalCuotaDeducible: 0,
        resultado: 210,
      },
    });
    const reg = f.replace(/\r\n$/, '');
    expect(reg).toHaveLength(1581);
    expect(reg.slice(13, 22)).toBe('B12345678'); // NIF pos 14
  });

  it('303: rechaza NIF invalido (Zod)', () => {
    expect(() =>
      generarFichero303Validado({
        nif: 'malo',
        datos: {
          periodo: periodo2T,
          ivaDevengado: [],
          totalBaseDevengada: 0,
          totalCuotaDevengada: 0,
          ivaDeducible: [],
          totalBaseDeducible: 0,
          totalCuotaDeducible: 0,
          resultado: 0,
        },
      }),
    ).toThrow();
  });

  it('390: genera fichero validado', () => {
    const f = generarFichero390Validado({
      nif: 'B12345678',
      ejercicio: 2026,
      datos: {
        ejercicio: 2026,
        resumenDevengado: [],
        resumenDeducible: [],
        totalCuotaDevengada: 210,
        totalCuotaDeducible: 0,
        resultadoAnual: 210,
        volumenOperaciones: 1000,
      },
    });
    expect(f.length).toBeGreaterThan(0);
  });

  it('349: valida operaciones (clave E/A) y genera', () => {
    const f = generarFichero349Validado({
      nif: 'B12345678',
      datos: {
        periodo: periodo2T,
        operaciones: [{ cifnif: 'DE123456789', nombre: 'CLIENTE UE', clave: 'E', base: 5000 }],
        totalBase: 5000,
      },
    });
    expect(f.split('\r\n').filter((r) => r.length)[0]).toHaveLength(500);
  });

  it('349: rechaza clave invalida (Zod)', () => {
    expect(() =>
      generarFichero349Validado({
        nif: 'B12345678',
        datos: { periodo: periodo2T, operaciones: [{ cifnif: 'X', nombre: 'X', clave: 'Z', base: 1 }], totalBase: 1 },
      }),
    ).toThrow();
  });

  it('111: genera fichero validado', () => {
    const f = generarFichero111Validado({
      nif: 'B12345678',
      denominacion: 'MI EMPRESA SL',
      datos: {
        periodo: periodo2T,
        nPerceptoresTrabajo: 3,
        percepcionesTrabajo: 9000,
        retencionesTrabajo: 1500,
        totalRetenciones: 1500,
        resultadoIngresar: 1500,
      },
    });
    expect(f.length).toBeGreaterThan(0);
  });

  it('115: genera fichero validado', () => {
    const f = generarFichero115Validado({
      nif: 'B12345678',
      datos: {
        periodo: periodo2T,
        nPerceptores: 1,
        baseRetenciones: 1000,
        retenciones: 190,
        resultadoAnteriores: 0,
        resultadoIngresar: 190,
      },
    });
    expect(f.length).toBeGreaterThan(0);
  });

  it('200: valida NIF/ejercicio y genera fichero', () => {
    const f = generarFichero200Validado({ nif: 'B12345678', ejercicio: 2026, opts: { razonSocial: 'MI EMPRESA SL' } });
    expect(f.length).toBeGreaterThan(0);
  });
});
