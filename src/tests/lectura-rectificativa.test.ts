/**
 * Lector de gastos con una rectificativa o un abono (sección 12 de la
 * especificación de abonos), sin BD: la causa que sale del motivo leído y
 * cuándo se propone «por diferencias» o «por sustitución».
 */
jest.mock('../config/database', () => ({ prisma: {} }));

import { describe, it, expect } from '@jest/globals';
import { causaDeMotivo, tipoPropuesto } from '../services/lectura/rectificativa';

describe('causa propuesta por el motivo leído', () => {
  it.each([
    ['Devolución de mercancía', 'DEVOLUCION'],
    ['Mercancía devuelta por rotura', 'DEVOLUCION'],
    ['Rappel anual por volumen', 'RAPPEL'],
    ['Descuento por pronto pago', 'PRONTO_PAGO'],
    ['Descuento comercial', 'DESCUENTO'],
    ['Bonificación pactada', 'DESCUENTO'],
    ['Corrección del IVA aplicado', 'ERROR_IVA'],
    ['Tipo impositivo erróneo', 'ERROR_IVA'],
  ])('«%s» → %s', (motivo, causa) => {
    expect(causaDeMotivo(motivo)).toBe(causa);
  });

  it('sin motivo, o con uno que no la deja clara: hay que elegirla', () => {
    expect(causaDeMotivo(null)).toBeNull();
    expect(causaDeMotivo('  ')).toBeNull();
    expect(causaDeMotivo('Según lo hablado')).toBeNull();
    // «iva» dentro de otra palabra no cuenta.
    expect(causaDeMotivo('Rectificación definitiva')).toBeNull();
  });
});

describe('por diferencias o por sustitución', () => {
  it('con importes en negativo: por diferencias', () => {
    expect(tipoPropuesto({ negativos: true, totalLeido: -121, totalOriginal: 1210 })).toBe('I');
    expect(tipoPropuesto({ negativos: true, totalLeido: -121, totalOriginal: null })).toBe('I');
  });

  it('en positivo no se propone nada, salvo que pase del 50 % de la original: por sustitución', () => {
    expect(tipoPropuesto({ negativos: false, totalLeido: 242, totalOriginal: 363 })).toBe('S');
    expect(tipoPropuesto({ negativos: false, totalLeido: 242, totalOriginal: 484 })).toBeNull();
    expect(tipoPropuesto({ negativos: false, totalLeido: 100, totalOriginal: 1000 })).toBeNull();
    expect(tipoPropuesto({ negativos: false, totalLeido: 242, totalOriginal: null })).toBeNull();
    expect(tipoPropuesto({ negativos: false, totalLeido: null, totalOriginal: 363 })).toBeNull();
  });
});
