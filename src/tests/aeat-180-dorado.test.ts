/**
 * Test dorado del 180: el fichero cumple el diseno OFICIAL (DR_Mod_180_2023.pdf,
 * el unico publicado: vale para 2023 y siguientes) campo a campo, con la tabla
 * de campos (src/domain/aeat/dr180.json) y con las posiciones copiadas a mano
 * del PDF.
 *
 * Caso real de 2027: dos arrendadores (una persona fisica con un local en
 * Valencia y una sociedad con un local en Madrid, sin numero de calle), un
 * registro aparte con el alquiler de diciembre de 2026 que se declara en 2027
 * (ejercicio de devengo), y el cuadre con los cuatro 115 del año.
 */
import { describe, it, expect } from '@jest/globals';
import { DISENO_180 } from '../domain/aeat/disenos';
import { comprobarFicheroPorLineas, posiciones } from './dorado-dr';
import { controlCif, letraDni } from '../utils/nif';
import {
  cuadre180Con115,
  erroresEntrada180,
  generarFichero180,
  leerFichero180,
  numeroDeclaracion180,
  type Entrada180,
} from '../aeat/modelo180/modelo180.dr';

const NIF = `B4612345${controlCif('4612345').cifra}`;
const DNI = `12345678${letraDni('12345678')}`;
const CIF_ARRENDADORA = `B2800000${controlCif('2800000').cifra}`;

const valencia = {
  situacion: 1 as const,
  referenciaCatastral: '9872023VH5797S0001WX',
  tipoVia: 'CL',
  nombreVia: 'Colón',
  tipoNumeracion: 'NUM',
  numeroCasa: '12',
  planta: 'BJ',
  puerta: '2',
  municipio: 'València',
  codigoMunicipio: '46250',
  provinciaInmueble: '46',
  codigoPostal: '46004',
};
const madrid = {
  situacion: 1 as const,
  referenciaCatastral: '0847106VK4704F0001LK',
  tipoVia: 'AV',
  nombreVia: 'Gran Vía',
  tipoNumeracion: 'S/N',
  complemento: 'Centro Comercial Las Rosas, local 14',
  municipio: 'Madrid',
  codigoMunicipio: '28079',
  provinciaInmueble: '28',
  codigoPostal: '28013',
};

const entrada = (): Entrada180 => ({
  ejercicio: 2027,
  declarante: {
    nif: NIF,
    nombre: 'Biosoluciones del Turia, S.L.',
    telefono: '963123456',
    personaContacto: 'García Muñoz Ana',
    numeroDeclaracion: numeroDeclaracion180(2027),
  },
  perceptores: [
    { nif: DNI, nombre: 'Martínez Peña José', provincia: '46', base: 12000, porcentaje: 19, retenciones: 2280, inmueble: valencia },
    { nif: CIF_ARRENDADORA, nombre: 'Inmuebles Ñora, S.L.', provincia: '28', base: 6000, porcentaje: 19, retenciones: 1140, inmueble: madrid },
    { nif: CIF_ARRENDADORA, nombre: 'Inmuebles Ñora, S.L.', provincia: '28', base: 500, porcentaje: 19, retenciones: 95, ejercicioDevengo: 2026, inmueble: madrid },
  ],
});

