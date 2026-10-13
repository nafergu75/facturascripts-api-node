/**
 * Direccion leida en una factura, lista para la ficha del cliente o del
 * proveedor que se da de alta desde el lector.
 *
 * Regresion (13-10-2026): al dar de alta el tercero desde el lector solo
 * salian el nombre y el NIF; el resto habia que escribirlo a mano.
 */
import { direccionDeIa } from '../services/lectura/direccion-ia';
import { direccionParaFicha, paisIsoLeido } from '../services/lectura/direccion';
import type { Campo, DireccionLeida } from '../services/lectura/tipos';

const azure = (valor: DireccionLeida | null, confianza: number | null = 0.9): Campo<DireccionLeida> => ({ valor, confianza, fuente: 'azure' });

describe('pais leido -> ISO-2, solo si es seguro', () => {
  it('codigos ISO-2 e ISO-3 (Azure da «ESP»)', () => {
    expect(paisIsoLeido('ESP')).toBe('ES');
    expect(paisIsoLeido('es')).toBe('ES');
    expect(paisIsoLeido(' FRA ')).toBe('FR');
    expect(paisIsoLeido('PRT')).toBe('PT');
    expect(paisIsoLeido('USA')).toBe('US');
    expect(paisIsoLeido('UK')).toBe('GB');
  });

  it('nombres en castellano, ingles o su idioma, con o sin tildes', () => {
    expect(paisIsoLeido('España')).toBe('ES');
    expect(paisIsoLeido('ESPAÑA')).toBe('ES');
    expect(paisIsoLeido('Spain')).toBe('ES');
    expect(paisIsoLeido('Espanya')).toBe('ES');
    expect(paisIsoLeido('Francia')).toBe('FR');
    expect(paisIsoLeido('France')).toBe('FR');
    expect(paisIsoLeido('Portugal')).toBe('PT');
    expect(paisIsoLeido('Reino  Unido')).toBe('GB');
    expect(paisIsoLeido('Países Bajos')).toBe('NL');
  });

  it('lo que no se reconoce con seguridad: null (mejor vacio que equivocado)', () => {
    expect(paisIsoLeido(null)).toBeNull();
    expect(paisIsoLeido('')).toBeNull();
    expect(paisIsoLeido('SP')).toBeNull();
    expect(paisIsoLeido('EU')).toBeNull();
    expect(paisIsoLeido('XYZ')).toBeNull();
    expect(paisIsoLeido('EL')).toBeNull();
    expect(paisIsoLeido('Comunidad Valenciana')).toBeNull();
    expect(paisIsoLeido('46001 Valencia, España')).toBeNull();
  });
});

describe('direccion para la ficha', () => {
  it('cada parte en su casilla, sin espacios de mas, y el pais en ISO-2', () => {
    expect(direccionParaFicha(azure({ calle: '  Calle  Mayor 12 ', cp: '46001', municipio: 'Valencia', provincia: 'Valencia', pais: 'ESP' }))).toEqual({
      calle: 'Calle Mayor 12',
      cp: '46001',
      municipio: 'Valencia',
      provincia: 'Valencia',
      pais: 'ES',
      revisar: false,
    });
  });

  it('revisar con el mismo criterio que el resto de datos leidos', () => {
    const d = { calle: 'Calle Mayor 12', cp: '46001' };
    expect(direccionParaFicha(azure(d, 0.6))?.revisar).toBe(true);
    expect(direccionParaFicha(azure(d, null))?.revisar).toBe(true);
    expect(direccionParaFicha({ valor: d, confianza: null, fuente: 'claude' })?.revisar).toBe(false);
    expect(direccionParaFicha({ ...azure(d), motivo: 'El archivo parece tener varias facturas.' })?.revisar).toBe(true);
  });

  it('sin nada que sirva, null (tambien en las lecturas guardadas antes, sin direccion)', () => {
    expect(direccionParaFicha(azure(null))).toBeNull();
    expect(direccionParaFicha(azure({ pais: 'Narnia' }))).toBeNull();
    expect(direccionParaFicha(azure({ calle: '   ' }))).toBeNull();
    expect(direccionParaFicha(undefined)).toBeNull();
    // Solo el pais tambien sirve para la ficha.
    expect(direccionParaFicha(azure({ pais: 'Portugal' }))).toEqual({ calle: null, cp: null, municipio: null, provincia: null, pais: 'PT', revisar: false });
  });
});

describe('direccion que devuelve Claude', () => {
  it('se queda con las partes que trae, como texto', () => {
    expect(direccionDeIa({ calle: ' Av. del Puerto 3, 2º ', cp: '46021', municipio: 'Valencia', provincia: '', pais: 'España', otra: 'x' })).toEqual({
      calle: 'Av. del Puerto 3, 2º',
      cp: '46021',
      municipio: 'Valencia',
      pais: 'España',
    });
  });

  it('nada o algo que no es una direccion: null', () => {
    expect(direccionDeIa(undefined)).toBeNull();
    expect(direccionDeIa('Calle Mayor 1')).toBeNull();
    expect(direccionDeIa({})).toBeNull();
    expect(direccionDeIa({ cp: 46001 })).toBeNull();
  });
});
