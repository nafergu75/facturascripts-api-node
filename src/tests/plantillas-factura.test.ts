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
