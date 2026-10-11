// formatearHusoMadrid: fecha y hora con el huso de Madrid, como pide VERI*FACTU
// (FechaHoraHusoGenRegistro, spec verifactu 3.6). Nunca toISOString(): el
// servidor de Vercel va en UTC.
import { describe, it, expect } from '@jest/globals';
import { formatearHusoMadrid, hoyEspana } from '../utils/fechas';

describe('formatearHusoMadrid', () => {
  it('31-12-2026 23:30 UTC es ya el 1-1-2027 a las 00:30 en Madrid (+01:00)', () => {
    expect(formatearHusoMadrid(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01T00:30:00+01:00');
  });

  it('cambio de hora de octubre (25-10-2026): +02:00 antes y +01:00 después', () => {
    // 00:59 UTC = 02:59 CEST (verano); 01:00 UTC = 02:00 CET (invierno).
    expect(formatearHusoMadrid(new Date('2026-10-25T00:59:59Z'))).toBe('2026-10-25T02:59:59+02:00');
    expect(formatearHusoMadrid(new Date('2026-10-25T01:00:00Z'))).toBe('2026-10-25T02:00:00+01:00');
  });

  it('cambio de hora de marzo (28-03-2027): +01:00 antes y +02:00 después', () => {
    // 00:59 UTC = 01:59 CET; 01:00 UTC = 03:00 CEST (la hora 02 no existe ese día).
    expect(formatearHusoMadrid(new Date('2027-03-28T00:59:59Z'))).toBe('2027-03-28T01:59:59+01:00');
    expect(formatearHusoMadrid(new Date('2027-03-28T01:00:00Z'))).toBe('2027-03-28T03:00:00+02:00');
  });

  it('medianoche sale como 00, nunca como 24', () => {
    expect(formatearHusoMadrid(new Date('2027-01-04T23:00:00Z'))).toBe('2027-01-05T00:00:00+01:00');
  });

  it('el día del texto coincide con hoyEspana', () => {
    const instante = new Date('2026-12-31T23:00:00Z');
    expect(formatearHusoMadrid(instante).slice(0, 10)).toBe(hoyEspana(instante));
  });
});
