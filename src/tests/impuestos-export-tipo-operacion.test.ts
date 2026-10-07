/**
 * Ficheros de la AEAT con los tipos de operacion (puro): [120] y [122] en la
 * pagina 3 del 303, el volumen de operaciones del 390 por grupos y el 349 con
 * la clave S. Posiciones del diseno de registro oficial (303 v1.01 para 2026,
 * hoja DP30303; 390, hoja "Pag. 6").
 */
import { generarFicheroModelo349, generarFicheroModelo390, generarPaginaModelo303_03 } from '../services/impuestosExport.service';
import type { DatosModelo303, DatosModelo349, DatosModelo390, PeriodoFiscal } from '../domain/impuestos.model';

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

describe('390, pagina 6: volumen de operaciones', () => {
  const datos = (extra: Partial<DatosModelo390> = {}): DatosModelo390 => ({
    ejercicio: 2026,
    resumenDevengado: [{ tipo: 21, base: 1000, cuota: 210 }],
    resumenDeducible: [],
    totalCuotaDevengada: 210,
    totalCuotaDeducible: 0,
    resultadoAnual: 210,
    volumenOperaciones: 1000,
    ...extra,
  });
  const pagina6 = (d: DatosModelo390) => generarFicheroModelo390('B12345678', 2026, d).split('\r\n')[2];

  it('[99]@361, [103]@395, [104]@412, [105]@429, [110]@446, [125]@463 y [108]@650 = suma', () => {
    const p = pagina6(
      datos({
        volumen: {
          regimenGeneral: 1000,
          intracomunitarias: 2000,
          exportacionesYExentasConDeduccion: 340,
          exentasSinDeduccion: 50,
          noSujetas: 60,
          isp: 70,
          total: 3520,
        },
      }),
    );
    expect(p.startsWith('<T39006000>')).toBe(true);
    expect(campo(p, 361)).toBe('00000000000100000');
    expect(campo(p, 395)).toBe('00000000000200000');
    expect(campo(p, 412)).toBe('00000000000034000');
    expect(campo(p, 429)).toBe('00000000000005000');
    expect(campo(p, 446)).toBe('00000000000006000');
    expect(campo(p, 463)).toBe('00000000000007000');
    expect(campo(p, 650)).toBe('00000000000352000');
  });

  it('sin desglose (datos de siempre) [108] es [99]', () => {
    const p = pagina6(datos());
    expect(campo(p, 650)).toBe('00000000000100000');
    expect(campo(p, 395)).toBe('0'.repeat(17));
  });
});

describe('349', () => {
  const datos = (operaciones: DatosModelo349['operaciones']): DatosModelo349 => ({
    periodo: T3,
    operaciones,
    totalBase: operaciones.reduce((a, o) => a + o.base, 0),
  });

  it('un registro por operador y clave: S para servicios', () => {
    const f = generarFicheroModelo349(
      'B12345678',
      T3,
      datos([
        { cifnif: 'FR12345678901', nombre: 'Client FR', clave: 'E', base: 1300 },
        { cifnif: 'DE123456789', nombre: 'Kunde DE', clave: 'S', base: 300 },
      ]),
    );
    const [, r1, r2] = f.split('\r\n');
    expect(r1[132]).toBe('E');
    expect(r2[132]).toBe('S');
    expect(r2.slice(133, 146)).toBe('0000000030000');
  });

  it('un operador en negativo no se escribe en valor absoluto: error claro', () => {
    expect(() =>
      generarFicheroModelo349('B12345678', T3, datos([{ cifnif: 'IT12345678901', nombre: 'Cliente IT', clave: 'E', base: -50 }])),
    ).toThrow(/negativo/);
  });
});