describe('180 dorado: fichero con el diseño oficial', () => {
  const fichero = generarFichero180(entrada());
  const lineas = comprobarFicheroPorLineas(DISENO_180, fichero, (_l, i) => (i === 0 ? 'declarante' : 'perceptor'));
  const [t1, ...t2] = lineas.map((l) => l.linea);

  it('un tipo 1 y un tipo 2 por perceptor, inmueble y ejercicio de devengo; 500 y CRLF', () => {
    expect(lineas.map((l) => l.registro)).toEqual(['declarante', 'perceptor', 'perceptor', 'perceptor']);
    expect(Buffer.from(fichero, 'latin1').toString('latin1')).toBe(fichero);
  });

  it('tipo 1, posiciones del PDF', () => {
    expect(posiciones(t1, 1, 8)).toBe('11802027');
    expect(posiciones(t1, 9, 17)).toBe(NIF);
    expect(posiciones(t1, 18, 57)).toBe('BIOSOLUCIONES DEL TURIA S L'.padEnd(40));
    expect(posiciones(t1, 58, 58)).toBe('T');
    expect(posiciones(t1, 59, 67)).toBe('963123456');
    expect(posiciones(t1, 68, 107)).toBe('GARCIA MUÑOZ ANA'.padEnd(40));
    expect(posiciones(t1, 108, 120)).toMatch(/^180\d{10}$/);
    expect(posiciones(t1, 121, 135)).toBe('  ' + '0'.repeat(13));
    expect(posiciones(t1, 136, 144)).toBe('000000003');
    expect(posiciones(t1, 145, 145)).toBe(' ');
    expect(posiciones(t1, 146, 160)).toBe('000000001850000');
    expect(posiciones(t1, 161, 175)).toBe('000000000351500');
    expect(posiciones(t1, 176, 500)).toBe(' '.repeat(325));
  });

  it('tipo 2 de la persona física: NIF, nombre, provincia, base, %, retención e inmueble', () => {
    const l = t2[0];
    expect(posiciones(l, 1, 17)).toBe(`21802027${NIF}`);
    expect(posiciones(l, 18, 26)).toBe(DNI);
    expect(posiciones(l, 27, 35)).toBe(' '.repeat(9));
    expect(posiciones(l, 36, 75)).toBe('MARTINEZ PEÑA JOSE'.padEnd(40));
    expect(posiciones(l, 76, 77)).toBe('46');
    expect(posiciones(l, 78, 78)).toBe('1');
    expect(posiciones(l, 79, 79)).toBe(' ');
    expect(posiciones(l, 80, 92)).toBe('0000001200000');
    expect(posiciones(l, 93, 96)).toBe('1900');
    expect(posiciones(l, 97, 109)).toBe('0000000228000');
    expect(posiciones(l, 110, 113)).toBe('0000');
    expect(posiciones(l, 114, 114)).toBe('1');
    expect(posiciones(l, 115, 134)).toBe('9872023VH5797S0001WX');
    expect(posiciones(l, 135, 139)).toBe('CL   ');
    expect(posiciones(l, 140, 189)).toBe('COLON'.padEnd(50));
    expect(posiciones(l, 190, 192)).toBe('NUM');
    expect(posiciones(l, 193, 197)).toBe('12   ');
    expect(posiciones(l, 198, 209)).toBe(' '.repeat(12));
    expect(posiciones(l, 210, 212)).toBe('BJ ');
    expect(posiciones(l, 213, 215)).toBe('2  ');
    expect(posiciones(l, 216, 285)).toBe(' '.repeat(70));
    expect(posiciones(l, 286, 315)).toBe('VALENCIA'.padEnd(30));
    expect(posiciones(l, 316, 320)).toBe('46250');
    expect(posiciones(l, 321, 322)).toBe('46');
    expect(posiciones(l, 323, 327)).toBe('46004');
    expect(posiciones(l, 328, 500)).toBe(' '.repeat(173));
  });

  it('tipo 2 de la sociedad: S/N, complemento y el registro con ejercicio de devengo', () => {
    const [, sociedad, devengo] = t2;
    expect(posiciones(sociedad, 18, 26)).toBe(CIF_ARRENDADORA);
    expect(posiciones(sociedad, 36, 75)).toBe('INMUEBLES ÑORA S L'.padEnd(40));
    expect(posiciones(sociedad, 190, 192)).toBe('S/N');
    expect(posiciones(sociedad, 193, 197)).toBe(' '.repeat(5));
    expect(posiciones(sociedad, 216, 255)).toBe('CENTRO COMERCIAL LAS ROSAS LOCAL 14'.padEnd(40));
    expect(posiciones(sociedad, 110, 113)).toBe('0000');
    expect(posiciones(devengo, 80, 92)).toBe('0000000050000');
    expect(posiciones(devengo, 97, 109)).toBe('0000000009500');
    expect(posiciones(devengo, 110, 113)).toBe('2026');
  });

  it('la pantalla lee el mismo fichero', () => {
    const p = leerFichero180(fichero);
    const t = Object.fromEntries(p.declarante.map((c) => [c.id, c.valor]));
    expect(t).toMatchObject({ numeroPerceptores: '000000003', importeBases: 18500, importeRetenciones: 3515, tipoSoporte: 'T' });
    expect(p.perceptores.map((r) => [r.nifPerceptor, r.base, r.porcentaje, r.retenciones, r.ejercicioDevengo, r.referenciaCatastral])).toEqual([
      [DNI, 12000, 19, 2280, '0000', '9872023VH5797S0001WX'],
      [CIF_ARRENDADORA, 6000, 19, 1140, '0000', '0847106VK4704F0001LK'],
      [CIF_ARRENDADORA, 500, 19, 95, '2026', '0847106VK4704F0001LK'],
    ]);
  });

  it('cuadra con los cuatro 115 del año, en céntimos', () => {
    const trimestres = [
      { periodo: '1T', base: 5000, retenciones: 950 },
      { periodo: '2T', base: 4500, retenciones: 855 },
      { periodo: '3T', base: 4500, retenciones: 855 },
      { periodo: '4T', base: 4500, retenciones: 855 },
    ];
    expect(cuadre180Con115(entrada(), trimestres)).toEqual({
      coincide: true,
      base180: 18500,
      retenciones180: 3515,
      base115: 18500,
      retenciones115: 3515,
      diferenciaBase: 0,
      diferenciaRetenciones: 0,
      faltan: [],
    });
    const malo = cuadre180Con115(entrada(), trimestres.slice(0, 3));
    expect(malo).toMatchObject({ coincide: false, diferenciaBase: 4500, diferenciaRetenciones: 855, faltan: ['4T'] });
  });
});

