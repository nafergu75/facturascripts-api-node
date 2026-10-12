/**
 * Test "dorado" del 200: el fichero se compara campo a campo con la tabla del
 * diseño de registro OFICIAL vers. 1.02 del ejercicio 2025
 * (src/domain/aeat/dr200-2025.json, copiada de DR200e25.xls) en las páginas
 * que se generan. Casos reales: una S.L. pyme con beneficio (tipo de las
 * micro, bases negativas, retenciones y pagos fraccionados: a ingresar) y otra
 * con pérdidas (base negativa: a devolver las retenciones, o resultado cero).
 */
import dr200 from '../domain/aeat/dr200-2025.json';
import { construirModelo200, DISENO_200, tipoGravamen200, type Entrada200 } from '../aeat/oficial/modelo200';
import { validarRegistro, type PaginaOficial } from '../aeat/oficial/diseno';

const PAGINAS = (dr200 as any).paginas as Record<string, PaginaOficial>;
const campo = (linea: string, pos: number, len: number) => linea.slice(pos - 1, pos - 1 + len);
const n17 = (euros: number) => {
  const c = Math.round(euros * 100);
  return c < 0 ? 'N' + String(-c).padStart(16, '0') : String(c).padStart(17, '0');
};

const pyg = (partidas: Array<[string, number]>, agregados: Partial<Entrada200['pyg']>): Entrada200['pyg'] => ({
  importeNetoCifraNegocios: 0,
  otrosIngresosExplotacion: 0,
  aprovisionamientos: 0,
  gastosPersonal: 0,
  otrosGastosExplotacion: 0,
  amortizaciones: 0,
  resultadoExplotacion: 0,
  ingresosFinancieros: 0,
  gastosFinancieros: 0,
  resultadoFinanciero: 0,
  resultadoAntesImpuestos: 0,
  impuestoBeneficios: 0,
  resultadoEjercicio: 0,
  partidas: partidas.map(([codigo, importe]) => ({ codigo, descripcion: codigo, importe })),
  ...agregados,
});
const p = (codigo: string, importe: number) => ({ codigo, descripcion: codigo, importe });

const ID: Entrada200['identificacion'] = {
  nif: 'B98765431',
  razonSocial: 'Cerámicas Peña, S.L.',
  cnae: '4646',
  telefono: '+34 961 23 45 67',
  email: 'conta@ceramicas-pena.es',
  contacto: 'García Pérez, Ana',
  fechaInicio: '2025-01-01',
  fechaFin: '2025-12-31',
  fechaConstitucion: '2015-03-01',
};

/** S.L. con beneficio: INCN 300.000 €, resultado antes de impuestos 44.000 €. */
const BENEFICIO: Entrada200 = {
  ejercicio: 2025,
  identificacion: ID,
  balance: {
    activoNoCorriente: [p('A.II', 30000)],
    activoCorriente: [p('B.II', 10000), p('B.III.1', 25000), p('B.III.3', 1500), p('B.VII', 40000)],
    patrimonioNeto: [p('A1.I', 3000), p('A1.III', 17240), p('A1.VII', 34760)],
    pasivoNoCorriente: [p('C.II', 20000)],
    pasivoCorriente: [p('D.II', 5000), p('D.IV.1', 15000), p('D.IV.2', 11500)],
    totalActivo: 106500,
    totalPatrimonioNetoYPasivo: 106500,
    descuadre: 0,
  },
  pyg: pyg(
    [['1', 300000], ['4', -150000], ['6', -60000], ['7', -40000], ['8', -5000], ['13', 500], ['14', -1500], ['18', -9240]],
    { importeNetoCifraNegocios: 300000, resultadoExplotacion: 45000, resultadoFinanciero: -1000, resultadoAntesImpuestos: 44000, impuestoBeneficios: 9240, resultadoEjercicio: 34760 },
  ),
  reservaLegal: 600,
  incnAnterior: 280000,
  plantilla: { fijo: 2.5, noFijo: 0 },
  binsPendientes: 5000,
  pagosFraccionados: [1000, 1000, 1000],
  retenciones: 120,
  iban: 'ES91 2100 0418 4502 0005 1332',
  programa: { versionPrograma: 'CA01', nifEmpresaDesarrollo: 'B11111119' },
};

