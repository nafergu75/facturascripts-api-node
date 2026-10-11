/**
 * Test dorado del 202: el fichero cumple el diseno OFICIAL (DR202e25.xlsx
 * v1.3, "2025 y siguientes") campo a campo: cabecera <AUX> de 328, pagina 01
 * de 700, pagina 02 de 900 y cierre de 18, sin saltos entre ellos (1.946
 * caracteres) y CRLF al final. Comprueba con la tabla de campos
 * (src/domain/aeat/dr202-2025.json) y con las posiciones copiadas a mano del
 * Excel.
 *
 * Caso real: una S.L. de reducida dimension en 2027, modalidad A (art. 40.2
 * LIS: 18 % de la cuota del ultimo 200 vencido) en sus tres periodos: el 1P
 * con el 200 de 2025 y el 2P y el 3P con el de 2026.
 */
import { describe, it, expect } from '@jest/globals';
import { DISENO_202 } from '../domain/aeat/disenos';
import { comprobarFicheroPorTrozos, posiciones } from './dorado-dr';
import { controlCif } from '../utils/nif';
import {
  calcularModalidadA202,
  erroresEntrada202,
  generarFichero202,
  leerFichero202,
  type Entrada202,
  type Periodo202,
} from '../aeat/modelo202/modelo202.dr';

const NIF = `B4612345${controlCif('4612345').cifra}`;
const ORDEN = ['cabecera', 'pagina01', 'pagina02', 'cierre'];
const P01 = 328;
const P02 = 328 + 700;
const CIERRE = 328 + 700 + 900;

const entrada = (periodo: Periodo202, base: number, anterior = 0): Entrada202 => {
  const a = calcularModalidadA202(base, anterior);
  return {
    ejercicio: 2027,
    periodo,
    versionPrograma: '0100',
    nifEmpresaDesarrollo: '',
    tipoDeclaracion: a['03'] > 0 ? 'I' : 'N',
    nif: NIF,
    denominacion: 'Biosoluciones del Turia, S.L.',
    fechaInicioPeriodo: '2027-01-01',
    cnae: '72.11',
    marcas: { marcaErd: true },
    tipoGravamen: '22',
    tramoIncn: '0',
    modalidad: 'A',
    casillas: a,
  };
};

