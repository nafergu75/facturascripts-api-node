// Plantillas de las facturas de venta: catalogo, plantilla de cada serie y lo
// que cambia cada una (envases, ceramica, descuento, IVA por tipo, diseno del PDF).
import {
  admiteCeramica,
  admiteDescuento,
  admiteEnvases,
  admitePesoBruto,
  admiteTextoAdicional,
  catalogoPlantillas,
  dibujoDe,
  ivaPorTipo,
  motivoPlantillaSerie,
  normalizarPlantillaId,
  plantillaAutomatica,
  plantillaAutomaticaSerieA,
  plantillaAutomaticaSerieB,
  plantillaDisenada,
  plantillaDisponible,
  plantillaEfectivaSerie,
  PLANTILLAS_VENTA,
  type ContextoPlantillas,
} from '../domain/plantillasFactura';

/** Empresa espanola que repercute el IEEPNR, espanola que no, espanola que vende ceramica y extranjera. */
const CON_IEEPNR = { espanola: true, repercuteIeepnr: true };
const SIN_IEEPNR = { espanola: true, repercuteIeepnr: false };
const CERAMICA = { espanola: true, repercuteIeepnr: false, vendeCeramica: true };
const FUERA = { espanola: false, repercuteIeepnr: false };

describe('plantillas de factura de venta', () => {
  it('catalogo: default, A, B y C, todas con diseno; la A y la B no estan disponibles en una empresa extranjera', () => {
    expect(PLANTILLAS_VENTA).toEqual(['default', 'A', 'B', 'C']);
    const es = catalogoPlantillas(SIN_IEEPNR);
    expect(es.map((p) => [p.id, p.disponible])).toEqual([['default', true], ['A', true], ['B', true], ['C', true]]);
    const fuera = catalogoPlantillas(FUERA);
    expect(fuera.find((p) => p.id === 'A')).toMatchObject({ disponible: false, soloEmpresaEspanola: true, envases: true, calculoIva: 'tipo' });
    expect(fuera.find((p) => p.id === 'default')).toMatchObject({ nombre: 'Estándar', descripcion: 'La de siempre', envases: false, calculoIva: 'linea', disponible: true });
    expect(fuera.find((p) => p.id === 'B')).toMatchObject({ disenada: true, disponible: false, soloEmpresaEspanola: true, envases: false, ceramica: true, descuento: false, calculoIva: 'tipo' });
    expect(fuera.find((p) => p.id === 'C')).toMatchObject({ disenada: true, disponible: true, envases: false, ceramica: false, descuento: true, calculoIva: 'linea' });
    expect(['default', 'A', 'B', 'C'].map(plantillaDisenada)).toEqual([true, true, true, true]);
  });

  it('catalogo: seriesAutomaticas dice que serie A, B o C usa cada plantilla sin elegirla', () => {
    const series = (ctx: ContextoPlantillas) => Object.fromEntries(catalogoPlantillas(ctx).map((p) => [p.id, p.seriesAutomaticas]));
    expect(series(CON_IEEPNR)).toEqual({ default: ['B'], A: ['A'], B: [], C: ['C'] });
    expect(series(SIN_IEEPNR)).toEqual({ default: ['A', 'B'], A: [], B: [], C: ['C'] });
    expect(series(CERAMICA)).toEqual({ default: ['A'], A: [], B: ['B'], C: ['C'] });
    expect(series({ ...CERAMICA, repercuteIeepnr: true })).toEqual({ default: [], A: ['A'], B: ['B'], C: ['C'] });
    // Fuera de Espana la A y la B no estan: sus series usan la estandar.
    expect(series({ ...FUERA, repercuteIeepnr: true, vendeCeramica: true })).toEqual({ default: ['A', 'B'], A: [], B: [], C: ['C'] });
  });

  it('catalogo: automaticaSerieA marca la A solo si la empresa es espanola y repercute el IEEPNR', () => {
    const automatica = (ctx: typeof CON_IEEPNR) => catalogoPlantillas(ctx).filter((p) => p.automaticaSerieA).map((p) => p.id);
    expect(automatica(CON_IEEPNR)).toEqual(['A']);
    expect(automatica(SIN_IEEPNR)).toEqual(['default']);
    expect(automatica(FUERA)).toEqual(['default']);
    expect(plantillaAutomaticaSerieA({ espanola: false, repercuteIeepnr: true })).toBe('default');
  });

  it('plantillaAutomaticaSerieB: la B solo si la empresa es espanola y vende ceramica', () => {
    expect(plantillaAutomaticaSerieB(CERAMICA)).toBe('B');
    expect(plantillaAutomaticaSerieB(SIN_IEEPNR)).toBe('default');
    expect(plantillaAutomaticaSerieB({ ...CERAMICA, vendeCeramica: false })).toBe('default');
    expect(plantillaAutomaticaSerieB({ ...CERAMICA, espanola: false })).toBe('default');
  });

  it('normalizarPlantillaId: lo desconocido pasa a default', () => {
    expect(normalizarPlantillaId('A')).toBe('A');
    expect(normalizarPlantillaId('a')).toBe('default');
    expect(normalizarPlantillaId('B2')).toBe('default');
    expect(normalizarPlantillaId(undefined)).toBe('default');
    expect(normalizarPlantillaId(null)).toBe('default');
  });

  it('plantilla efectiva de la serie: la elegida o, automatica, la A en la serie A de una empresa espanola que repercute el IEEPNR', () => {
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: null }, CON_IEEPNR)).toBe('A');
    // Una empresa que no repercute el IEEPNR (no vende envases) sigue con la de siempre en su serie A.
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: null }, SIN_IEEPNR)).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: null }, FUERA)).toBe('default');
    for (const codigo of ['R', 'P', 'RT', 'D', 'BB']) expect(plantillaEfectivaSerie({ codigo, plantilla: null }, CON_IEEPNR)).toBe('default');
    // La serie B usa sola la B (ceramica) si la empresa vende ceramica, y solo en Espana; la C, la C (servicios).
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: null }, CERAMICA)).toBe('B');
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: null }, SIN_IEEPNR)).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: null }, { ...FUERA, vendeCeramica: true })).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'C', plantilla: null }, FUERA)).toBe('C');
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: 'default' }, CERAMICA)).toBe('default');
    expect(plantillaAutomatica(' b ', CERAMICA)).toBe('B');
    expect(plantillaAutomatica(' b ', SIN_IEEPNR)).toBe('default');
    // Elegida a mano, la B vale aunque la empresa no diga que vende ceramica.
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: 'B' }, SIN_IEEPNR)).toBe('B');
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'default' }, CON_IEEPNR)).toBe('default');
    // Elegida a mano, la A vale aunque no se repercuta (el IEEPNR sale a 0).
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: 'A' }, SIN_IEEPNR)).toBe('A');
    expect(plantillaEfectivaSerie({ codigo: 'P', plantilla: 'C' }, SIN_IEEPNR)).toBe('C');
    // Elegida la A y la empresa pasa a ser extranjera: la estandar.
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'A' }, FUERA)).toBe('default');
  });

  it('motivoPlantillaSerie: por que cada serie usa su plantilla (la casilla, el codigo, elegida o solo en Espana)', () => {
    const motivo = (codigo: string, ctx: ContextoPlantillas, plantilla: string | null = null) => motivoPlantillaSerie({ codigo, plantilla }, ctx);
    // Serie A: la A si la empresa repercute el IEEPNR; si no, la estandar por la casilla sin marcar.
    expect(motivo('A', CON_IEEPNR)).toBe('ieepnr');
    expect(motivo('A', SIN_IEEPNR)).toBe('sinIeepnr');
    expect(motivo(' a ', SIN_IEEPNR)).toBe('sinIeepnr');
    // Serie B: la B si vende ceramica; si no (o sin el dato), la estandar por la casilla sin marcar.
    expect(motivo('B', CERAMICA)).toBe('ceramica');
    expect(motivo('B', SIN_IEEPNR)).toBe('sinCeramica');
    expect(motivo('B', { ...CERAMICA, vendeCeramica: false })).toBe('sinCeramica');
    // Serie C, la C; el resto, la estandar.
    expect(motivo('C', SIN_IEEPNR)).toBe('serieC');
    expect(motivo('C', FUERA)).toBe('serieC');
    for (const codigo of ['R', 'P', 'RT', 'BB', 'F2027']) expect(motivo(codigo, { ...CERAMICA, repercuteIeepnr: true })).toBe('estandar');
    // Elegida a mano: manda, salvo la A o la B en una empresa extranjera.
    expect(motivo('A', SIN_IEEPNR, 'default')).toBe('elegida');
    expect(motivo('B', SIN_IEEPNR, 'B')).toBe('elegida');
    expect(motivo('P', FUERA, 'C')).toBe('elegida');
    expect(motivo('A', FUERA, 'A')).toBe('soloEspana');
    // Fuera de Espana, la A y la B automaticas usan la estandar, como cualquier otra serie, aunque las casillas digan que si.
    expect(motivo('A', { ...FUERA, repercuteIeepnr: true })).toBe('estandar');
    expect(motivo('B', { ...FUERA, vendeCeramica: true })).toBe('estandar');
    expect(motivo('A', FUERA)).toBe('estandar');
    // El motivo cuadra con la plantilla que usa la serie.
    const usaEstandar = ['sinIeepnr', 'sinCeramica', 'soloEspana', 'estandar'];
    for (const ctx of [CON_IEEPNR, SIN_IEEPNR, CERAMICA, FUERA, { ...CERAMICA, repercuteIeepnr: true }]) {
      for (const codigo of ['A', 'B', 'C', 'R']) {
        const m = motivo(codigo, ctx);
        if (m !== 'elegida') expect([m, plantillaEfectivaSerie({ codigo, plantilla: null }, ctx) === 'default']).toEqual([m, usaEstandar.includes(m)]);
      }
    }
  });

  it('la A lleva envases y la B ceramica; las dos, texto adicional, peso bruto, IVA por tipo, sin descuento y su propio diseno', () => {
    const todas = ['default', 'A', 'B', 'C'];
    expect(todas.map(admiteEnvases)).toEqual([false, true, false, false]);
    expect(todas.map(admiteCeramica)).toEqual([false, false, true, false]);
    expect(todas.map(admiteTextoAdicional)).toEqual([false, true, true, false]);
    expect(todas.map(admitePesoBruto)).toEqual([false, true, true, false]);
    expect(todas.map(admiteDescuento)).toEqual([true, false, false, true]);
    expect(todas.map(ivaPorTipo)).toEqual([false, true, true, false]);
    expect([...todas, 'otra'].map(dibujoDe)).toEqual(['estandar', 'A', 'B', 'estandar', 'estandar']);
    expect(plantillaDisponible('A', false)).toBe(false);
    expect(plantillaDisponible('B', false)).toBe(false);
    expect(plantillaDisponible('C', false)).toBe(true);
  });
});
