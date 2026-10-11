/**
 * Test dorado del modelo 111: el fichero que se importa en la sede, campo a
 * campo, contra la tabla del diseño oficial (dr111e16v18.xls, transcrito en
 * src/domain/aeat/dr111-v2.json). Casos reales: nominas de tres trabajadores
 * (uno con retribucion en especie) y facturas de dos profesionales.
 */
import { describe, it, expect } from '@jest/globals';
import { agregarTrabajo111, type NominaFiscal } from '../services/nominas/fiscal';
import { generarFicheroModelo111 } from '../services/impuestosExport.service';
import {
  casillasAGuardadas,
  casillasDeDatos111,
  casillasDeGuardadas,
  construirDeclaracion,
  ficheroDeclaracion,
  formularioDeclaracion,
  opcionesDeGuardadas,
} from '../services/aeatRetenciones/declaracion';
import { DR111, registroDr } from '../services/aeatRetenciones/diseno';
import type { DatosModelo111, PeriodoFiscal } from '../domain/impuestos.model';
import { letraNif } from '../utils/nif';
import { cents, comprobarRegistro, comprobarTablaDiseno } from './aeat-dorado';

const CAB = registroDr(DR111, 'cabecera');
const PAG = registroDr(DR111, 'M11101');
const CIE = registroDr(DR111, 'cierre');
const partes = (f: string) => ({ cab: f.slice(0, 328), pag: f.slice(328, 1328), cie: f.slice(1328) });

const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const EMPRESA = 'B12345674'; // CIF valido (control 4)
const periodo: PeriodoFiscal = { ejercicio: 2026, periodo: '2T', tipo: 'trimestral', fechaInicio: '2026-04-01', fechaFin: '2026-06-30' };
const nomina = (p: Partial<NominaFiscal> & { empleadoId: string; nif: string }): NominaFiscal => ({
  ejercicio: 2026,
  mes: 4,
  ejercicioDevengo: null,
  fechaPago: '2026-04-30',
  estado: 'CONTABILIZADA',
  brutoDinerario: 0,
  indemnizacionSujeta: 0,
  indemnizacionExenta: 0,
  dietasExentas: 0,
  especieValoracion: 0,
  ingresoACuenta: 0,
  ingresoACuentaRepercutido: false,
  irpf: 0,
  ssTrabajador: 0,
  ...p,
});

/** 2T de 2026: tres trabajadores (Ana con seguro medico en especie) y dos profesionales (15 % y 7 %). */
function datosReales(): DatosModelo111 {
  const nominas = [4, 5, 6].flatMap((mes) => [
    nomina({ empleadoId: 'ana', nif: nif(30000001), mes, fechaPago: `2026-0${mes}-28`, brutoDinerario: 2450.75, irpf: 367.61, especieValoracion: 85.5, ingresoACuenta: 12.83 }),
    nomina({ empleadoId: 'blas', nif: nif(30000002), mes, fechaPago: `2026-0${mes}-28`, brutoDinerario: 1800, irpf: 198 }),
    nomina({ empleadoId: 'carla', nif: nif(30000003), mes, fechaPago: `2026-0${mes}-28`, brutoDinerario: 1320.4, irpf: 52.82, dietasExentas: 120 }),
  ]);
  const t = agregarTrabajo111(nominas).casillas;
  // Profesionales: asesoria 3 x 500 al 15 % y una disenadora que empieza, 1.200 al 7 %.
  const actividades = { perceptores: 2, percepciones: 2700, retenciones: 309 };
  const c = (v: number) => Math.round(v * 100);
  const total = (c(t.retencionesDinerarias) + c(t.ingresosACuenta) + c(actividades.retenciones)) / 100;
  return {
    periodo,
    nPerceptoresTrabajo: t.perceptoresDinerarios,
    percepcionesTrabajo: t.percepcionesDinerarias,
    retencionesTrabajo: t.retencionesDinerarias,
    nPerceptoresEspecie: t.perceptoresEspecie,
    percepcionesEspecie: t.percepcionesEspecie,
    ingresosACuentaEspecie: t.ingresosACuenta,
    nPerceptoresActividades: actividades.perceptores,
    percepcionesActividades: actividades.percepciones,
    retencionesActividades: actividades.retenciones,
    totalRetenciones: total,
    resultadoIngresar: total,
  };
}

