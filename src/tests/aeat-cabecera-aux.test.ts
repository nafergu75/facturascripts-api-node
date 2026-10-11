/**
 * B1: una sola cabecera <AUX> para el 303, 111, 115, 202, 390 y 200, con el
 * NIF de la entidad desarrolladora (A10952364 por defecto) y una sola version.
 */
import { cabeceraAux, cierreAux, nifEmpresaDesarrollo, NIF_EMPRESA_DESARROLLO_POR_DEFECTO, programaAeat, VERSION_PROGRAMA_AEAT } from '../aeat/common/cabeceraAux';
import { DR111, DR115, componerRegistroDr, registroDr } from '../services/aeatRetenciones/diseno';
import { DISENO_202 } from '../domain/aeat/disenos';
import { componerRegistroDr as componerDr, registroDe } from '../aeat/common/disenoRegistro';

const tramo = (s: string, desde: number, lon: number) => s.slice(desde - 1, desde - 1 + lon);

describe('cabecera <AUX> comun', () => {
  const original = process.env.AEAT_NIF_EMPRESA_DESARROLLO;
  afterEach(() => {
    if (original === undefined) delete process.env.AEAT_NIF_EMPRESA_DESARROLLO;
    else process.env.AEAT_NIF_EMPRESA_DESARROLLO = original;
  });

  it('sin variable de entorno, el NIF es A10952364 (IFBIOSOLUCIONES)', () => {
    delete process.env.AEAT_NIF_EMPRESA_DESARROLLO;
    expect(nifEmpresaDesarrollo()).toBe('A10952364');
    expect(NIF_EMPRESA_DESARROLLO_POR_DEFECTO).toBe('A10952364');
  });

  it('la variable AEAT_NIF_EMPRESA_DESARROLLO manda si es un NIF valido', () => {
    process.env.AEAT_NIF_EMPRESA_DESARROLLO = 'b-11.111.111';
    expect(nifEmpresaDesarrollo()).toBe('A10952364'); // control incorrecto: se ignora
    process.env.AEAT_NIF_EMPRESA_DESARROLLO = 'b12345674';
    expect(nifEmpresaDesarrollo()).toBe('B12345674');
  });

  it('posiciones: etiqueta, <AUX>, version en la 93, NIF en la 101 y </AUX> en la 323', () => {
    delete process.env.AEAT_NIF_EMPRESA_DESARROLLO;
    const c = cabeceraAux('303', 2026, '2T');
    expect(c).toHaveLength(328);
    expect(tramo(c, 1, 17)).toBe('<T303020262T0000>');
    expect(tramo(c, 18, 5)).toBe('<AUX>');
    expect(tramo(c, 23, 70)).toBe(' '.repeat(70));
    expect(tramo(c, 93, 4)).toBe(VERSION_PROGRAMA_AEAT);
    expect(tramo(c, 97, 4)).toBe('    ');
    expect(tramo(c, 101, 9)).toBe('A10952364');
    expect(tramo(c, 110, 213)).toBe(' '.repeat(213));
    expect(tramo(c, 323, 6)).toBe('</AUX>');
    expect(cierreAux('202', 2027, '1P')).toBe('</T20202027' + '1P0000>');
    expect(cierreAux('202', 2027, '1P')).toHaveLength(18);
  });

  it('es la misma que la cabecera de los disenos oficiales del 111, 115 y 202', () => {
    const p = programaAeat();
    const valores = { ejercicio: '2026', periodo: '3T', versionPrograma: p.versionPrograma, nifEmpresaDesarrollo: p.nifEmpresaDesarrollo };
    expect(cabeceraAux('111', 2026, '3T')).toBe(componerRegistroDr(registroDr(DR111, 'cabecera'), valores));
    expect(cabeceraAux('115', 2026, '3T')).toBe(componerRegistroDr(registroDr(DR115, 'cabecera'), valores));
    expect(cabeceraAux('202', 2026, '2P')).toBe(
      componerDr(registroDe(DISENO_202, 'cabecera'), { ejercicio: '2026', periodo: '2P', versionPrograma: p.versionPrograma, nifEmpresaDesarrollo: p.nifEmpresaDesarrollo }),
    );
  });
});
