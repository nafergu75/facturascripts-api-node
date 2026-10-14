// Plantillas de las facturas de venta: catalogo, plantilla de cada serie y lo
// que cambia cada una (envases, IVA por tipo, diseno del PDF).
import {
  admiteEnvases,
  catalogoPlantillas,
  dibujoDe,
  ivaPorTipo,
  normalizarPlantillaId,
  plantillaAutomaticaSerieA,
  plantillaDisenada,
  plantillaDisponible,
  plantillaEfectivaSerie,
  PLANTILLAS_VENTA,
} from '../domain/plantillasFactura';

/** Empresa espanola que repercute el IEEPNR, espanola que no y extranjera. */
const CON_IEEPNR = { espanola: true, repercuteIeepnr: true };
const SIN_IEEPNR = { espanola: true, repercuteIeepnr: false };
const FUERA = { espanola: false, repercuteIeepnr: false };

describe('plantillas de factura de venta', () => {
  it('catalogo: default, A, B y C; la A no esta disponible en una empresa extranjera y la B, sin diseno, en ninguna', () => {
    expect(PLANTILLAS_VENTA).toEqual(['default', 'A', 'B', 'C']);
    const es = catalogoPlantillas(SIN_IEEPNR);
    expect(es.map((p) => [p.id, p.disponible])).toEqual([['default', true], ['A', true], ['B', false], ['C', true]]);
    const fuera = catalogoPlantillas(FUERA);
    expect(fuera.find((p) => p.id === 'A')).toMatchObject({ disponible: false, soloEmpresaEspanola: true, envases: true, calculoIva: 'tipo' });
    expect(fuera.find((p) => p.id === 'default')).toMatchObject({ nombre: 'Estándar', descripcion: 'La de siempre', envases: false, calculoIva: 'linea', disponible: true });
    expect(fuera.find((p) => p.id === 'B')).toMatchObject({ disenada: false, disponible: false, envases: false, calculoIva: 'linea' });
    expect(fuera.find((p) => p.id === 'C')).toMatchObject({ disenada: true, disponible: true, envases: false, calculoIva: 'linea' });
    expect(['default', 'A', 'B', 'C'].map(plantillaDisenada)).toEqual([true, true, false, true]);
  });

  it('catalogo: automaticaSerieA marca la A solo si la empresa es espanola y repercute el IEEPNR', () => {
    const automatica = (ctx: typeof CON_IEEPNR) => catalogoPlantillas(ctx).filter((p) => p.automaticaSerieA).map((p) => p.id);
    expect(automatica(CON_IEEPNR)).toEqual(['A']);
    expect(automatica(SIN_IEEPNR)).toEqual(['default']);
    expect(automatica(FUERA)).toEqual(['default']);
    expect(plantillaAutomaticaSerieA({ espanola: false, repercuteIeepnr: true })).toBe('default');
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
    for (const codigo of ['B', 'R', 'P', 'RT', 'C']) expect(plantillaEfectivaSerie({ codigo, plantilla: null }, CON_IEEPNR)).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'default' }, CON_IEEPNR)).toBe('default');
    // Elegida a mano, la A vale aunque no se repercuta (el IEEPNR sale a 0).
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: 'A' }, SIN_IEEPNR)).toBe('A');
    expect(plantillaEfectivaSerie({ codigo: 'P', plantilla: 'C' }, SIN_IEEPNR)).toBe('C');
    // Elegida la A y la empresa pasa a ser extranjera: la estandar.
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'A' }, FUERA)).toBe('default');
  });

  it('solo la A lleva envases e IVA por tipo y tiene su propio diseno', () => {
    expect(['default', 'A', 'B', 'C'].map(admiteEnvases)).toEqual([false, true, false, false]);
    expect(['default', 'A', 'B', 'C'].map(ivaPorTipo)).toEqual([false, true, false, false]);
    expect(['default', 'A', 'B', 'C', 'otra'].map(dibujoDe)).toEqual(['estandar', 'A', 'estandar', 'estandar', 'estandar']);
    expect(plantillaDisponible('A', false)).toBe(false);
    expect(plantillaDisponible('C', false)).toBe(true);
  });
});