describe('111: tabla del diseño oficial (dr111e16v18.xls)', () => {
  it('cabecera 328 + pagina M11101 1000 + cierre 18, campos seguidos y sin huecos', () => {
    comprobarTablaDiseno(DR111);
    expect(DR111.registros.map((r) => [r.id, r.longitud])).toEqual([
      ['cabecera', 328],
      ['M11101', 1000],
      ['cierre', 18],
    ]);
    // 48 campos en la pagina, casillas [01] a [30] en su sitio.
    expect(PAG.campos).toHaveLength(48);
    const pos = Object.fromEntries(PAG.campos.filter((c) => c.casilla).map((c) => [c.casilla, [c.pos, c.lon, c.tipo]]));
    expect(pos['01']).toEqual([109, 8, 'Num']);
    expect(pos['09']).toEqual([218, 17, 'Num']);
    expect(pos['10']).toEqual([235, 8, 'Num']);
    expect(pos['25']).toEqual([445, 8, 'Num']);
    expect(pos['27']).toEqual([470, 17, 'Num']);
    expect(pos['28']).toEqual([487, 17, 'Num']);
    expect(pos['29']).toEqual([504, 17, 'N']);
    expect(pos['30']).toEqual([521, 17, 'Num']);
  });
});

describe('111: fichero con nominas y profesionales (caso real)', () => {
  const datos = datosReales();

  it('las casillas salen de las nominas: 3 perceptores, especie de Ana y profesionales', () => {
    expect(casillasDeDatos111(datos)).toMatchObject({
      '01': 3,
      '02': 16713.45, // (2450,75 + 1800 + 1320,40) x 3, sin las dietas exentas
      '03': 1855.29, // (367,61 + 198 + 52,82) x 3
      '04': 1,
      '05': 256.5,
      '06': 38.49,
      '07': 2,
      '08': 2700,
      '09': 309,
      '28': 2202.78,
      '30': 2202.78,
    });
  });

  it('cada campo en su posicion, con su tipo y su valor', () => {
    const f = generarFicheroModelo111(EMPRESA, periodo, datos, { denominacion: 'Newzeland Center, S.L.' });
    expect(f).toHaveLength(328 + 1000 + 18);
    expect(f.endsWith('\r\n')).toBe(false);
    const { cab, pag, cie } = partes(f);
    comprobarRegistro(cab, CAB, { ejercicio: '2026', periodo: '2T', versionPrograma: '0101', nifEmpresaDesarrollo: ' '.repeat(9) });
    comprobarRegistro(pag, PAG, {
      tipoDeclaracion: 'I',
      nif: EMPRESA,
      apellidosODenominacion: 'NEWZELAND CENTER S L'.padEnd(60, ' '),
      nombre: ' '.repeat(20),
      ejercicio: '2026',
      periodo: '2T',
      '01': '00000003',
      '02': cents(16713.45, 17),
      '03': cents(1855.29, 17),
      '04': '00000001',
      '05': cents(256.5, 17),
      '06': cents(38.49, 17),
      '07': '00000002',
      '08': cents(2700, 17),
      '09': cents(309, 17),
      '10': '00000000',
      '27': '0'.repeat(17),
      '28': cents(2202.78, 17),
      '29': '0'.repeat(17),
      '30': cents(2202.78, 17),
      complementaria: ' ',
      justificanteAnterior: ' '.repeat(13),
      iban: ' '.repeat(34),
    });
    comprobarRegistro(cie, CIE, { ejercicio: '2026', periodo: '2T' });
    expect(f.startsWith('<T11102026' + '2T0000><AUX>')).toBe(true);
    expect(cie).toBe('</T111020262T0000>');
  });

  it('la pantalla y el fichero salen de la misma declaracion (tambien con casillas guardadas)', () => {
    const guardadas = { ...casillasAGuardadas('111', casillasDeDatos111(datos)), config_nif: EMPRESA, config_razon_social: 'Newzeland Center, S.L.' };
    const decl = construirDeclaracion('111', {
      nif: guardadas.config_nif,
      denominacion: guardadas.config_razon_social,
      ejercicio: 2026,
      periodo: '2T',
      casillas: casillasDeGuardadas('111', guardadas),
      opciones: opcionesDeGuardadas(guardadas),
    });
    expect(ficheroDeclaracion(decl)).toBe(generarFicheroModelo111(EMPRESA, periodo, datos, { denominacion: 'Newzeland Center, S.L.' }));
    const form = formularioDeclaracion(decl);
    const enPantalla = Object.fromEntries(
      [...form.bloques.flatMap((b) => b.filas.flatMap((fila) => fila.casillas)), ...form.total].map((c) => [c.numero, c.valor]),
    );
    // Las 30 casillas del formulario oficial, con el mismo valor que el fichero.
    expect(Object.keys(enPantalla).sort()).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(enPantalla).toEqual(decl.casillas);
    expect(form.bloques.map((b) => b.titulo)[0]).toBe('Rendimientos del trabajo');
    expect(form.liquidacion.tipoDeclaracion).toBe('I');
  });
});