/** S.L. con pérdidas: resultado -18.500 €, retenciones de 50 €. */
const PERDIDAS: Entrada200 = {
  ...BENEFICIO,
  balance: {
    activoNoCorriente: [],
    activoCorriente: [p('B.III.1', 10000), p('B.VII', 5000)],
    patrimonioNeto: [p('A1.I', 3000), p('A1.V', -2000), p('A1.VII', -18500)],
    pasivoNoCorriente: [],
    pasivoCorriente: [p('D.II', 24000), p('D.IV.1', 8500)],
    totalActivo: 15000,
    totalPatrimonioNetoYPasivo: 15000,
    descuadre: 0,
  },
  pyg: pyg(
    [['1', 120000], ['4', -80000], ['6', -40000], ['7', -15000], ['8', -3000], ['14', -500]],
    { importeNetoCifraNegocios: 120000, resultadoExplotacion: -18000, resultadoFinanciero: -500, resultadoAntesImpuestos: -18500, resultadoEjercicio: -18500 },
  ),
  reservaLegal: 0,
  incnAnterior: 150000,
  binsPendientes: 0,
  pagosFraccionados: [0, 0, 0],
  retenciones: 50,
};

/** Separa el fichero en cabecera, páginas (validadas contra su diseño) y cierre. */
function trocear(fichero: string) {
  const paginas: Record<string, string> = {};
  const orden: string[] = [];
  let resto = fichero.slice(328, -18);
  while (resto.length) {
    const codigo = resto.slice(5, 10);
    const d = PAGINAS[codigo];
    if (!d) throw new Error(`Página desconocida ${codigo}`);
    const linea = resto.slice(0, d.longitud);
    paginas[codigo] = linea;
    orden.push(codigo);
    resto = resto.slice(d.longitud);
  }
  return { cabecera: fichero.slice(0, 328), cierre: fichero.slice(-18), paginas, orden };
}

