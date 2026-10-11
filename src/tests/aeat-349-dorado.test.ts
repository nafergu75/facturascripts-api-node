/**
 * Test dorado del 349: el fichero cumple el diseno OFICIAL (DR_Anexo_349.pdf,
 * Orden HAC/174/2020) campo a campo. Comprueba con la tabla de campos
 * (src/domain/aeat/dr349.json) y, ademas, las posiciones copiadas a mano del
 * PDF, para que una errata en la tabla no pase desapercibida.
 *
 * Caso real: segundo trimestre de 2027 con entregas (E) a Alemania y Francia,
 * adquisiciones de bienes (A) a Italia (ficha sin prefijo de pais), servicios
 * prestados (S) a Portugal (NIF con guiones), servicios recibidos (I) de Grecia
 * (prefijo EL) y una rectificacion de una entrega del primer trimestre.
 */
import { describe, it, expect } from '@jest/globals';
import { DISENO_349 } from '../domain/aeat/disenos';
import { comprobarFicheroPorLineas, posiciones } from './dorado-dr';
import { controlCif } from '../utils/nif';
import {
  erroresEntrada349,
  generarFichero349,
  leerFichero349,
  type Entrada349,
} from '../aeat/modelo349/modelo349.dr';
import { separarNifIva } from '../aeat/common/normalizacion';

const NIF = `B4612345${controlCif('4612345').cifra}`;

const entrada = (): Entrada349 => ({
  ejercicio: 2027,
  periodo: '2T',
  declarante: {
    nif: NIF.toLowerCase(),
    nombre: 'Biosoluciones del Turia, S.L.',
    telefono: '+34 963 12 34 56',
    personaContacto: 'García Muñoz Ana',
    numeroDeclaracion: '3492027000001',
  },
  operadores: [
    { nifIva: 'DE123456789', nombre: 'Müller Handels GmbH', clave: 'E', base: 12500 },
    { nifIva: 'FR12345678901', nombre: "Société Générale d'Équipements", clave: 'E', base: 3200.5 },
    { nifIva: '12345678901', pais: 'IT', nombre: 'Rossi S.p.A.', clave: 'A', base: 8000 },
    { nifIva: 'pt 123-456-789', pais: 'PT', nombre: 'Peñas & Filhos, Lda.', clave: 'S', base: 950 },
    { nifIva: 'EL123456789', pais: 'GR', nombre: 'Papadopoulos AE', clave: 'I', base: 400.1 },
  ],
  rectificaciones: [
    { nifIva: 'DE123456789', nombre: 'Müller Handels GmbH', clave: 'E', ejercicio: 2027, periodo: '1T', baseRectificada: 11000, baseAnterior: 12000 },
  ],
});

