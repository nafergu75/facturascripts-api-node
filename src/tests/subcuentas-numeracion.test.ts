/**
 * Numeracion de las subcuentas de clientes y proveedores (sin BD).
 */
import { describe, it, expect } from '@jest/globals';
import {
  codigoSubcuenta,
  esSubcuentaDeTercero,
  esSubcuentaGenerica,
  longitudEnUso,
  longitudSubcuentasValida,
  numeroDeSubcuenta,
  siguienteNumeroTercero,
} from '../services/terceros/numeracion';

describe('siguienteNumeroTercero', () => {
  it('sin nada ocupado empieza en 1 (el 0 es la generica)', () => {
    expect(siguienteNumeroTercero([], ['430'], 8)).toBe(1);
    expect(siguienteNumeroTercero(['430', '43000000'], ['430'], 8)).toBe(1);
  });

  it('no rellena huecos: mayor ocupado + 1', () => {
    expect(siguienteNumeroTercero(['43000001', '43000007'], ['430'], 8)).toBe(8);
  });

  it('en proveedores, la 400N ocupada bloquea tambien la 410N y al reves', () => {
    expect(siguienteNumeroTercero(['40000003'], ['400', '410'], 8)).toBe(4);
    expect(siguienteNumeroTercero(['41000005', '40000002'], ['400', '410'], 8)).toBe(6);
  });

  it('los codigos de otra longitud no cuentan para el maximo', () => {
    expect(siguienteNumeroTercero(['4300000099', '4300099'], ['430'], 8)).toBe(1);
  });

  it('clientes y proveedores van por separado', () => {
    expect(siguienteNumeroTercero(['43000009'], ['400', '410'], 8)).toBe(1);
    expect(siguienteNumeroTercero(['40000009'], ['430'], 8)).toBe(1);
  });

  it('agotado el rango de 7 digitos, 400 con un mensaje claro', () => {
    expect(() => siguienteNumeroTercero(['4309999'], ['430'], 7)).toThrow(/No quedan subcuentas libres de 7 dígitos/);
    expect(siguienteNumeroTercero(['4309998'], ['430'], 7)).toBe(9999);
  });
});

describe('codigos', () => {
  it('codigoSubcuenta rellena con ceros hasta la longitud', () => {
    expect(codigoSubcuenta('430', 12, 8)).toBe('43000012');
    expect(codigoSubcuenta('410', 7, 10)).toBe('4100000007');
    expect(() => codigoSubcuenta('430', 10000, 7)).toThrow(/no cabe/);
  });

  it('numeroDeSubcuenta', () => {
    expect(numeroDeSubcuenta('43000012')).toBe(12);
    expect(numeroDeSubcuenta('430')).toBeNull();
  });

  it('generica y de tercero', () => {
    for (const g of ['430', '4300', '43000000', '400', '4100000000']) expect(esSubcuentaGenerica(g)).toBe(true);
    expect(esSubcuentaGenerica('43000001')).toBe(false);
    expect(esSubcuentaDeTercero('43000001')).toBe(true);
    expect(esSubcuentaDeTercero('43000000')).toBe(false);
    expect(esSubcuentaDeTercero('4310001')).toBe(false);
  });

  it('longitud valida 7-10, por defecto 8', () => {
    expect(longitudSubcuentasValida(7)).toBe(7);
    expect(longitudSubcuentasValida(10)).toBe(10);
    expect(longitudSubcuentasValida(6)).toBe(8);
    expect(longitudSubcuentasValida('9')).toBe(8);
    expect(longitudSubcuentasValida(undefined)).toBe(8);
  });

  it('longitudEnUso: la mas habitual entre las subcuentas de tercero de 7 a 10 digitos', () => {
    expect(longitudEnUso([])).toBeNull();
    expect(longitudEnUso(['430', '430000', '430001'])).toBeNull();
    expect(longitudEnUso(['4300000001', '4000000002', '43000001'])).toBe(10);
    expect(longitudEnUso(['7000001', '43000001'])).toBe(8);
  });
});
