/**
 * Amortizacion lineal por dias (inmovilizado del arranque): cuota del mes,
 * meses que suman la cuota anual, alta a mitad de mes, baja, tope y bisiestos.
 */
import { describe, it, expect } from '@jest/globals';
import { cuotaAnual, cuotaDelMes, diasDelAnio, mesesEntre, pendienteDeAmortizar, valorNeto, type ActivoParaAmortizar } from '../services/arranque/amortizacion';

const torno: ActivoParaAmortizar = { coste: 10000, valorResidual: 0, amortAcumuladaInicial: 3000, coeficiente: 10, fechaInicioAmortizacion: '2027-01-01' };
const suma = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;

describe('amortización lineal por días', () => {
  it('la cuota anual es (coste - residual) x coeficiente', () => {
    expect(cuotaAnual(torno)).toBe(1000);
    expect(cuotaAnual({ ...torno, valorResidual: 2000 })).toBe(800);
  });

  it('cada mes va por días y los doce suman justo la cuota anual', () => {
    expect(cuotaDelMes(torno, '2027-01')).toBe(84.93); // 1000 x 31 / 365
    expect(cuotaDelMes(torno, '2027-02')).toBe(76.71); // 28 días
    const meses = mesesEntre('2027-01', '2027-12').map((m) => cuotaDelMes(torno, m));
    expect(meses).toHaveLength(12);
    expect(suma(meses)).toBe(1000);
  });

  it('en un año bisiesto el año tiene 366 días y también suma la cuota anual', () => {
    expect(diasDelAnio(2028)).toBe(366);
    expect(diasDelAnio(2027)).toBe(365);
    expect(cuotaDelMes(torno, '2028-02')).toBe(79.23); // 1000 x 29 / 366
    expect(suma(mesesEntre('2028-01', '2028-12').map((m) => cuotaDelMes(torno, m)))).toBe(1000);
  });

  it('un alta a mitad de mes amortiza solo desde ese día; antes, nada', () => {
    const silla = { ...torno, amortAcumuladaInicial: 0, fechaInicioAmortizacion: '2027-03-16' };
    expect(cuotaDelMes(silla, '2027-02')).toBe(0);
    expect(cuotaDelMes(silla, '2027-03')).toBe(43.84); // 16 días
    expect(cuotaDelMes(silla, '2027-04')).toBe(82.19); // 30 días
  });

  it('con baja, el mes de la baja va hasta ese día y después nada', () => {
    const vendido = { ...torno, fechaBaja: '2027-06-10' };
    expect(cuotaDelMes(vendido, '2027-06')).toBe(27.4); // 10 días
    expect(cuotaDelMes(vendido, '2027-07')).toBe(0);
  });

  it('nunca pasa de lo que queda por amortizar', () => {
    const casi = { ...torno, amortAcumuladaInicial: 9950 };
    expect(pendienteDeAmortizar(casi, 0)).toBe(50);
    expect(cuotaDelMes(casi, '2027-01')).toBe(50);
    expect(cuotaDelMes(casi, '2027-02', 50)).toBe(0);
    expect(cuotaDelMes({ ...torno, amortAcumuladaInicial: 9990 }, '2027-01', 0)).toBe(10);
  });

  it('sin coeficiente no amortiza; el valor neto descuenta lo acumulado y lo dotado', () => {
    expect(cuotaDelMes({ ...torno, coeficiente: 0 }, '2027-01')).toBe(0);
    expect(valorNeto(torno, 84.93)).toBe(6915.07);
  });

  it('los meses entre dos periodos cruzan el cambio de año', () => {
    expect(mesesEntre('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(mesesEntre('2027-03', '2027-02')).toEqual([]);
    expect(() => cuotaDelMes(torno, '2027-13')).toThrow();
  });
});
