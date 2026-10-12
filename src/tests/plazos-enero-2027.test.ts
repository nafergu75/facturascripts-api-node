/**
 * Ensayo del arranque de 2027 (spec arranque-2027, apartado D): el 2 de enero
 * de 2027 y el cambio de año a las 00:30 de Madrid (23:30 UTC del 31-12).
 * Reloj falso solo para Date: los temporizadores siguen siendo los de verdad.
 */
import { anioEspana, hoyEspana } from '../utils/fechas';
import { fechaVencimientoModelo, vistaCalendario } from '../services/impuestosModulo.service';
import { OPCIONES_CALENDARIO_POR_DEFECTO } from '../domain/calendarioFiscal';
import { proximosPlazos } from '../services/carmen/faq/calendario';
import { relojEn, relojReal } from './reloj-falso';

afterEach(relojReal);

describe('cambio de año a las 00:30 de Madrid', () => {
  it('a las 00:30 del 1-1-2027 en Madrid ya es 2027 (en UTC aún es 2026)', () => {
    relojEn('2026-12-31T23:30:00Z');
    expect(new Date().getUTCFullYear()).toBe(2026);
    expect(hoyEspana()).toBe('2027-01-01');
    expect(anioEspana()).toBe(2027);
  });

  it('a las 23:30 del 31-12-2026 en Madrid sigue siendo 2026', () => {
    relojEn('2026-12-31T22:30:00Z');
    expect(hoyEspana()).toBe('2026-12-31');
    expect(anioEspana()).toBe(2026);
  });
});

describe('plazos de enero con hoy = 2027-01-02', () => {
  const HOY = '2027-01-02';
  const cal2026 = vistaCalendario(2026, OPCIONES_CALENDARIO_POR_DEFECTO, HOY);
  const de = (codigo: string, periodo: string) => cal2026.find((m) => m.codigo === codigo && m.periodo === periodo)!;

  it('111 y 115 del 4T vencen el 20-1-2027, no el 30', () => {
    expect(de('111', '4T').fechaVencimiento).toBe('2027-01-20');
    expect(de('115', '4T').fechaVencimiento).toBe('2027-01-20');
  });

  it('303 y 349 del 4T, 390, 190 y 180 de 2026 vencen el lunes 1-2-2027', () => {
    for (const [codigo, periodo] of [['303', '4T'], ['349', '4T'], ['390', '0A'], ['190', '0A'], ['180', '0A']]) {
      expect({ codigo, fecha: de(codigo, periodo).fechaVencimiento }).toEqual({ codigo, fecha: '2027-02-01' });
    }
  });

  it('347 de 2026 el 1-3-2027 y 200 de 2026 el 26-7-2027', () => {
    expect(de('347', '0A').fechaVencimiento).toBe('2027-03-01');
    expect(de('200', '0A').fechaVencimiento).toBe('2027-07-26');
  });

  it('nada de lo de enero sale como expirado el día 2', () => {
    const pendientes = cal2026.filter((m) => m.fechaVencimiento >= HOY);
    expect(pendientes.every((m) => m.estado === 'vigente')).toBe(true);
    expect(de('303', '3T').estado).toBe('expirado');
  });

  it('el 31-1-2027 (domingo) el 303 del 4T sigue en plazo; el 2-2 ya no', () => {
    expect(vistaCalendario(2026, OPCIONES_CALENDARIO_POR_DEFECTO, '2027-01-31').find((m) => m.codigo === '303' && m.periodo === '4T')!.estado).toBe('vigente');
    expect(vistaCalendario(2026, OPCIONES_CALENDARIO_POR_DEFECTO, '2027-02-01').find((m) => m.codigo === '303' && m.periodo === '4T')!.estado).toBe('vigente');
    expect(vistaCalendario(2026, OPCIONES_CALENDARIO_POR_DEFECTO, '2027-02-02').find((m) => m.codigo === '303' && m.periodo === '4T')!.estado).toBe('expirado');
  });

  it('1T de 2027 (303, 111, 115 y 349) y primer pago del 202: 20-4-2027', () => {
    for (const codigo of ['303', '111', '115', '349']) expect(fechaVencimientoModelo(codigo, 2027, '1T')).toBe('2027-04-20');
    expect(fechaVencimientoModelo('202', 2027, '1P')).toBe('2027-04-20');
  });

  it('Carmen da los mismos plazos: el próximo es el 111 del 4T, el 20-1-2027', () => {
    const [primero] = proximosPlazos(HOY, 1);
    expect(primero).toMatchObject({ fecha: '2027-01-20', ejercicio: 2026, periodo: '4T' });
    expect(['111', '115']).toContain(primero.modelo);
    expect(proximosPlazos(HOY, 1, '390')[0].fecha).toBe('2027-02-01');
  });
});
