// Validador del NIF espanol (DNI, NIE y CIF) con su caracter de control. Sin BD.
import { controlCif, errorNifPersona, esNifEspanolValido, letraDni, letraNif, normalizarNif, validarNifEspanol } from '../utils/nif';

describe('normalizarNif', () => {
  it('quita espacios, guiones, puntos y barras y pasa a mayusculas', () => {
    expect(normalizarNif(' a-10.952.364 ')).toBe('A10952364');
    expect(normalizarNif('b 98492259')).toBe('B98492259');
    expect(normalizarNif('12.345.678/z')).toBe('12345678Z');
  });

  it('quita el prefijo ES del NIF-IVA intracomunitario', () => {
    expect(normalizarNif('ESA10952364')).toBe('A10952364');
    expect(normalizarNif('ES 12345678Z')).toBe('12345678Z');
  });

  it('no toca un valor vacio o que no es texto', () => {
    expect(normalizarNif(undefined)).toBe('');
    expect(normalizarNif(null)).toBe('');
  });
});

describe('CIF (personas juridicas)', () => {
  it('acepta CIF reales con el digito de control bien', () => {
    expect(validarNifEspanol('A10952364')).toEqual({ valido: true, normalizado: 'A10952364', tipo: 'CIF' });
    expect(validarNifEspanol('B98492259')).toEqual({ valido: true, normalizado: 'B98492259', tipo: 'CIF' });
    expect(esNifEspanolValido('a-10952364')).toBe(true);
    expect(esNifEspanolValido('ESB98492259')).toBe(true);
  });

  it('rechaza un CIF con el digito de control cambiado', () => {
    for (const malo of ['A10952365', 'B98492258', 'B12345678']) {
      const r = validarNifEspanol(malo);
      expect(r.valido).toBe(false);
      expect(r.tipo).toBe('CIF');
      expect(r.motivo).toMatch(/dígito de control/);
    }
  });

  it('calcula el control como dice la norma: B1234567 -> 4 (D), A1095236 -> 4', () => {
    expect(controlCif('1234567')).toEqual({ cifra: '4', letra: 'D' });
    expect(controlCif('1095236')).toEqual({ cifra: '4', letra: 'D' });
    expect(controlCif('0000000')).toEqual({ cifra: '0', letra: 'J' });
  });

  it('A, B, E y H llevan cifra de control; P, Q, S, N y W llevan letra; el resto, cualquiera', () => {
    expect(esNifEspanolValido('B12345674')).toBe(true);
    expect(esNifEspanolValido('B1234567D')).toBe(false); // una S.L. no lleva letra
    expect(esNifEspanolValido('Q1234567D')).toBe(true);
    expect(esNifEspanolValido('Q12345674')).toBe(false); // un organismo publico no lleva cifra
    expect(esNifEspanolValido('G12345674')).toBe(true);
    expect(esNifEspanolValido('G1234567D')).toBe(true);
  });
});

describe('DNI y NIF de personas fisicas', () => {
  it('acepta un DNI con su letra y rechaza la letra equivocada', () => {
    expect(letraDni('12345678')).toBe('Z');
    expect(validarNifEspanol('12345678Z')).toEqual({ valido: true, normalizado: '12345678Z', tipo: 'DNI' });
    expect(validarNifEspanol('00000000T').valido).toBe(true);
    const malo = validarNifEspanol('12345678A');
    expect(malo.valido).toBe(false);
    expect(malo.motivo).toMatch(/letra/);
  });

  it('K, L y M (sin DNI) se calculan como el DNI con sus 7 cifras', () => {
    expect(esNifEspanolValido('K1234567L')).toBe(true);
    expect(esNifEspanolValido('M1234567L')).toBe(true);
    expect(esNifEspanolValido('L1234567X')).toBe(false);
  });
});

describe('NIE', () => {
  it('X, Y y Z valen 0, 1 y 2', () => {
    expect(validarNifEspanol('X1234567L')).toEqual({ valido: true, normalizado: 'X1234567L', tipo: 'NIE' });
    expect(esNifEspanolValido('Y1234567X')).toBe(true);
    expect(esNifEspanolValido('Z1234567R')).toBe(true);
    expect(esNifEspanolValido('X1234567T')).toBe(false);
  });
});

describe('formatos que no son un NIF', () => {
  it('rechaza vacios, largos raros y letras que no existen', () => {
    for (const malo of ['', '   ', 'A1095236', 'A109523644', '1234567Z', 'I10952364', 'AB0952364', 'hola', '123456789']) {
      const r = validarNifEspanol(malo);
      expect(r.valido).toBe(false);
      expect(r.motivo).toBeTruthy();
    }
  });
});

// Tras unir el validador de modo-admin (empresas) y el de nominas (trabajadores).
describe('un solo validador para empresas y trabajadores', () => {
  it('normalizarNif repone los ceros que Excel quita en DNI y NIE y cualquier signo', () => {
    expect(normalizarNif('1234567L')).toBe('01234567L');
    expect(normalizarNif('ES1234567L')).toBe('01234567L');
    expect(normalizarNif('x-1234567-l')).toBe('X1234567L');
    expect(normalizarNif('X123456L')).toBe('X0123456L');
    expect(normalizarNif('a_10952364')).toBe('A10952364');
    // Un DNI sin el cero se valida como el DNI completo.
    expect(validarNifEspanol('1234567L')).toEqual({ valido: true, normalizado: '01234567L', tipo: 'DNI' });
  });

  it('letraNif (numero) y letraDni (texto) dan la misma letra', () => {
    for (const n of [0, 1234567, 12345678, 99999999]) expect(letraNif(n)).toBe(letraDni(String(n)));
  });

  it('errorNifPersona usa el mismo control pero no admite un CIF', () => {
    expect(errorNifPersona('12345678Z')).toBeNull();
    expect(errorNifPersona('X1234567L')).toBeNull();
    expect(errorNifPersona('K1234567L')).toBeNull();
    expect(errorNifPersona('12345678A')).toMatch(/letra/);
    expect(errorNifPersona('X1234567T')).toMatch(/letra/);
    expect(errorNifPersona('A10952364')).toMatch(/sociedad/);
    expect(errorNifPersona('B12345678')).toMatch(/sociedad/);
    expect(errorNifPersona('1234')).toMatch(/formato/);
    expect(errorNifPersona('')).toBe('Falta el NIF.');
  });
});