describe('111: tipo de declaracion, complementaria, domiciliacion y persona fisica', () => {
  const casillas = (extra: Record<string, number>) => ({ '07': 1, '08': 1000, '09': 150, '28': 150, '30': 150, ...extra });
  const base = { nif: EMPRESA, denominacion: 'Ifbiosoluciones SL', ejercicio: 2026, periodo: '3T' };

  it('resultado 0: declaracion negativa (N), no un ingreso de 0 euros', () => {
    const f = ficheroDeclaracion(construirDeclaracion('111', { ...base, casillas: {} }));
    comprobarRegistro(partes(f).pag, PAG, { tipoDeclaracion: 'N', '28': '0'.repeat(17), '30': '0'.repeat(17) });
  });

  it('domiciliacion: tipo U y el IBAN en la 553', () => {
    const d = construirDeclaracion('111', { ...base, casillas: casillas({}), opciones: { formaPago: 'U', iban: 'es91 2100 0418 4502 0005 1332' } });
    comprobarRegistro(partes(ficheroDeclaracion(d)).pag, PAG, { tipoDeclaracion: 'U', iban: 'ES9121000418450200051332'.padEnd(34, ' ') });
    // Sin IBAN valido no se genera.
    const sin = construirDeclaracion('111', { ...base, casillas: casillas({}), opciones: { formaPago: 'U', iban: 'ES0000000000000000000000' } });
    expect(() => ficheroDeclaracion(sin)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/IBAN válido/) }));
  });

  it('ingreso a anotar en la cuenta corriente tributaria: tipo G, sin IBAN', () => {
    const d = construirDeclaracion('111', { ...base, casillas: casillas({}), opciones: { formaPago: 'G', iban: 'ES9121000418450200051332' } });
    comprobarRegistro(partes(ficheroDeclaracion(d)).pag, PAG, { tipoDeclaracion: 'G', iban: ' '.repeat(34) });
  });

  it('complementaria: X en la 538, justificante en la 539, [29] lo ingresado antes y [30] = [28] - [29]', () => {
    const d = construirDeclaracion('111', {
      ...base,
      casillas: casillas({ '29': 100, '30': 50 }),
      opciones: { complementaria: true, justificanteAnterior: '1110123456789' },
    });
    comprobarRegistro(partes(ficheroDeclaracion(d)).pag, PAG, {
      tipoDeclaracion: 'I',
      '28': cents(150, 17),
      '29': cents(100, 17),
      '30': cents(50, 17),
      complementaria: 'X',
      justificanteAnterior: '1110123456789',
    });
    // [29] sin complementaria, o complementaria sin justificante: no se genera.
    expect(construirDeclaracion('111', { ...base, casillas: casillas({ '29': 100, '30': 50 }) }).errores).toEqual([
      'La casilla [29] solo se rellena en una declaración complementaria.',
    ]);
    expect(construirDeclaracion('111', { ...base, casillas: casillas({}), opciones: { complementaria: true } }).errores[0]).toMatch(/13 cifras/);
  });

  it('complementaria con resultado 0 o negativo: la sede no la admite, error en vez de fichero', () => {
    const opciones = { complementaria: true, justificanteAnterior: '1110123456789' };
    const cero = construirDeclaracion('111', { ...base, casillas: casillas({ '29': 150, '30': 0 }), opciones });
    expect(cero.errores).toEqual([
      'Una complementaria del 111 solo se presenta si sale una cantidad a ingresar, y aquí la casilla [30] sale 0,00 €. La sede no la admite: si en la declaración anterior ingresaste de más, pide en la sede la rectificación de esa autoliquidación; si no cambia nada, no hace falta presentar otra.',
    ]);
    expect(() => ficheroDeclaracion(cero)).toThrow(expect.objectContaining({ statusCode: 400 }));
    const negativa = construirDeclaracion('111', { ...base, casillas: casillas({ '29': 200, '30': -50 }), opciones });
    expect(negativa.errores).toContainEqual(expect.stringMatching(/^Una complementaria del 111 solo se presenta si sale una cantidad a ingresar, y aquí la casilla \[30\] sale -50,00 €/));
    // Sin complementaria, el resultado 0 sigue siendo una declaracion negativa (N).
    expect(construirDeclaracion('111', { ...base, casillas: casillas({ '28': 0, '03': 0, '09': 0, '30': 0 }) })).toMatchObject({ errores: [], tipoDeclaracion: 'N' });
  });

  it('persona fisica: apellidos en la 23 y nombre en la 83, con la Ñ (ISO-8859-1)', () => {
    const d = construirDeclaracion('111', { ...base, nif: nif(30000001), denominacion: 'Peña Ibáñez, José-María', casillas: casillas({}) });
    comprobarRegistro(partes(ficheroDeclaracion(d)).pag, PAG, {
      nif: nif(30000001),
      apellidosODenominacion: 'PEÑA IBAÑEZ'.padEnd(60, ' '),
      nombre: 'JOSE MARIA'.padEnd(20, ' '),
    });
  });

  it('errores que la sede rechazaria: 400 con un mensaje para la persona', () => {
    const err = (e: Partial<Parameters<typeof construirDeclaracion>[1]>) => construirDeclaracion('111', { ...base, casillas: casillas({}), ...e }).errores;
    expect(err({ nif: '' })[0]).toMatch(/^Falta el NIF de la empresa/);
    expect(err({ nif: 'B12345678' })[0]).toBe('El NIF de la empresa (B12345678) no es válido: el dígito de control no corresponde a sus cifras. Corrígelo en Registro Mercantil > Datos para la memoria.');
    expect(err({ denominacion: '' })[0]).toMatch(/^Falta la razón social/);
    expect(err({ periodo: '0A' })[0]).toMatch(/periodo "0A" no es válido/);
    expect(err({ casillas: casillas({ '28': 200, '30': 200 }) })[0]).toMatch(/^La casilla \[28\]/);
    expect(err({ casillas: casillas({ '30': 120 }) })[0]).toMatch(/^La casilla \[30\]/);
    expect(err({ casillas: casillas({ '09': -150, '28': -150, '30': -150 }) })[0]).toMatch(/^El 111 sale con importes negativos/);
    // NIF con guiones y prefijo ES: se normaliza.
    expect(construirDeclaracion('111', { ...base, nif: 'es b-12345674', casillas: casillas({}) }).identificacion.nif).toBe(EMPRESA);
  });

  it('un importe que no cabe en 17 cifras da error en vez de truncarse', () => {
    const enorme = 1e16;
    const d = construirDeclaracion('111', { ...base, casillas: casillas({ '08': enorme }) });
    expect(() => ficheroDeclaracion(d)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/no cabe en 17 cifras/) }));
  });
});
