/**
 * Tablas de campos de los disenos de registro OFICIALES (349, 180, 202) y el
 * formateo de campos comun: cada tabla cubre su registro entero sin huecos ni
 * solapes, y los campos se escriben como dicen los disenos de la AEAT.
 */
import { describe, it, expect } from '@jest/globals';
import { DISENO_180, DISENO_202, DISENO_349 } from '../domain/aeat/disenos';
import { componerRegistroDr, erroresTablaDr, formatearCampoDr, registroDe, type CampoDr } from '../aeat/common/disenoRegistro';
import { nifDerecha, telefonoAeat, textoAeat } from '../aeat/common/normalizacion';

describe('tablas de los disenos oficiales', () => {
  it.each([
    ['349', DISENO_349, { declarante: 500, operador: 500, rectificacion: 500 }],
    ['180', DISENO_180, { declarante: 500, perceptor: 500 }],
    ['202', DISENO_202, { cabecera: 328, pagina01: 700, pagina02: 900, cierre: 18 }],
  ])('el %s cubre cada registro entero', (_m, diseno, longitudes) => {
    expect(Object.fromEntries(diseno.registros.map((r) => [r.id, r.longitud]))).toEqual(longitudes);
    for (const r of diseno.registros) expect(erroresTablaDr(r)).toEqual([]);
  });

  it('los ids de campo no se repiten dentro de un registro', () => {
    for (const d of [DISENO_349, DISENO_180, DISENO_202]) {
      for (const r of d.registros) {
        const ids = r.campos.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('el 202 suma 1.946 caracteres con sus cuatro trozos', () => {
    expect(DISENO_202.registros.reduce((a, r) => a + r.longitud, 0)).toBe(1946);
  });
});

describe('formato de campos', () => {
  const num: CampoDr = { pos: 1, lon: 6, tipo: 'Num', id: 'x', descripcion: '', decimales: 2 };
  const conSigno: CampoDr = { ...num, tipo: 'N' };
  const alfa: CampoDr = { pos: 1, lon: 12, tipo: 'An', id: 'a', descripcion: '' };

  it('importes en centimos, a la derecha y con ceros', () => {
    expect(formatearCampoDr(num, 12.5)).toBe('001250');
    expect(formatearCampoDr(num, 0)).toBe('000000');
    expect(formatearCampoDr(num, undefined)).toBe('000000');
  });

  it('Num no admite negativos; N los lleva con una N delante', () => {
    expect(() => formatearCampoDr(num, -1)).toThrow(/negativos/);
    expect(formatearCampoDr(conSigno, -12.5)).toBe('N01250');
  });

  it('un importe que no cabe es un error, no se recorta', () => {
    expect(() => formatearCampoDr(num, 10000)).toThrow(/no cabe/);
  });

  it('texto en mayusculas, sin acentos ni signos, con la Ñ y la Ç', () => {
    expect(textoAeat('Peñíscola Açores, S.L.')).toBe('PEÑISCOLA AÇORES SL');
    expect(formatearCampoDr(alfa, 'muñoz')).toBe('MUÑOZ       ');
    expect(textoAeat('S/N', { admite: './-' })).toBe('S/N');
  });

  it('un registro con un campo que no existe en el diseno es un error', () => {
    expect(() => componerRegistroDr(registroDe(DISENO_349, 'declarante'), { noExiste: 1 })).toThrow(/no tiene los campos/);
  });

  it('NIF a la derecha con ceros y sin el prefijo ES', () => {
    expect(nifDerecha('es-b12.345.678')).toBe('B12345678');
    expect(nifDerecha('1234567Z')).toBe('01234567Z');
    expect(nifDerecha('')).toBe('');
  });

  it('telefono de 9 cifras sin +34', () => {
    expect(telefonoAeat('+34 963 12 34 56')).toBe('963123456');
    expect(telefonoAeat('0034963123456')).toBe('963123456');
    expect(telefonoAeat('12345')).toBe('');
  });
});
