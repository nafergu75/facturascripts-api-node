// Textos exactos de VERI*FACTU (spec verifactu, 3.4 y 3.6): importes, tipos,
// fechas y FechaHoraHusoGenRegistro. Puro, sin BD.
import { describe, it, expect } from '@jest/globals';
import {
  centimos,
  fechaAeat,
  fechaHoraHusoGenRegistro,
  formatearImporte,
  formatearTipo,
  instanteDeHuso,
} from '../services/verifactu/formato';

describe('formatearImporte', () => {
  it('dos decimales siempre, punto decimal y sin miles', () => {
    expect(formatearImporte(0)).toBe('0.00');
    expect(formatearImporte(centimos(1234567.8))).toBe('1234567.80');
    expect(formatearImporte(centimos(123.1))).toBe('123.10');
    expect(formatearImporte(centimos(0.05))).toBe('0.05');
    expect(formatearImporte(centimos(12.35))).toBe('12.35');
  });

  it('negativos con «-» y nunca «-0.00»', () => {
    expect(formatearImporte(centimos(-123.4))).toBe('-123.40');
    expect(formatearImporte(centimos(-0.004))).toBe('0.00');
    expect(formatearImporte(-0)).toBe('0.00');
  });

  it('el tope del XSD: 12 cifras enteras', () => {
    expect(formatearImporte(99_999_999_999_999)).toBe('999999999999.99');
    expect(formatearImporte(-99_999_999_999_999)).toBe('-999999999999.99');
    expect(() => formatearImporte(100_000_000_000_000)).toThrow(/12 cifras/);
    expect(() => formatearImporte(1.5)).toThrow(/no entero/);
  });

  it('cumple el patrón ImporteSgn12.2Type', () => {
    for (const c of [0, 1, -1, 10, 999, 123456, -98765432]) {
      expect(formatearImporte(c)).toMatch(/^(\+|-)?\d{1,12}(\.\d{0,2})?$/);
    }
  });
});

describe('formatearTipo', () => {
  it('patrón Tipo2.2Type', () => {
    expect(formatearTipo(21)).toBe('21.00');
    expect(formatearTipo(0)).toBe('0.00');
    expect(formatearTipo(5.5)).toBe('5.50');
    expect(formatearTipo(7.5)).toMatch(/^\d{1,3}(\.\d{0,2})?$/);
    expect(() => formatearTipo(-1)).toThrow();
  });
});

describe('fechaAeat', () => {
  it('AAAA-MM-DD -> dd-mm-aaaa', () => {
    expect(fechaAeat('2027-01-04')).toBe('04-01-2027');
    expect(fechaAeat('2024-02-29')).toBe('29-02-2024');
  });

  it('una fecha que no existe lanza', () => {
    expect(() => fechaAeat('2027-02-30')).toThrow();
    expect(() => fechaAeat('04-01-2027')).toThrow();
    expect(() => fechaAeat('')).toThrow();
  });
});

describe('FechaHoraHusoGenRegistro', () => {
  it('31-12-2026 23:30 UTC es el 1-1-2027 a las 00:30 en Madrid', () => {
    expect(fechaHoraHusoGenRegistro(new Date('2026-12-31T23:30:00Z'), null)).toBe('2027-01-01T00:30:00+01:00');
  });

  it('cambio de hora de octubre (25-10-2026): +02:00 antes y +01:00 después', () => {
    expect(fechaHoraHusoGenRegistro(new Date('2026-10-25T00:59:59Z'), null)).toBe('2026-10-25T02:59:59+02:00');
    expect(fechaHoraHusoGenRegistro(new Date('2026-10-25T01:00:00Z'), null)).toBe('2026-10-25T02:00:00+01:00');
  });

  it('cambio de hora de marzo (28-03-2027): +01:00 antes y +02:00 después', () => {
    expect(fechaHoraHusoGenRegistro(new Date('2027-03-28T00:59:59Z'), null)).toBe('2027-03-28T01:59:59+01:00');
    expect(fechaHoraHusoGenRegistro(new Date('2027-03-28T01:00:00Z'), null)).toBe('2027-03-28T03:00:00+02:00');
  });

  it('nunca va por detrás del registro anterior: si el anterior es posterior, su texto', () => {
    const anterior = '2027-01-04T10:15:02+01:00';
    expect(fechaHoraHusoGenRegistro(new Date('2027-01-04T09:00:00Z'), anterior)).toBe(anterior);
    // Mismo segundo: el mismo texto.
    expect(fechaHoraHusoGenRegistro(new Date('2027-01-04T09:15:02.700Z'), anterior)).toBe(anterior);
    // Posterior: la hora de ahora.
    expect(fechaHoraHusoGenRegistro(new Date('2027-01-04T09:15:03Z'), anterior)).toBe('2027-01-04T10:15:03+01:00');
  });

  it('el anterior se compara por instante, no por texto (cambio de hora)', () => {
    // 02:30 CEST (00:30 UTC) y despues 02:10 CET (01:10 UTC): el segundo es posterior aunque el texto «baje».
    expect(fechaHoraHusoGenRegistro(new Date('2026-10-25T01:10:00Z'), '2026-10-25T02:30:00+02:00')).toBe('2026-10-25T02:10:00+01:00');
  });

  it('instanteDeHuso exige el formato con huso', () => {
    expect(instanteDeHuso('2027-01-01T00:30:00+01:00').toISOString()).toBe('2026-12-31T23:30:00.000Z');
    expect(() => instanteDeHuso('2027-01-01T00:30:00Z')).toThrow();
    expect(() => instanteDeHuso('2027-01-01 00:30:00+01:00')).toThrow();
  });
});