describe('180: reintegros, complementaria y lo que impide el fichero', () => {
  it('un reintegro lleva N en 79 y resta en el total (N en 145 si queda negativo)', () => {
    const e = entrada();
    e.perceptores = [{ ...e.perceptores[1], base: 300, retenciones: 57, reintegro: true, ejercicioDevengo: 2026 }];
    const [t1, l] = generarFichero180(e).split('\r\n');
    expect(posiciones(l, 79, 92)).toBe('N0000000030000');
    expect(posiciones(l, 110, 113)).toBe('2026');
    expect(posiciones(t1, 145, 160)).toBe('N000000000030000');
    expect(posiciones(t1, 161, 175)).toBe('000000000005700');
  });

  it('sustitutiva: S en 122 y la anterior en 123-135', () => {
    const e = entrada();
    e.declarante.tipoDeclaracion = 'S';
    e.declarante.declaracionAnterior = '1802027000001';
    const t1 = generarFichero180(e).split('\r\n')[0];
    expect(posiciones(t1, 121, 135)).toBe(' S1802027000001');
  });

  it('errores: NIF no español, sin referencia catastral, sin dirección, provincia, reintegro sin devengo', () => {
    const e = entrada();
    e.perceptores.push({ nif: 'FR12345678901', nombre: 'Dupont', provincia: '46', base: 100, porcentaje: 19, retenciones: 19, inmueble: valencia });
    e.perceptores.push({ nif: DNI, nombre: 'Sin ref', provincia: '46', base: 100, porcentaje: 19, retenciones: 19, inmueble: { ...valencia, referenciaCatastral: '' } });
    e.perceptores.push({ nif: DNI, nombre: 'Sin calle', provincia: '99', base: 100, porcentaje: 19, retenciones: 19, inmueble: { ...valencia, nombreVia: '', codigoMunicipio: '' } });
    e.perceptores.push({ nif: DNI, nombre: 'Reintegro', provincia: '46', base: 100, porcentaje: 19, retenciones: 19, reintegro: true, inmueble: valencia });
    expect(erroresEntrada180(e)).toEqual([
      expect.stringMatching(/Dupont.*NIF español/),
      expect.stringMatching(/Sin ref.*referencia catastral/),
      expect.stringMatching(/Sin calle.*provincia/),
      expect.stringMatching(/Sin calle.*vía/),
      expect.stringMatching(/Sin calle.*código INE/),
      expect.stringMatching(/Reintegro.*ejercicio/),
    ]);
    expect(() => generarFichero180(e)).toThrow(/Dupont/);
  });

  it('situación 4 (sin referencia catastral) no la pide', () => {
    const e = entrada();
    e.perceptores = [{ ...e.perceptores[0], inmueble: { ...valencia, situacion: 4, referenciaCatastral: '' } }];
    const l = generarFichero180(e).split('\r\n')[1];
    expect(posiciones(l, 114, 134)).toBe('4' + ' '.repeat(20));
  });
});
