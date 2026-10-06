/**
 * Calculos puros de cobros y pagos (sin BD): pendiente y estado de la factura.
 */
import { describe, it, expect } from '@jest/globals';
import { calcularPendiente, estadoTrasCobros } from '../services/cobrosPagos.service';

describe('estado de cobro de una factura de venta', () => {
  const f = { totalFactura: 121, fechaVencimiento: '2026-06-30' };
  it('sin cobros y sin vencer: PENDING; vencida: OVERDUE', () => {
    expect(estadoTrasCobros('INGRESO', f, 0, '2026-06-01')).toBe('PENDING');
    expect(estadoTrasCobros('INGRESO', f, 0, '2026-07-01')).toBe('OVERDUE');
  });
  it('cobro parcial: sigue PENDING u OVERDUE segun el vencimiento', () => {
    expect(estadoTrasCobros('INGRESO', f, 100, '2026-06-01')).toBe('PENDING');
    expect(estadoTrasCobros('INGRESO', f, 100, '2026-07-01')).toBe('OVERDUE');
  });
  it('cobrada entera (al centimo): PAID', () => {
    expect(estadoTrasCobros('INGRESO', f, 121, '2026-07-01')).toBe('PAID');
    expect(estadoTrasCobros('INGRESO', { totalFactura: 0.3, fechaVencimiento: '2026-01-01' }, 0.1 + 0.2)).toBe('PAID');
  });
});

describe('estado de pago de una factura de gasto', () => {
  const f = { totalFactura: 484, fechaVencimiento: '2026-03-01' };
  it('PENDIENTE, PARCIAL y PAGADA', () => {
    expect(estadoTrasCobros('GASTO', f, 0)).toBe('PENDIENTE');
    expect(estadoTrasCobros('GASTO', f, 84)).toBe('PARCIAL');
    expect(estadoTrasCobros('GASTO', f, 484)).toBe('PAGADA');
  });
});

describe('pendiente de una factura', () => {
  it('total menos lo cobrado, redondeado al centimo', () => {
    expect(calcularPendiente('INGRESO', 1210, 'PENDING', 500.1)).toBe(709.9);
    expect(calcularPendiente('GASTO', 484, 'PARCIAL', 84)).toBe(400);
  });
  it('una venta marcada como cobrada antes de existir los cobros cuenta como cobrada', () => {
    expect(calcularPendiente('INGRESO', 1210, 'PAID', 0)).toBe(0);
    // Con cobros registrados manda lo cobrado.
    expect(calcularPendiente('INGRESO', 1210, 'PAID', 1000)).toBe(210);
    // ACCOUNTED (contabilizada antes del cambio) sigue pendiente.
    expect(calcularPendiente('INGRESO', 1210, 'ACCOUNTED', 0)).toBe(1210);
  });
});