describe('349 dorado: fichero con el diseño oficial', () => {
  const fichero = generarFichero349(entrada());
  const lineas = comprobarFicheroPorLineas(DISENO_349, fichero, (l, i) =>
    i === 0 ? 'declarante' : posiciones(l, 134, 146).trim() === '' ? 'rectificacion' : 'operador',
  );
  const [t1, ...t2] = lineas.map((l) => l.linea);

  it('un registro de declarante, cinco de operador y uno de rectificación, de 500 y con CRLF', () => {
    expect(lineas.map((l) => l.registro)).toEqual(['declarante', 'operador', 'operador', 'operador', 'operador', 'operador', 'rectificacion']);
    expect(fichero.split('\r\n').slice(0, -1).every((l) => l.length === 500)).toBe(true);
  });

  it('va en ISO-8859-1: un byte por carácter, con la Ñ', () => {
    expect(Buffer.from(fichero, 'latin1').length).toBe(fichero.length);
    expect(Buffer.from(fichero, 'latin1').toString('latin1')).toBe(fichero);
  });

  it('tipo 1, posiciones del PDF', () => {
    expect(posiciones(t1, 1, 1)).toBe('1');
    expect(posiciones(t1, 2, 4)).toBe('349');
    expect(posiciones(t1, 5, 8)).toBe('2027');
    expect(posiciones(t1, 9, 17)).toBe(NIF);
    expect(posiciones(t1, 18, 57)).toBe('BIOSOLUCIONES DEL TURIA SL'.padEnd(40));
    expect(posiciones(t1, 58, 58)).toBe(' ');
    expect(posiciones(t1, 59, 67)).toBe('963123456');
    expect(posiciones(t1, 68, 107)).toBe('GARCIA MUÑOZ ANA'.padEnd(40));
    expect(posiciones(t1, 108, 120)).toMatch(/^349\d{10}$/);
    expect(posiciones(t1, 121, 122)).toBe('  ');
    expect(posiciones(t1, 123, 135)).toBe('0'.repeat(13));
    expect(posiciones(t1, 136, 137)).toBe('2T');
    expect(posiciones(t1, 138, 146)).toBe('000000005');
    // 12500 + 3200,50 + 8000 + 950 + 400,10 = 25.050,60
    expect(posiciones(t1, 147, 161)).toBe('000000002505060');
    expect(posiciones(t1, 162, 170)).toBe('000000001');
    expect(posiciones(t1, 171, 185)).toBe('000000001100000');
    expect(posiciones(t1, 186, 500)).toBe(' '.repeat(315));
  });

  it('tipo 2 de operador: país y número del NIF-IVA separados, clave y base', () => {
    const esperado = [
      ['DE', '123456789', 'MULLER HANDELS GMBH', 'E', '0000001250000'],
      ['FR', '12345678901', 'SOCIETE GENERALE DEQUIPEMENTS', 'E', '0000000320050'],
      ['IT', '12345678901', 'ROSSI SPA', 'A', '0000000800000'],
      ['PT', '123456789', 'PEÑAS FILHOS LDA', 'S', '0000000095000'],
      ['EL', '123456789', 'PAPADOPOULOS AE', 'I', '0000000040010'],
    ];
    t2.slice(0, 5).forEach((l, i) => {
      const [pais, numero, nombre, clave, base] = esperado[i];
      expect(posiciones(l, 1, 17)).toBe(`2349${'2027'}${NIF}`);
      expect(posiciones(l, 18, 75)).toBe(' '.repeat(58));
      expect(posiciones(l, 76, 77)).toBe(pais);
      expect(posiciones(l, 78, 92)).toBe(numero.padEnd(15));
      expect(posiciones(l, 93, 132)).toBe(nombre.padEnd(40));
      expect(posiciones(l, 133, 133)).toBe(clave);
      expect(posiciones(l, 134, 146)).toBe(base);
      expect(posiciones(l, 147, 500)).toBe(' '.repeat(354));
    });
  });

  it('tipo 2 de rectificación: base en blanco, periodo corregido, base rectificada y anterior', () => {
    const r = t2[5];
    expect(posiciones(r, 1, 17)).toBe(`23492027${NIF}`);
    expect(posiciones(r, 76, 92)).toBe('DE' + '123456789'.padEnd(15));
    expect(posiciones(r, 133, 133)).toBe('E');
    expect(posiciones(r, 134, 146)).toBe(' '.repeat(13));
    expect(posiciones(r, 147, 150)).toBe('2027');
    expect(posiciones(r, 151, 152)).toBe('1T');
    expect(posiciones(r, 153, 165)).toBe('0000001100000');
    expect(posiciones(r, 166, 178)).toBe('0000001200000');
    expect(posiciones(r, 179, 500)).toBe(' '.repeat(322));
  });

  it('la pantalla lee el mismo fichero: mismas casillas y totales', () => {
    const p = leerFichero349(fichero);
    const t = Object.fromEntries(p.declarante.map((c) => [c.id, c.valor]));
    expect(t).toMatchObject({ numeroOperadores: '000000005', importeOperaciones: 25050.6, numeroRectificaciones: '000000001', importeRectificaciones: 11000, periodo: '2T' });
    expect(p.operadores.map((o) => [o.paisOperador, o.numeroOperador, o.clave, o.base])).toEqual([
      ['DE', '123456789', 'E', 12500],
      ['FR', '12345678901', 'E', 3200.5],
      ['IT', '12345678901', 'A', 8000],
      ['PT', '123456789', 'S', 950],
      ['EL', '123456789', 'I', 400.1],
    ]);
    expect(p.rectificaciones).toEqual([
      expect.objectContaining({ paisOperador: 'DE', clave: 'E', ejercicioRectificado: '2027', periodoRectificado: '1T', baseRectificada: 11000, baseAnterior: 12000 }),
    ]);
  });
});