describe('200 dorado: diseño oficial vers. 1.02 (ejercicio 2025)', () => {
  it('la tabla del diseño cubre cada página generada sin huecos y con su longitud', () => {
    for (const [codigo, d] of Object.entries(PAGINAS)) {
      let pos = 1;
      for (const c of d.campos) {
        expect([codigo, c.pos]).toEqual([codigo, pos]);
        pos += c.len;
      }
      expect([codigo, pos - 1]).toEqual([codigo, d.longitud]);
      expect(DISENO_200.indice.find((x) => x.pagina === codigo)?.longitud).toBe(d.longitud);
    }
  });

  describe('S.L. con beneficio', () => {
    const decl = construirModelo200(BENEFICIO);
    const { cabecera, cierre, paginas: pg, orden } = trocear(decl.fichero);

    it('fichero: cabecera <AUX>, páginas en el orden del diseño sin separadores y cierre', () => {
      expect(decl.errores).toEqual([]);
      expect(decl.fichero).not.toMatch(/[\r\n]/);
      expect(campo(cabecera, 1, 17)).toBe('<T200020250A0000>');
      expect(campo(cabecera, 18, 5)).toBe('<AUX>');
      expect(campo(cabecera, 23, 70).trim()).toBe('');
      expect(campo(cabecera, 93, 4)).toBe('CA01');
      expect(campo(cabecera, 101, 9)).toBe('B11111119');
      expect(campo(cabecera, 110, 213).trim()).toBe('');
      expect(campo(cabecera, 323, 6)).toBe('</AUX>');
      expect(cierre).toBe('</T200020250A0000>');
      expect(orden).toEqual(['01000', '01B00', '03000', '04000', '05000', '06000', '07000', '08000', '12000', '14000', '14B00', 'DID00']);
      expect(orden).toEqual(DISENO_200.orden.filter((c) => orden.includes(c)));
      for (const codigo of orden) {
        const linea = pg[codigo];
        expect(linea.startsWith(`<T200${codigo}>`)).toBe(true);
        expect(linea.endsWith(`</T200${codigo}>`)).toBe(true);
        expect([codigo, validarRegistro(PAGINAS[codigo], linea)]).toEqual([codigo, []]);
        expect(campo(linea, 12, 1)).toBe(' ');
      }
    });

    it('página 1: identificación, periodo, CNAE y caracteres de una pyme', () => {
      const l = pg['01000'];
      expect(campo(l, 13, 1)).toBe('I');
      expect(campo(l, 14, 9)).toBe('B98765431');
      expect(campo(l, 23, 80)).toBe('CERAMICAS PEÑA SL'.padEnd(80));
      expect(campo(l, 103, 4)).toBe('2025');
      expect(campo(l, 107, 2)).toBe('0A');
      expect(campo(l, 109, 16)).toBe('2025010120251231');
      expect(campo(l, 125, 1)).toBe('1');
      expect(campo(l, 126, 4)).toBe('4646');
      expect(campo(l, 131, 9)).toBe('961234567');
      expect(campo(l, 149, 14)).toBe('0'.repeat(14)); // no rectificativa
      expect(campo(l, 193, 1)).toBe('1'); // [00006] incentivos ERD
      expect(campo(l, 219, 1)).toBe('0'); // [00027] base positiva
      expect(campo(l, 226, 1)).toBe('0'); // [00071] no es de nueva creación
      expect(campo(l, 227, 1)).toBe('1'); // [00088] INCN anterior < 1 M€
      expect(campo(l, 241, 3)).toBe('100'); // INCN < 20 M€
      expect(campo(l, 244, 41)).toBe(' '.repeat(41)); // reservado y EEDD en blanco
      expect(campo(l, 285, 50)).toBe('GARCIA PEREZ ANA'.padEnd(50));
      expect(campo(l, 335, 9)).toBe('961234567');
      expect(campo(l, 344, 9)).toBe('000000000');
      expect(campo(l, 353, 50)).toBe('conta@ceramicas-pena.es'.padEnd(50));
      expect(campo(l, 403, 213).trim()).toBe('');
      expect(Buffer.from(l, 'latin1')[22 + 12]).toBe(0xd1); // 'Ñ' en ISO-8859-1
    });

    it('página 1 bis: modelo PYMES y plantilla media (7 enteros y 2 decimales)', () => {
      const l = pg['01B00'];
      expect(campo(l, 13, 143).trim()).toBe(''); // sin grupo fiscal ni mercantil
      expect(campo(l, 156, 3)).toBe('303');
      expect(campo(l, 162, 9)).toBe('000000250');
      expect(campo(l, 171, 9)).toBe('000000000');
    });

    it('balance (páginas 3 a 6) con las partidas del modelo PYMES', () => {
      expect(campo(pg['03000'], 13, 17)).toBe(n17(30000)); // [00101]
      expect(campo(pg['03000'], 200, 17)).toBe(n17(30000)); // [00111]
      expect(campo(pg['03000'], 625, 17)).toBe(n17(76500)); // [00136]
      expect(campo(pg['03000'], 659, 17)).toBe(n17(10000)); // [00138]
      expect(campo(pg['04000'], 13, 17)).toBe(n17(26500)); // [00149]
      expect(campo(pg['04000'], 30, 17)).toBe(n17(25000)); // [00150]
      expect(campo(pg['04000'], 183, 17)).toBe(n17(1500)); // [00159]
      expect(campo(pg['04000'], 489, 17)).toBe(n17(40000)); // [00177]
      expect(campo(pg['04000'], 540, 17)).toBe(n17(106500)); // [00180]
      expect(campo(pg['05000'], 13, 17)).toBe(n17(55000)); // [00185]
      expect(campo(pg['05000'], 30, 17)).toBe(n17(55000)); // [00186]
      expect(campo(pg['05000'], 47, 17)).toBe(n17(3000)); // [00187]
      expect(campo(pg['05000'], 64, 17)).toBe(n17(3000)); // [00188]
      expect(campo(pg['05000'], 149, 17)).toBe(n17(17240)); // [00191]
      expect(campo(pg['05000'], 166, 17)).toBe(n17(600)); // [00192] legal
      expect(campo(pg['05000'], 183, 17)).toBe(n17(16640)); // [00193] otras
      expect(campo(pg['05000'], 387, 17)).toBe(n17(34760)); // [00199]
      expect(campo(pg['05000'], 608, 17)).toBe(n17(20000)); // [00210]
      expect(campo(pg['05000'], 795, 17)).toBe(n17(20000)); // [00216]
      expect(campo(pg['06000'], 13, 17)).toBe(n17(31500)); // [00228]
      expect(campo(pg['06000'], 183, 17)).toBe(n17(5000)); // [00231]
      expect(campo(pg['06000'], 319, 17)).toBe(n17(26500)); // [00239]
      expect(campo(pg['06000'], 336, 17)).toBe(n17(15000)); // [00240]
      expect(campo(pg['06000'], 489, 17)).toBe(n17(11500)); // [00249]
      expect(campo(pg['06000'], 540, 17)).toBe(n17(106500)); // [00252]
    });

    it('PyG (páginas 7 y 8) con los gastos en negativo', () => {
      expect(campo(pg['07000'], 13, 17)).toBe(n17(300000)); // [00255]
      expect(campo(pg['07000'], 183, 17)).toBe('N' + '15000000'.padStart(16, '0')); // [00260]
      expect(campo(pg['07000'], 472, 17)).toBe(n17(-60000)); // [00270]
      expect(campo(pg['07000'], 625, 17)).toBe(n17(-40000)); // [00279]
      expect(campo(pg['07000'], 761, 17)).toBe(n17(-5000)); // [00284]
      expect(campo(pg['07000'], 1033, 17)).toBe(n17(45000)); // [00296]
      expect(campo(pg['08000'], 13, 17)).toBe(n17(500)); // [00297]
      expect(campo(pg['08000'], 166, 17)).toBe(n17(-1500)); // [00305]
      expect(campo(pg['08000'], 574, 17)).toBe(n17(-1000)); // [00324]
      expect(campo(pg['08000'], 591, 17)).toBe(n17(44000)); // [00325]
      expect(campo(pg['08000'], 608, 17)).toBe(n17(-9240)); // [00326]
      expect(campo(pg['08000'], 625, 17)).toBe(n17(34760)); // [00327]
      expect(campo(pg['08000'], 659, 17)).toBe(n17(34760)); // [00500]
    });

    it('página 12: resultado contable y corrección por el impuesto', () => {
      const l = pg['12000'];
      expect(campo(l, 13, 17)).toBe(n17(34760)); // [00500]
      expect(campo(l, 30, 17)).toBe(n17(9240)); // [00301] aumentos
      expect(campo(l, 47, 17)).toBe(n17(0)); // [00302]
      expect(campo(l, 81, 17)).toBe(n17(44000)); // [00501]
    });

    it('página 14: BINs, base imponible, tipo doble de las micro y cuota íntegra', () => {
      const l = pg['14000'];
      expect(campo(l, 13, 17)).toBe(n17(44000)); // [00550]
      expect(campo(l, 115, 17)).toBe(n17(5000)); // [00547]
      expect(campo(l, 166, 17)).toBe(n17(39000)); // [00552]
      expect(campo(l, 217, 17)).toBe(n17(39000)); // [01330]
      expect(campo(l, 438, 4)).toBe('2122'); // [00558] 21 % y 22 %
      expect(campo(l, 646, 17)).toBe(n17(8190)); // [00562] = 39.000 x 21 %
      expect(campo(l, 952, 17)).toBe(n17(8190)); // [00582]
    });

    it('página 14 bis: cuota líquida, retenciones, pagos fraccionados y resultado', () => {
      const l = pg['14B00'];
      expect(campo(l, 251, 17)).toBe(n17(8190)); // [00592]
      expect(campo(l, 541, 17)).toBe(n17(120)); // [01766]
      expect(campo(l, 575, 17)).toBe(n17(8070)); // [00599]
      expect(campo(l, 609, 17)).toBe(n17(1000)); // [00601]
      expect(campo(l, 643, 17)).toBe(n17(1000)); // [00603]
      expect(campo(l, 677, 17)).toBe(n17(1000)); // [00605]
      expect(campo(l, 711, 17)).toBe(n17(5070)); // [00611]
      expect(campo(l, 1051, 17)).toBe(n17(5070)); // [01586]
      expect(campo(l, 1153, 17)).toBe(n17(5070)); // [00621]
    });

    it('DID: ingreso, la última página', () => {
      const l = pg['DID00'];
      expect(campo(l, 13, 1)).toBe('0');
      expect(campo(l, 14, 4)).toBe('2025');
      expect(campo(l, 18, 1)).toBe('1');
      expect(campo(l, 19, 2)).toBe('0A');
      expect(campo(l, 21, 12)).toBe('010125311225');
      expect(campo(l, 33, 9)).toBe('B98765431');
      expect(campo(l, 42, 80)).toBe('CERAMICAS PEÑA SL'.padEnd(80));
      expect(campo(l, 122, 17)).toBe(n17(39000));
      expect(campo(l, 139, 17)).toBe(n17(8190));
      expect(campo(l, 156, 17)).toBe(n17(5070));
      expect(campo(l, 173, 17)).toBe(n17(5070));
      expect(campo(l, 207, 1)).toBe(' ');
      expect(campo(l, 425, 1)).toBe('I');
      expect(campo(l, 426, 17)).toBe(n17(5070));
      expect(campo(l, 562, 1)).toBe('0');
    });

    it('la pantalla enseña las mismas casillas que el fichero', () => {
      expect(decl.liquidacion).toMatchObject({ baseImponible: 39000, cuotaIntegra: 8190, resultado: 5070, tipoDeclaracion: 'I' });
      for (const pag of decl.paginas) {
        for (const [cas, valor] of Object.entries(pag.casillas)) {
          if (typeof valor !== 'number') continue;
          const c = PAGINAS[pag.codigo].campos.find((x) => x.casilla !== undefined && Number(x.casilla) === Number(cas))!;
          const txt = campo(pag.linea, c.pos, c.len);
          const leido = (txt.startsWith('N') ? -1 : 1) * Number(txt.replace('N', ''));
          expect([pag.codigo, cas, leido]).toEqual([pag.codigo, cas, cas === '00558' ? valor : Math.round(valor * 100)]);
        }
      }
    });

    it('lista las páginas del diseño que quedan por completar', () => {
      const pendientes = decl.paginasPendientes.map((x) => x.codigo);
      expect(pendientes).toEqual(expect.arrayContaining(['02000', '09000', '10000', '13000', '15000', '20B00', '20D00']));
      expect(pendientes.length + decl.paginas.length).toBe(DISENO_200.indice.length);
    });
  });

  describe('S.L. con pérdidas', () => {
    const decl = construirModelo200(PERDIDAS);
    const { paginas: pg } = trocear(decl.fichero);

    it('todas las páginas cumplen el diseño', () => {
      expect(decl.errores).toEqual([]);
      for (const [codigo, linea] of Object.entries(pg)) expect([codigo, validarRegistro(PAGINAS[codigo], linea)]).toEqual([codigo, []]);
    });

    it('base negativa: sin cuota, marca [00027] y resultados negativos de ejercicios anteriores en [00197]', () => {
      expect(campo(pg['01000'], 13, 1)).toBe('D');
      expect(campo(pg['01000'], 219, 1)).toBe('1');
      expect(campo(pg['05000'], 13, 17)).toBe(n17(-17500)); // [00185]
      expect(campo(pg['05000'], 353, 17)).toBe(n17(-2000)); // [00197]
      expect(campo(pg['05000'], 387, 17)).toBe(n17(-18500)); // [00199]
      expect(campo(pg['14000'], 13, 17)).toBe(n17(-18500)); // [00550]
      expect(campo(pg['14000'], 115, 17)).toBe(n17(0)); // [00547]
      expect(campo(pg['14000'], 166, 17)).toBe(n17(-18500)); // [00552]
      expect(campo(pg['14000'], 646, 17)).toBe(n17(0)); // [00562]
      expect(campo(pg['14B00'], 575, 17)).toBe(n17(-50)); // [00599]
      expect(campo(pg['14B00'], 1153, 17)).toBe(n17(-50)); // [00621]
      expect(decl.liquidacion.binsGeneradas).toBe(18500);
    });

    it('DID: devolución de las retenciones a la cuenta de la empresa', () => {
      const l = pg['DID00'];
      expect(campo(l, 173, 17)).toBe(n17(-50));
      expect(campo(l, 207, 1)).toBe('D');
      expect(campo(l, 208, 17)).toBe(n17(50));
      expect(campo(l, 242, 1)).toBe('1');
      expect(campo(l, 243, 34)).toBe('ES9121000418450200051332'.padEnd(34));
      expect(campo(l, 425, 1)).toBe(' ');
    });

    it('sin retenciones el resultado es cero: declaración N y marca de resultado cero', () => {
      const cero = construirModelo200({ ...PERDIDAS, retenciones: 0 });
      const p2 = trocear(cero.fichero).paginas;
      expect(campo(p2['01000'], 13, 1)).toBe('N');
      expect(campo(p2['DID00'], 562, 1)).toBe('1');
      expect(campo(p2['DID00'], 207, 1)).toBe(' ');
    });
  });

  it('tipos de gravamen por ejercicio (Ley 7/2024): micro, reducida dimensión, nueva creación y general', () => {
    expect(tipoGravamen200(2025, 500000).codigo).toBe('2122');
    expect(tipoGravamen200(2026, 500000).codigo).toBe('1921');
    expect(tipoGravamen200(2027, 500000).codigo).toBe('1720');
    expect(tipoGravamen200(2025, 5_000_000).codigo).toBe('2400');
    expect(tipoGravamen200(2027, 5_000_000).codigo).toBe('2200');
    expect(tipoGravamen200(2025, 5_000_000, true).codigo).toBe('1500');
    expect(tipoGravamen200(2025, 50_000_000).codigo).toBe('2500');
    expect(tipoGravamen200(2025, null).codigo).toBe('2500');
  });

  it('bloquea el fichero si el balance no cuadra o falta el NIF', () => {
    const malo = construirModelo200({ ...BENEFICIO, identificacion: { ...ID, nif: '' }, balance: { ...BENEFICIO.balance, descuadre: 10 } });
    expect(malo.errores.join(' ')).toMatch(/NIF/);
    expect(malo.errores.join(' ')).toMatch(/no cuadra/);
  });
});

