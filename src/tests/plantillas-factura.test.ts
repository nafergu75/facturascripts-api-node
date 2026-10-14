// Plantillas de las facturas de venta: catalogo, plantilla de cada serie y lo
// que cambia cada una (envases, IVA por tipo, diseno del PDF).
import {
  admiteEnvases,
  catalogoPlantillas,
  dibujoDe,
  ivaPorTipo,
  normalizarPlantillaId,
  plantillaDisponible,
  plantillaEfectivaSerie,
  PLANTILLAS_VENTA,
} from '../domain/plantillasFactura';

describe('plantillas de factura de venta', () => {
  it('catalogo: default, A, B y C; la A no esta disponible en una empresa extranjera', () => {
    expect(PLANTILLAS_VENTA).toEqual(['default', 'A', 'B', 'C']);
    const es = catalogoPlantillas(true);
    expect(es.map((p) => [p.id, p.disponible])).toEqual([['default', true], ['A', true], ['B', true], ['C', true]]);
    const fuera = catalogoPlantillas(false);
    expect(fuera.find((p) => p.id === 'A')).toMatchObject({ disponible: false, soloEmpresaEspanola: true, envases: true, calculoIva: 'tipo' });
    expect(fuera.find((p) => p.id === 'default')).toMatchObject({ nombre: 'Estándar', descripcion: 'La de siempre', envases: false, calculoIva: 'linea', disponible: true });
    expect(fuera.find((p) => p.id === 'B')).toMatchObject({ descripcion: 'De momento sale igual que la estándar', envases: false, calculoIva: 'linea' });
  });

  it('normalizarPlantillaId: lo desconocido pasa a default', () => {
    expect(normalizarPlantillaId('A')).toBe('A');
    expect(normalizarPlantillaId('a')).toBe('default');
    expect(normalizarPlantillaId('B2')).toBe('default');
    expect(normalizarPlantillaId(undefined)).toBe('default');
    expect(normalizarPlantillaId(null)).toBe('default');
  });

  it('plantilla efectiva de la serie: la elegida o, automatica, la A en la serie A de una empresa espanola', () => {
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: null }, true)).toBe('A');
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: null }, false)).toBe('default');
    for (const codigo of ['B', 'R', 'P', 'RT', 'C']) expect(plantillaEfectivaSerie({ codigo, plantilla: null }, true)).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'default' }, true)).toBe('default');
    expect(plantillaEfectivaSerie({ codigo: 'B', plantilla: 'A' }, true)).toBe('A');
    expect(plantillaEfectivaSerie({ codigo: 'P', plantilla: 'C' }, true)).toBe('C');
    // Elegida la A y la empresa pasa a ser extranjera: la estandar.
    expect(plantillaEfectivaSerie({ codigo: 'A', plantilla: 'A' }, false)).toBe('default');
  });

  it('solo la A lleva envases e IVA por tipo y tiene su propio diseno', () => {
    expect(['default', 'A', 'B', 'C'].map(admiteEnvases)).toEqual([false, true, false, false]);
    expect(['default', 'A', 'B', 'C'].map(ivaPorTipo)).toEqual([false, true, false, false]);
    expect(['default', 'A', 'B', 'C', 'otra'].map(dibujoDe)).toEqual(['estandar', 'A', 'estandar', 'estandar', 'estandar']);
    expect(plantillaDisponible('A', false)).toBe(false);
    expect(plantillaDisponible('C', false)).toBe(true);
  });
});
