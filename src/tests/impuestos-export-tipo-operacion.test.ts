/**
 * Ficheros de la AEAT con los tipos de operacion (puro): [120] y [122] en la
 * pagina 3 del 303 (el 390 y el 349 tienen sus tests dorados). Posiciones
 * del diseno de registro oficial (303 v1.01 para 2026, hoja DP30303).
 */
import { pagina3Modelo303 as generarPaginaModelo303_03 } from './aeat-ayudas';
import type { DatosModelo303, PeriodoFiscal } from '../domain/impuestos.model';

const T3: PeriodoFiscal = { ejercicio: 2026, periodo: '3T', tipo: 'trimestral', fechaInicio: '2026-07-01', fechaFin: '2026-09-30' };
/** Campo de 17 posiciones a partir de la posicion `pos` (1-based) del diseno. */
const campo = (registro: string, pos: number, largo = 17) => registro.slice(pos - 1, pos - 1 + largo);

const base303 = (extra: Partial<DatosModelo303> = {}): DatosModelo303 => ({
  periodo: T3,
  ivaDevengado: [],
  totalBaseDevengada: 0,
  totalCuotaDevengada: 0,
  ivaDeducible: [],
  totalBaseDeducible: 0,
  totalCuotaDeducible: 0,
  resultado: 0,
  casillas: {},
  ...extra,
});

describe('303, pagina 3', () => {
  it('[59]@12, [60]@29, [120]@46 y [122]@63', () => {
    const p = generarPaginaModelo303_03(
      base303({ entregasIntracomunitarias: 2300, exportaciones: 9000, noSujetasLocalizacion: 400, inversionSujetoPasivo: 800.5 }),
    );
    expect(p).toHaveLength(1017);
    expect(campo(p, 12)).toBe('00000000000230000');
    expect(campo(p, 29)).toBe('00000000000900000');
    expect(campo(p, 46)).toBe('00000000000040000');
    expect(campo(p, 63)).toBe('00000000000080050');
  });

  it('sin tipos de operacion (datos de siempre) [120] y [122] quedan a cero, como antes', () => {
    const p = generarPaginaModelo303_03(base303({ entregasIntracomunitarias: 100, exportaciones: 50 }));
    expect(campo(p, 46)).toBe('0'.repeat(17));
    expect(campo(p, 63)).toBe('0'.repeat(17));
    expect(campo(p, 12)).toBe('00000000000010000');
  });
});