describe('202 dorado: modalidad A en los tres periodos de 2027', () => {
  const casos: Array<[Periodo202, number, string, string]> = [
    ['1P', 10000, '00000000001000000', '00000000000180000'],
    ['2P', 12345.67, '00000000001234567', '00000000000222222'],
    ['3P', 12345.67, '00000000001234567', '00000000000222222'],
  ];

  it.each(casos)('%s: estructura, constantes y casillas [01] y [03]', (periodo, base, c01, c03) => {
    const fichero = generarFichero202(entrada(periodo, base));
    const trozos = comprobarFicheroPorTrozos(DISENO_202, fichero, ORDEN);
    expect(fichero.length).toBe(1946 + 2);
    expect(fichero.endsWith('\r\n')).toBe(true);
    const f = fichero;

    // Cabecera <AUX>
    expect(posiciones(f, 1, 17)).toBe(`<T2020${'2027'}${periodo}0000>`);
    expect(posiciones(f, 18, 22)).toBe('<AUX>');
    expect(posiciones(f, 23, 92)).toBe(' '.repeat(70));
    expect(posiciones(f, 93, 96)).toBe('0100');
    expect(posiciones(f, 97, 100)).toBe('    ');
    expect(posiciones(f, 101, 109)).toBe(' '.repeat(9));
    expect(posiciones(f, 110, 322)).toBe(' '.repeat(213));
    expect(posiciones(f, 323, 328)).toBe('</AUX>');

    // Pagina 01
    const p1 = (d: number, h: number) => posiciones(f, P01 + d, P01 + h);
    expect(p1(1, 11)).toBe('<T20201000>');
    expect(p1(12, 12)).toBe(' ');
    expect(p1(13, 13)).toBe('I');
    expect(p1(14, 22)).toBe(NIF);
    expect(p1(23, 82)).toBe('BIOSOLUCIONES DEL TURIA S L'.padEnd(60));
    expect(p1(83, 103)).toBe(' '.repeat(21));
    expect(p1(104, 107)).toBe('2027');
    expect(p1(108, 109)).toBe(periodo);
    expect(p1(110, 117)).toBe('01012027');
    expect(p1(118, 121)).toBe('7211');
    expect(p1(122, 131)).toBe('    X     ');
    expect(p1(132, 146)).toBe('22'.padEnd(15));
    expect(p1(147, 147)).toBe('0');
    expect(p1(148, 148)).toBe('A');
    expect(p1(149, 165)).toBe(c01);
    expect(p1(166, 182)).toBe('0'.repeat(17));
    expect(p1(183, 199)).toBe(c03);
    expect(p1(200, 437)).toBe('0'.repeat(238));
    expect(p1(438, 688)).toBe(' '.repeat(251));
    expect(p1(689, 700)).toBe('</T20201000>');

    // Pagina 02: modalidad B a ceros, sin complementaria ni domiciliacion
    const p2 = (d: number, h: number) => posiciones(f, P02 + d, P02 + h);
    expect(p2(1, 12)).toBe('<T20202000> ');
    expect(p2(13, 501)).toBe('0'.repeat(489));
    expect(p2(502, 524)).toBe(' '.repeat(23));
    expect(p2(525, 711)).toBe('0'.repeat(187));
    expect(p2(712, 888)).toBe(' '.repeat(177));
    expect(p2(889, 900)).toBe('</T20202000>');

    // Cierre
    expect(posiciones(f, CIERRE + 1, CIERRE + 18)).toBe(`</T20202027${periodo}0000>`);

    // La pantalla lee el mismo fichero
    expect(trozos.pagina01.campos).toMatchObject({ modalidad: 'A', c01: base, c03: Number(c03) / 100, periodo });
    const p = leerFichero202(fichero);
    expect(p.pagina01.find((c) => c.id === 'c03')).toMatchObject({ casilla: '03', valor: Number(c03) / 100 });
  });

  it('18 % de la cuota en céntimos, menos la declaración anterior; nunca negativo', () => {
    expect(calcularModalidadA202(12345.67)).toEqual({ '01': 12345.67, '02': 0, '03': 2222.22 });
    expect(calcularModalidadA202(10000, 1000)).toEqual({ '01': 10000, '02': 1000, '03': 800 });
    expect(calcularModalidadA202(-500)).toEqual({ '01': 0, '02': 0, '03': 0 });
    expect(calcularModalidadA202(1000, 500)).toEqual({ '01': 1000, '02': 500, '03': 0 });
  });

  it('sin cuota: declaración negativa (N) con todo a ceros', () => {
    const f = generarFichero202(entrada('2P', 0));
    expect(posiciones(f, P01 + 13, P01 + 13)).toBe('N');
    expect(posiciones(f, P01 + 149, P01 + 199)).toBe('0'.repeat(51));
  });

  it('complementaria con domiciliación: [02], X en 712, justificante y IBAN de 24', () => {
    const e = entrada('3P', 12345.67, 1000);
    e.tipoDeclaracion = 'U';
    e.complementaria = true;
    e.justificanteAnterior = '2021234567890';
    e.iban = 'es91 2100 0418 4502 0005 1332';
    const f = generarFichero202(e);
    comprobarFicheroPorTrozos(DISENO_202, f, ORDEN);
    expect(posiciones(f, P01 + 13, P01 + 13)).toBe('U');
    expect(posiciones(f, P01 + 166, P01 + 182)).toBe('00000000000100000');
    expect(posiciones(f, P01 + 183, P01 + 199)).toBe('00000000000122222');
    expect(posiciones(f, P02 + 712, P02 + 725)).toBe('X2021234567890');
    expect(posiciones(f, P02 + 726, P02 + 759)).toBe('ES9121000418450200051332'.padEnd(34));
  });

  it('modalidad B: los campos N llevan la N y el porcentaje va con 5 cifras', () => {
    const e = entrada('1P', 0);
    e.modalidad = 'B';
    e.tipoDeclaracion = 'I';
    e.casillas = { '04': -1234.5, '13': -1234.5, '16': 0, '17': 17, '34': 0 };
    const f = generarFichero202(e);
    comprobarFicheroPorTrozos(DISENO_202, f, ORDEN);
    expect(posiciones(f, P01 + 148, P01 + 148)).toBe('B');
    expect(posiciones(f, P01 + 200, P01 + 216)).toBe('N0000000000123450');
    expect(posiciones(f, P01 + 353, P01 + 369)).toBe('N0000000000123450');
    expect(posiciones(f, P02 + 30, P02 + 34)).toBe('01700');
  });
});

describe('202: lo que impide el fichero', () => {
  it('NIF, periodo, IBAN para domiciliar, justificante y negativos en campos sin signo', () => {
    const e = entrada('1P', 1000);
    e.nif = 'X';
    e.periodo = '4P' as never;
    e.tipoDeclaracion = 'U';
    e.complementaria = true;
    e.casillas = { ...e.casillas, '05': -3 };
    expect(erroresEntrada202(e)).toEqual([
      expect.stringMatching(/NIF/),
      expect.stringMatching(/periodo/),
      expect.stringMatching(/IBAN/),
      expect.stringMatching(/justificante/),
      expect.stringMatching(/\[05\].*negativ/),
    ]);
    expect(() => generarFichero202(e)).toThrow(/NIF/);
  });

  it('el 202 de la modalidad A con [03] > 0 no puede ser negativo (N)', () => {
    const e = entrada('1P', 1000);
    e.tipoDeclaracion = 'N';
    expect(erroresEntrada202(e)).toEqual([expect.stringMatching(/negativa/)]);
  });
});
