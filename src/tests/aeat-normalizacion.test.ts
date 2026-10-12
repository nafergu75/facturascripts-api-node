/**
 * B2: una sola normalización para todos los modelos de la AEAT.
 */
import {
  ADMITE_CORREO,
  ADMITE_LITERAL,
  errorNifDeclarante,
  ibanAeat,
  importeAeat,
  motivoNifNoValido,
  nifDerecha,
  separarNifIva,
  telefonoAeat,
  textoAeat,
} from '../aeat/common/normalizacion';
import { formatearCampoDr, type CampoDr } from '../aeat/common/disenoRegistro';
import { formatearImporte } from '../aeat/oficial/diseno';

describe('textoAeat', () => {
  it('mayúsculas, sin acentos, con la Ñ y la Ç, sin puntos y sin signos', () => {
    expect(textoAeat('Muñoz & Cía., S.L.')).toBe('MUÑOZ CIA SL');
    expect(textoAeat("Façana d'Or")).toBe('FAÇANA DOR');
    expect(textoAeat('Peña Ibáñez, José-María')).toBe('PEÑA IBAÑEZ JOSE MARIA');
    expect(textoAeat('  Üñ   ç  ')).toBe('UÑ Ç');
    expect(textoAeat(null)).toBe('');
  });

  it('cada diseño puede admitir más caracteres', () => {
    expect(textoAeat('s/n km. 3-b', { admite: ADMITE_LITERAL })).toBe('S/N KM. 3-B');
    expect(textoAeat('s/n km. 3-b')).toBe('S N KM 3 B');
    expect(textoAeat('info@empresa.es', { admite: ADMITE_CORREO })).toBe('INFO@EMPRESA.ES');
  });
});

describe('NIF', () => {
  it('limpia, comprueba el control y alinea a la derecha', () => {
    expect(nifDerecha('es-a10952364')).toBe('A10952364');
    expect(nifDerecha('1234567L')).toBe('01234567L');
    expect(motivoNifNoValido('A10952364')).toBeNull();
    expect(motivoNifNoValido('A10952365')).toMatch(/dígito de control/);
    expect(motivoNifNoValido('12345678A')).toMatch(/letra/);
    expect(motivoNifNoValido('A10952364', { persona: true })).toMatch(/sociedad/);
    expect(errorNifDeclarante('')).toMatch(/Registro Mercantil > Datos/);
    expect(errorNifDeclarante('B11111111')).toMatch(/\(B11111111\) no es válido/);
  });

  it('NIF-IVA comunitario: país y número (EL para Grecia)', () => {
    expect(separarNifIva('FR 40 303 265 045')).toEqual({ pais: 'FR', numero: '40303265045' });
    expect(separarNifIva('123456789', 'GR')).toEqual({ pais: 'EL', numero: '123456789' });
    expect(separarNifIva('ESA10952364')).toBeNull();
    expect(separarNifIva('123456789', 'US')).toBeNull();
  });
});

describe('IBAN y teléfono', () => {
  it('el IBAN pasa el mod-97', () => {
    expect(ibanAeat('ES91 2100 0418 4502 0005 1332')).toBe('ES9121000418450200051332');
    expect(ibanAeat('ES92 2100 0418 4502 0005 1332')).toBeNull();
    expect(ibanAeat('')).toBeNull();
  });

  it('teléfono de 9 cifras sin el +34', () => {
    expect(telefonoAeat('+34 963 123 456')).toBe('963123456');
    expect(telefonoAeat('0034963123456')).toBe('963123456');
    expect(telefonoAeat('12345')).toBe('');
  });
});

describe('importes con signo N', () => {
  it('céntimos a la derecha con ceros; N delante si es negativo', () => {
    expect(importeAeat(1234.5, 17)).toBe('00000000000123450');
    expect(importeAeat(-1234.5, 17, { signo: true })).toBe('N0000000000123450');
    expect(() => importeAeat(-1, 17)).toThrow(/negativos/);
    expect(() => importeAeat(1e15, 17)).toThrow(/no cabe/);
  });

  it('los tres motores escriben igual el mismo importe', () => {
    const campoDr: CampoDr = { pos: 1, lon: 17, tipo: 'N', id: 'x', descripcion: 'x', decimales: 2 };
    expect(formatearCampoDr(campoDr, -98.76)).toBe(importeAeat(-98.76, 17, { signo: true }));
    expect(formatearImporte({ tipo: 'N', len: 17, desc: 'x' }, -98.76)).toBe(importeAeat(-98.76, 17, { signo: true }));
  });
});
