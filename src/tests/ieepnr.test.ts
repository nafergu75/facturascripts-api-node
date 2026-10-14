// IEEPNR (Ley 7/2022): kg × tipo al centimo en enteros, mitad hacia arriba y
// simetrico en las rectificativas; resumen de envases y reparto por cuenta.
import { calcularIeepnr, IEEPNR_POR_KG_DEFECTO, redondearKg, repartoIngresos, resumenEnvases } from '../domain/ieepnr';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';

describe('calcularIeepnr', () => {
  it('las 7 lineas de NZ004_26 dan las cifras de la muestra y suman 177,75', () => {
    const r = LINEAS_NZ004.map((l) => calcularIeepnr(l.kgPlastico, IEEPNR_POR_KG_DEFECTO));
    expect(r).toEqual([46.39, 79.28, 5.52, 25.34, 8.7, 1.12, 11.4]);
    expect(r.reduce((a, c) => a + Math.round(c * 100), 0)).toBe(17775);
    expect(TOTALES_NZ004.ieepnr).toBe(177.75);
  });

  it('los negativos dan lo mismo con el signo cambiado (simetrico)', () => {
    const r = LINEAS_NZ004.map((l) => calcularIeepnr(-l.kgPlastico, 0.45, { simetrico: true }));
    expect(r).toEqual([-46.39, -79.28, -5.52, -25.34, -8.7, -1.12, -11.4]);
  });

  it('casos .xx5: la mitad sube; en negativo, simetrico solo en las rectificativas', () => {
    // 0,1 kg × 0,45 = 0,045 -> 0,05
    expect(calcularIeepnr(0.1, 0.45)).toBe(0.05);
    expect(calcularIeepnr(-0.1, 0.45, { simetrico: true })).toBe(-0.05);
    // Sin simetrico, la mitad va hacia arriba tambien en negativo (como Math.round).
    expect(calcularIeepnr(-0.1, 0.45)).toBe(-0.04);
    // 1,001 × 0,45 = 0,45045 -> 0,45; 1,011 × 0,45 = 0,45495 -> 0,45; 1,9 × 0,45 = 0,855 -> 0,86
    expect(calcularIeepnr(1.001, 0.45)).toBe(0.45);
    expect(calcularIeepnr(1.011, 0.45)).toBe(0.45);
    expect(calcularIeepnr(1.9, 0.45)).toBe(0.86);
    expect(calcularIeepnr(-1.9, 0.45, { simetrico: true })).toBe(-0.86);
    // 10,333 × 0,45 = 4,64985 -> 4,65 (en coma flotante podria salir 4,64)
    expect(calcularIeepnr(10.333, 0.45)).toBe(4.65);
  });

  it('sin kg o sin tipo da 0, nunca -0', () => {
    expect(calcularIeepnr(0, 0.45)).toBe(0);
    expect(calcularIeepnr(null, 0.45)).toBe(0);
    expect(calcularIeepnr(12, 0)).toBe(0);
    expect(Object.is(calcularIeepnr(-0.001, 0.45, { simetrico: true }), -0)).toBe(false);
  });

  it('otro tipo por kg con 4 decimales', () => {
    expect(calcularIeepnr(100, 0.4567)).toBe(45.67);
    expect(calcularIeepnr(1, 0.4555)).toBe(0.46);
  });

  it('cifras grandes sin perder precision', () => {
    expect(calcularIeepnr(99999999.999, 10)).toBe(999999999.99);
  });
});

describe('redondearKg', () => {
  it('3 decimales, simetrico', () => {
    expect(redondearKg(103.0894)).toBe(103.089);
    expect(redondearKg(1.0005)).toBe(1.001);
    expect(redondearKg(-1.0005)).toBe(-1.001);
    expect(redondearKg(176.17)).toBe(176.17);
  });
});

describe('resumenEnvases', () => {
  it('NZ004_26: kg 394,992, packs 9.826, uds 46.320 e IEEPNR 177,75', () => {
    const r = resumenEnvases(LINEAS_NZ004.map((l) => ({ cantidad: l.cantidad, packs: l.packs, kgPlastico: l.kgPlastico, ieepnrImporte: l.ieepnr })));
    expect(r).toEqual({ kgPlastico: TOTALES_NZ004.kgPlastico, packs: TOTALES_NZ004.packs, uds: TOTALES_NZ004.uds, ieepnr: TOTALES_NZ004.ieepnr });
  });

  it('lineas sin envases cuentan como 0', () => {
    expect(resumenEnvases([{ cantidad: 2 }, { cantidad: 1, packs: null, kgPlastico: null, ieepnrImporte: null }])).toEqual({ kgPlastico: 0, packs: 0, uds: 3, ieepnr: 0 });
  });
});

describe('repartoIngresos', () => {
  const lineas = [
    { cuenta: '700', baseLine: 544.05, ieepnrImporte: 46.39 },
    { cuenta: '701', baseLine: 1029.32, ieepnrImporte: 79.28 },
    { cuenta: null, baseLine: 71.64, ieepnrImporte: 5.52 },
  ];

  it('sin cuenta del IEEPNR: cada linea a su cuenta por su base entera', () => {
    expect(repartoIngresos(lineas, null)).toEqual([
      { cuenta: '700', base: 615.69 },
      { cuenta: '701', base: 1029.32 },
    ]);
  });

  it('con cuenta del IEEPNR: la linea sin el IEEPNR y el IEEPNR a su cuenta', () => {
    expect(repartoIngresos(lineas, '4758')).toEqual([
      { cuenta: '700', base: 563.78 },
      { cuenta: '701', base: 950.04 },
      { cuenta: '4758', base: 131.19 },
    ]);
  });

  it('con cuenta del IEEPNR pero sin IEEPNR, no sale', () => {
    expect(repartoIngresos([{ cuenta: '705', baseLine: 100 }], '4758')).toEqual([{ cuenta: '705', base: 100 }]);
  });
});
