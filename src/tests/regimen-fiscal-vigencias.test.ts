/**
 * Régimen fiscal por fecha de efecto (spec arranque-2027, B.7) e inicio en la
 * app (B.8): funciones puras del calendario.
 */
import { antesDelInicio, calendarioConVigencias, calendarioEjercicio, regimenEn, type VigenciaRegimen } from '../domain/calendarioFiscal';

const TRIMESTRAL = { periodicidadIva: 'TRIMESTRAL', redeme: false, sii: false, granEmpresa: false } as const;
const SII_MENSUAL = { periodicidadIva: 'MENSUAL', redeme: false, sii: true, granEmpresa: false } as const;
const claves = (es: Array<{ codigo: string; periodo: string }>) => es.map((e) => `${e.codigo}:${e.periodo}`).sort();

describe('regimenEn', () => {
  const v: VigenciaRegimen[] = [
    { desde: '2026-01-01', ...TRIMESTRAL },
    { desde: '2026-10-01', ...SII_MENSUAL },
  ];

  it('toma la última fecha de efecto que no es posterior', () => {
    expect(regimenEn(v, '2026-09-30').periodicidadIva).toBe('TRIMESTRAL');
    expect(regimenEn(v, '2026-10-01')).toEqual(SII_MENSUAL);
    expect(regimenEn(v, '2027-05-01').sii).toBe(true);
  });

  it('antes de la primera, el de por defecto', () => {
    expect(regimenEn(v, '2025-12-31')).toEqual(TRIMESTRAL);
    expect(regimenEn([], '2027-01-01')).toEqual(TRIMESTRAL);
  });
});

describe('calendarioConVigencias', () => {
  it('con un solo régimen es el calendario de siempre', () => {
    const v: VigenciaRegimen[] = [{ desde: '2026-01-01', ...SII_MENSUAL }];
    expect(claves(calendarioConVigencias(2027, v, false))).toEqual(claves(calendarioEjercicio(2027, { ajustes: SII_MENSUAL, autonomo: false })));
  });

  it('un cambio a SII mensual desde octubre: trimestres hasta el 3T y meses desde octubre; anuales del 1 de enero', () => {
    const v: VigenciaRegimen[] = [{ desde: '2026-10-01', ...SII_MENSUAL }];
    const cal = claves(calendarioConVigencias(2026, v, false));
    expect(cal).toEqual(expect.arrayContaining(['303:1T', '303:2T', '303:3T', '303:10', '303:11', '303:12']));
    expect(cal).not.toContain('303:4T');
    expect(cal).not.toContain('303:09');
    // El 390 y el 347 siguen: en enero no estaba en el SII.
    expect(cal).toEqual(expect.arrayContaining(['390:0A', '347:0A']));
    // Al año siguiente, todo con el régimen nuevo: sin 390 ni 347.
    const sig = claves(calendarioConVigencias(2027, v, false));
    expect(sig).not.toContain('390:0A');
    expect(sig.filter((c) => c.startsWith('303:'))).toHaveLength(12);
  });

  it('guardar los mismos ajustes en 2027 no cambia el calendario de 2026', () => {
    // Antes: con AjustesFiscales.updatedAt en 2027, 2026 pasaba a los de por defecto.
    const v: VigenciaRegimen[] = [
      { desde: '2026-01-01', ...SII_MENSUAL },
      { desde: '2027-01-01', ...SII_MENSUAL },
    ];
    expect(claves(calendarioConVigencias(2026, v, false)).filter((c) => c.startsWith('303:'))).toHaveLength(12);
  });
});

describe('antesDelInicio', () => {
  it('un periodo que acaba antes de la fecha de inicio no cuenta', () => {
    expect(antesDelInicio(2026, '4T', '2027-01-01')).toBe(true);
    expect(antesDelInicio(2026, '0A', '2027-01-01')).toBe(true);
    expect(antesDelInicio(2027, '1T', '2027-01-01')).toBe(false);
  });

  it('un periodo que empieza antes y acaba después sí cuenta (se presenta con la app)', () => {
    expect(antesDelInicio(2027, '1T', '2027-02-15')).toBe(false);
    expect(antesDelInicio(2027, '01', '2027-02-15')).toBe(true);
  });

  it('sin fecha de inicio, nada queda fuera', () => {
    expect(antesDelInicio(2020, '1T', null)).toBe(false);
  });
});