describe('349: complementaria, sustitutiva y periodicidad', () => {
  it('C en 121 con la declaración anterior en 123-135', () => {
    const e = entrada();
    e.declarante.tipoDeclaracion = 'C';
    e.declarante.declaracionAnterior = '3492027240001';
    const t1 = generarFichero349(e).split('\r\n')[0];
    expect(posiciones(t1, 121, 122)).toBe('C ');
    expect(posiciones(t1, 123, 135)).toBe('3492027240001');
  });

  it('S en 122', () => {
    const e = entrada();
    e.declarante.tipoDeclaracion = 'S';
    e.declarante.declaracionAnterior = '3492027240001';
    expect(posiciones(generarFichero349(e).split('\r\n')[0], 121, 122)).toBe(' S');
  });

  it('X en 186 en la mensual de los dos primeros meses', () => {
    const e = { ...entrada(), periodo: '05', cambioPeriodicidad: true };
    e.declarante.numeroDeclaracion = '3492027000002';
    const t1 = generarFichero349(e).split('\r\n')[0];
    expect(posiciones(t1, 136, 137)).toBe('05');
    expect(posiciones(t1, 186, 186)).toBe('X');
  });

  it('sin operaciones: solo el tipo 1, con ceros', () => {
    const e = { ...entrada(), operadores: [], rectificaciones: [] };
    const f = generarFichero349(e);
    expect(f.split('\r\n')).toHaveLength(2);
    expect(posiciones(f, 138, 185)).toBe('0'.repeat(48));
  });
});

describe('349: lo que impide el fichero', () => {
  it('operador sin NIF-IVA de la UE, base negativa, clave rara, C sin sustituto y C sin anterior', () => {
    const e = entrada();
    e.operadores.push({ nifIva: 'B12345678', pais: 'ES', nombre: 'Nacional SL', clave: 'E', base: 10 });
    e.operadores.push({ nifIva: 'DE999999999', nombre: 'Negativo GmbH', clave: 'E', base: -5 });
    e.operadores.push({ nifIva: 'DE888888888', nombre: 'Rara GmbH', clave: 'Z' as never, base: 5 });
    e.operadores.push({ nifIva: 'DE777777777', nombre: 'Consigna GmbH', clave: 'C', base: 5 });
    e.declarante.tipoDeclaracion = 'C';
    const errores = erroresEntrada349(e);
    expect(errores).toEqual([
      expect.stringMatching(/declaración anterior/),
      expect.stringMatching(/Nacional SL.*NIF-IVA/),
      expect.stringMatching(/Negativo GmbH.*negativ/),
      expect.stringMatching(/Rara GmbH.*clave/),
      expect.stringMatching(/Consigna GmbH.*sustituto/),
    ]);
    expect(() => generarFichero349(e)).toThrow(/declaración anterior/);
  });

  it('sin NIF del declarante', () => {
    const e = entrada();
    e.declarante.nif = '';
    expect(erroresEntrada349(e)).toEqual([expect.stringMatching(/NIF de la empresa/)]);
  });

  it('separa el NIF-IVA: prefijo, país de la ficha o nada', () => {
    expect(separarNifIva('de 123.456.789')).toEqual({ pais: 'DE', numero: '123456789' });
    expect(separarNifIva('123456789', 'GR')).toEqual({ pais: 'EL', numero: '123456789' });
    expect(separarNifIva('123456789', 'GRC')).toEqual({ pais: 'EL', numero: '123456789' });
    expect(separarNifIva('B12345678', 'ES')).toBeNull();
    expect(separarNifIva('123456789', 'US')).toBeNull();
    expect(separarNifIva('', 'DE')).toBeNull();
  });

  // El número de la declaración lo pone el historial (declaracionesAeat): ver aeat-declaraciones.db.test.
});
