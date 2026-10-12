/**
 * Fechas de los datos de prueba relativas a hoy (spec arranque-2027, B.19):
 * los scripts de datos demo ya no fijan 2026, así que en 2027 siguen dando
 * facturas y movimientos del año en curso y de los meses anteriores.
 */
import { describe, it, expect, afterEach } from '@jest/globals';
import { fechaHaceMeses } from '../utils/fechas';
import { relojEn, relojReal } from './reloj-falso';

describe('fechaHaceMeses', () => {
  afterEach(relojReal);

  it('mismo mes con meses = 0 y el mes anterior con meses = 1', () => {
    expect(fechaHaceMeses(0, 15, '2026-07-20')).toBe('2026-07-15');
    expect(fechaHaceMeses(1, 30, '2026-07-20')).toBe('2026-06-30');
  });

  it('cruza el cambio de año', () => {
    expect(fechaHaceMeses(1, 28, '2027-01-02')).toBe('2026-12-28');
    expect(fechaHaceMeses(9, 30, '2026-07-01')).toBe('2025-10-30');
  });

  it('un día que el mes no tiene pasa al último del mes (febrero, abril)', () => {
    expect(fechaHaceMeses(1, 30, '2027-03-10')).toBe('2027-02-28');
    expect(fechaHaceMeses(1, 31, '2028-03-10')).toBe('2028-02-29');
    expect(fechaHaceMeses(1, 31, '2026-05-01')).toBe('2026-04-30');
  });

  it('sin hoy, toma la fecha de Madrid: a las 00:30 del 1-1-2027 ya es enero', () => {
    relojEn('2026-12-31T23:30:00Z'); // 00:30 del 1-1-2027 en Madrid
    expect(fechaHaceMeses(0, 5)).toBe('2027-01-05');
    expect(fechaHaceMeses(1, 5)).toBe('2026-12-05');
  });
});
