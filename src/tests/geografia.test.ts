// Paises ISO y codigos postales espanoles (utils/geografia.ts), sin BD.
import {
  PAISES_ISO,
  PROVINCIAS,
  esCodigoPais,
  prefijoDeProvincia,
  problemaCodigoPostal,
  provinciaDeCodigoPostal,
} from '../utils/geografia';

describe('codigos de pais', () => {
  it('son los 249 codigos ISO 3166-1 alfa-2 asignados', () => {
    expect(PAISES_ISO.size).toBe(249);
    for (const c of PAISES_ISO) expect(c).toMatch(/^[A-Z]{2}$/);
  });

  it('acepta los reales, en mayusculas o minusculas', () => {
    for (const c of ['ES', 'es', ' MA ', 'BE', 'PT', 'GB', 'US', 'HK']) expect(esCodigoPais(c)).toBe(true);
  });

  it('rechaza pares de letras que no son un pais', () => {
    // SP y EP pensando en Espana, UK por el Reino Unido (es GB), EU no es un pais.
    for (const c of ['SP', 'EP', 'UK', 'EU', 'XX', 'ESP', '', null, undefined]) expect(esCodigoPais(c)).toBe(false);
  });
});

describe('codigos postales espanoles', () => {
  it('hay una provincia para cada prefijo del 01 al 52', () => {
    const prefijos = Object.keys(PROVINCIAS).sort();
    expect(prefijos).toHaveLength(52);
    expect(prefijos).toEqual(Array.from({ length: 52 }, (_, i) => String(i + 1).padStart(2, '0')));
  });

  it('la provincia sale de las dos primeras cifras', () => {
    expect(provinciaDeCodigoPostal('46120')).toBe('Valencia');
    expect(provinciaDeCodigoPostal('03001')).toBe('Alicante');
    expect(provinciaDeCodigoPostal('52001')).toBe('Melilla');
    expect(provinciaDeCodigoPostal('64120')).toBeNull();
    expect(provinciaDeCodigoPostal('4612')).toBeNull();
  });

  it('reconoce la provincia escrita de varias formas', () => {
    expect(prefijoDeProvincia('Valencia')).toBe('46');
    expect(prefijoDeProvincia('València')).toBe('46');
    expect(prefijoDeProvincia('Valencia/València')).toBe('46');
    expect(prefijoDeProvincia('provincia de valencia')).toBe('46');
    expect(prefijoDeProvincia('Alicante/Alacant')).toBe('03');
    expect(prefijoDeProvincia('Castelló')).toBe('12');
    expect(prefijoDeProvincia('La Coruña')).toBe('15');
    expect(prefijoDeProvincia('Vizcaya')).toBe('48');
    expect(prefijoDeProvincia('Araba/Álava')).toBe('01');
    expect(prefijoDeProvincia('Mallorca')).toBe('07');
    expect(prefijoDeProvincia('Las Palmas')).toBe('35');
    expect(prefijoDeProvincia('Tenerife')).toBe('38');
    // Lo que no se reconoce no se compara (texto libre de antes).
    expect(prefijoDeProvincia('Comunitat Valenciana')).toBeNull();
    expect(prefijoDeProvincia('')).toBeNull();
  });

  it('acepta un CP que existe y es de la provincia escrita', () => {
    expect(problemaCodigoPostal('46120', 'Valencia')).toBeNull();
    expect(problemaCodigoPostal('46120', 'València')).toBeNull();
    expect(problemaCodigoPostal('01000')).toBeNull();
    expect(problemaCodigoPostal('52999', 'Melilla')).toBeNull();
    // Provincia que no se reconoce: solo se mira el CP.
    expect(problemaCodigoPostal('46120', 'Comunitat Valenciana')).toBeNull();
  });

  it('rechaza un CP sin 5 cifras o fuera del 01 al 52', () => {
    expect(problemaCodigoPostal('4612')?.tipo).toBe('formato');
    expect(problemaCodigoPostal('46 120')?.tipo).toBe('formato');
    for (const cp of ['64120', '00000', '99999', '53001']) {
      const p = problemaCodigoPostal(cp, 'Valencia');
      expect(p?.tipo).toBe('rango');
      expect(p?.mensaje).toContain(cp);
    }
  });

  it('rechaza un CP de otra provincia y dice de cual es', () => {
    const p = problemaCodigoPostal('03120', 'Valencia');
    expect(p?.tipo).toBe('provincia');
    expect(p?.mensaje).toBe('El código postal 03120 es de Alicante, no de Valencia. Revisa el código postal o la provincia.');
  });
});