describe('200 rectificativa: lo ya ingresado va a [01578] y no se pide otra vez', () => {
  const rect = (resultadoAnterior: number, devolucionAcordada = 0) =>
    construirModelo200({ ...BENEFICIO, rectificativa: { justificanteAnterior: '2002025000001', resultadoAnterior, devolucionAcordada } });

  it('con la anterior a ingresar 1540 €: [01578] = 1540 y [00621] = [01586] - [01578]', () => {
    const d = rect(1540);
    expect(d.errores).toEqual([]);
    const pg = trocear(d.fichero).paginas;
    for (const [codigo, linea] of Object.entries(pg)) expect([codigo, validarRegistro(PAGINAS[codigo], linea)]).toEqual([codigo, []]);
    expect(campo(pg['14B00'], 1051, 17)).toBe(n17(5070)); // [01586]
    expect(campo(pg['14B00'], 1085, 17)).toBe(n17(1540)); // [01578]
    expect(campo(pg['14B00'], 1153, 17)).toBe(n17(3530)); // [00621]
    expect(campo(pg['14B00'], 1187, 17)).toBe(n17(0)); // [00866]
    expect(campo(pg['01000'], 13, 1)).toBe('I');
    expect(campo(pg['01000'], 149, 15)).toBe('1' + '2002025000001' + '1');
    expect(campo(pg['DID00'], 425, 18)).toBe('I' + n17(3530)); // se ingresa solo la diferencia
    expect(d.liquidacion).toMatchObject({ resultado: 3530, resultadoAnterior: 1540, rectificacion: 0, tipoDeclaracion: 'I' });
    expect(d.advertencias.join(' ')).toMatch(/solo se ingresa la diferencia, 3\.530,00 €.*Sociedades WEB/);
  });

  it('si ahora sale menos de lo ingresado, la diferencia va a [00866] y se devuelve a la cuenta', () => {
    const d = rect(6000);
    const pg = trocear(d.fichero).paginas;
    for (const [codigo, linea] of Object.entries(pg)) expect([codigo, validarRegistro(PAGINAS[codigo], linea)]).toEqual([codigo, []]);
    expect(campo(pg['14B00'], 1153, 17)).toBe(n17(-930)); // [00621] = 5070 - 6000
    expect(campo(pg['14B00'], 1187, 17)).toBe(n17(930)); // [00866]
    expect(campo(pg['01000'], 13, 1)).toBe('N'); // sin la parte de la rectificación queda a cero
    expect(campo(pg['DID00'], 225, 17)).toBe(n17(930));
    expect(campo(pg['DID00'], 242, 25)).toBe('1' + 'ES9121000418450200051332');
    expect(campo(pg['DID00'], 425, 1)).toBe(' ');
    expect(campo(pg['DID00'], 207, 1)).toBe(' ');
  });

  it('la devolución ya acordada de la anterior suma ([01584])', () => {
    const pg = trocear(rect(0, 200).fichero).paginas;
    expect(campo(pg['14B00'], 1119, 17)).toBe(n17(200)); // [01584]
    expect(campo(pg['14B00'], 1153, 17)).toBe(n17(5270)); // [00621]
  });
});
