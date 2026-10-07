/**
 * Nominas conectadas con impuestos, tesoreria y archivo, sin base de datos:
 * casillas 01-06 del 111 (perceptores distintos, especie, dietas fuera),
 * registros del 190 por perceptor y su fichero (posiciones del diseno de
 * registro de 2025), casillas 04-09 del TXT del 111 y permisos de las rutas
 * nuevas. Los NIF son inventados (numeros con su letra de control).
 */
jest.mock('../config/database', () => ({ prisma: {} }));

import express from 'express';
import request from 'supertest';
import { letraNif } from '../utils/nif';
import { agregarTrabajo111, codigoProvincia, perceptoresDeNominas, perceptoresProfesionales, periodoFiscal, type NominaFiscal, type Perceptor190 } from '../services/nominas/fiscal';
import { comprobarDiseno190, erroresFichero190, generarFicheroModelo190, LONGITUD_REGISTRO_190, registroPerceptor190, textoAeat } from '../services/nominas/modelo190';
import { generarFicheroModelo111 } from '../services/impuestosExport.service';
import { vencimiento111 } from '../services/nominas/informes';
import { fechaCargoPorDefecto } from '../services/nominas/segurosSociales';
import { cuentasNominasPorDefecto } from '../services/nominas/calculo';
import nominasRoutes from '../routes/nominas.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;

const nomina = (p: Partial<NominaFiscal> & { empleadoId: string; nif: string }): NominaFiscal => ({
  ejercicio: 2026,
  mes: 1,
  ejercicioDevengo: null,
  fechaPago: '2026-01-31',
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

describe('111: rendimientos del trabajo (casillas 01-06)', () => {
  const A = nif(30000001);
  const B = nif(30000002);
  const C = nif(30000003);

  it('2 meses y 3 trabajadores: casilla 01 = 3 perceptores distintos, no 6 nominas ni 2 meses', () => {
    const nominas = [1, 2].flatMap((mes) => [
      nomina({ empleadoId: 'a', nif: A, mes, brutoDinerario: 2000, irpf: 300 }),
      nomina({ empleadoId: 'b', nif: B, mes, brutoDinerario: 1800, irpf: 180 }),
      nomina({ empleadoId: 'c', nif: C, mes, brutoDinerario: 1500, irpf: 120 }),
    ]);
    const { casillas, avisos } = agregarTrabajo111(nominas);
    expect(casillas).toEqual({
      perceptoresDinerarios: 3,
      percepcionesDinerarias: 10600,
      retencionesDinerarias: 1200,
      perceptoresEspecie: 0,
      percepcionesEspecie: 0,
      ingresosACuenta: 0,
    });
    expect(avisos).toEqual([]);
  });

  it('las dietas y la indemnizacion exentas no entran en la 02; la sujeta si', () => {
    const { casillas } = agregarTrabajo111([nomina({ empleadoId: 'a', nif: A, brutoDinerario: 1000, dietasExentas: 200, indemnizacionExenta: 5000, indemnizacionSujeta: 300, irpf: 150 })]);
    expect(casillas.percepcionesDinerarias).toBe(1300);
    expect(casillas.retencionesDinerarias).toBe(150);
  });

  it('especie: 04 perceptores, 05 solo la valoracion (como el 190), 06 ingresos a cuenta', () => {
    const { casillas } = agregarTrabajo111([
      nomina({ empleadoId: 'a', nif: A, brutoDinerario: 1000, especieValoracion: 200, ingresoACuenta: 30, ingresoACuentaRepercutido: false }),
      nomina({ empleadoId: 'b', nif: B, brutoDinerario: 1000, especieValoracion: 100, ingresoACuenta: 15, ingresoACuentaRepercutido: true }),
      nomina({ empleadoId: 'c', nif: C, brutoDinerario: 1000 }),
    ]);
    expect(casillas.perceptoresEspecie).toBe(2);
    // Antes 330 (con el ingreso a cuenta no repercutido): no cuadraba con la valoracion del 190.
    expect(casillas.percepcionesEspecie).toBe(300);
    expect(casillas.ingresosACuenta).toBe(45);
  });

  it('meses solo con el resumen antiguo: suman, con aviso de que la 01 no es fiable', () => {
    const { casillas, avisos } = agregarTrabajo111([], [{ mes: 3, totalBruto: 5000, totalIRPF: 600 }]);
    expect(casillas).toMatchObject({ perceptoresDinerarios: 1, percepcionesDinerarias: 5000, retencionesDinerarias: 600 });
    expect(avisos[0]).toMatch(/casilla 01 no es fiable/);
  });

  it('periodos: trimestres, meses y ano', () => {
    expect(periodoFiscal(2026, '4T')).toMatchObject({ periodo: '4T', fechaInicio: '2026-10-01', fechaFin: '2026-12-31', tipo: 'trimestral' });
    expect(periodoFiscal(2028, '2')).toMatchObject({ periodo: '02', fechaInicio: '2028-02-01', fechaFin: '2028-02-29', tipo: 'mensual' });
    expect(periodoFiscal(2026, '0A')).toMatchObject({ fechaInicio: '2026-01-01', fechaFin: '2026-12-31' });
    expect(() => periodoFiscal(2026, '5T')).toThrow(/no válido/);
  });

  it('vencimientos: 111 el dia 20 del mes siguiente al trimestre; RLC el ultimo dia del mes siguiente', () => {
    expect(vencimiento111(2026, 1)).toBe('2026-04-20');
    expect(vencimiento111(2026, 4)).toBe('2027-01-20');
    expect(fechaCargoPorDefecto(2026, 1)).toBe('2026-02-28');
    expect(fechaCargoPorDefecto(2026, 12)).toBe('2027-01-31');
  });
});

describe('TXT del 111: casillas 04 a 09 en su posicion', () => {
  it('especie en 151/159/176 y actividades economicas en 193/201/218; la 28 cuadra con el detalle', () => {
    const periodo = periodoFiscal(2026, '1T');
    const f = generarFicheroModelo111('B12345678', periodo, {
      periodo,
      nPerceptoresTrabajo: 3,
      percepcionesTrabajo: 10600,
      retencionesTrabajo: 1200,
      nPerceptoresEspecie: 2,
      percepcionesEspecie: 330,
      ingresosACuentaEspecie: 45,
      nPerceptoresActividades: 1,
      percepcionesActividades: 1000,
      retencionesActividades: 150,
      totalRetenciones: 1395,
      resultadoIngresar: 1395,
    });
    const pagina = f.slice(328, 328 + 1000);
    const campo = (pos: number, len: number) => pagina.slice(pos - 1, pos - 1 + len);
    expect(campo(109, 8)).toBe('00000003');
    expect(campo(151, 8)).toBe('00000002');
    expect(campo(159, 17)).toBe('00000000000033000');
    expect(campo(176, 17)).toBe('00000000000004500');
    expect(campo(193, 8)).toBe('00000001');
    expect(campo(201, 17)).toBe('00000000000100000');
    expect(campo(218, 17)).toBe('00000000000015000');
    expect(campo(487, 17)).toBe('00000000000139500');
  });
});

describe('190: un registro por perceptor y clave', () => {
  const empleados = new Map([
    ['a', { id: 'a', nif: nif(30000001), nombre: 'Ana', apellidos: 'Prueba Uno', provincia: '46', anioNacimiento: 1985, situacionFamiliar: 2, nifConyuge: nif(30000009), discapacidad: 0, movilidadGeografica: false, tipoContrato: 'INDEFINIDO', clave190: 'A', subclave190: null }],
    ['b', { id: 'b', nif: nif(30000002), nombre: 'Blas', apellidos: 'Prueba Dos', provincia: null, anioNacimiento: null, situacionFamiliar: null, nifConyuge: null, discapacidad: null, movilidadGeografica: true, tipoContrato: 'TEMPORAL', clave190: 'A', subclave190: null }],
  ]);

  it('suma las nominas del trabajador; gastos deducibles = SS del trabajador; dietas a L.01 e indemnizacion exenta a L.05', () => {
    const p = perceptoresDeNominas(
      2025,
      [
        nomina({ empleadoId: 'a', nif: nif(30000001), ejercicio: 2025, mes: 1, brutoDinerario: 2000, irpf: 300, ssTrabajador: 127, dietasExentas: 50 }),
        nomina({ empleadoId: 'a', nif: nif(30000001), ejercicio: 2025, mes: 2, brutoDinerario: 2000, irpf: 300, ssTrabajador: 127, especieValoracion: 100, ingresoACuenta: 20 }),
        nomina({ empleadoId: 'b', nif: nif(30000002), ejercicio: 2025, mes: 2, brutoDinerario: 900, indemnizacionSujeta: 100, indemnizacionExenta: 3000, irpf: 50, ssTrabajador: 63.5 }),
      ],
      empleados as never,
    );
    const a = p.find((x) => x.nif === nif(30000001) && x.clave === 'A')!;
    expect(a).toMatchObject({
      subclave: null,
      nombre: 'Prueba Uno Ana',
      percepcionIntegra: 4000,
      retenciones: 600,
      valoracionEspecie: 100,
      ingresosACuentaEfectuados: 20,
      ingresosACuentaRepercutidos: 0,
      gastosDeducibles: 254,
      situacionFamiliar: 2,
      contrato: 1,
      documentos: 2,
      faltan: [],
    });
    expect(p.find((x) => x.nif === nif(30000001) && x.clave === 'L')).toMatchObject({ subclave: '01', percepcionIntegra: 50, retenciones: 0 });
    const b = p.find((x) => x.nif === nif(30000002) && x.clave === 'A')!;
    expect(b).toMatchObject({ percepcionIntegra: 1000, contrato: 2, movilidadGeografica: true, situacionFamiliar: 3 });
    expect(b.faltan).toEqual(['provincia', 'año de nacimiento']);
    expect(p.find((x) => x.nif === nif(30000002) && x.clave === 'L')).toMatchObject({ subclave: '05', percepcionIntegra: 3000 });
  });

  it('atrasos de otro ejercicio: registro aparte con el ejercicio de devengo', () => {
    const p = perceptoresDeNominas(
      2026,
      [
        nomina({ empleadoId: 'a', nif: nif(30000001), ejercicio: 2026, brutoDinerario: 2000, irpf: 300 }),
        nomina({ empleadoId: 'a', nif: nif(30000001), ejercicio: 2025, mes: 12, fechaPago: '2026-01-05', brutoDinerario: 1500, irpf: 200 }),
      ],
      empleados as never,
    );
    expect(p.filter((x) => x.clave === 'A').map((x) => [x.ejercicioDevengo, x.percepcionIntegra])).toEqual([
      [null, 2000],
      [2025, 1500],
    ]);
  });

  it('profesionales: clave G (01 general, 03 al 7 %), provincia por el codigo postal', () => {
    const p = perceptoresProfesionales([
      { supplierId: 's1', baseTotal: 1000, retencionTotal: 150, tipoRetencion: 15, supplier: { nifCif: 'b-12345674', nombreFiscal: 'Asesor SL', cp: '46001', provincia: null } },
      { supplierId: 's1', baseTotal: 500, retencionTotal: 75, tipoRetencion: 15, supplier: { nifCif: 'b-12345674', nombreFiscal: 'Asesor SL', cp: '46001', provincia: null } },
      { supplierId: 's2', baseTotal: 200, retencionTotal: 14, tipoRetencion: 7, supplier: { nifCif: nif(30000004), nombreFiscal: 'Diseñadora', cp: null, provincia: 'Alicante' } },
    ]);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ clave: 'G', subclave: '01', nif: 'B12345674', provincia: '46', percepcionIntegra: 1500, retenciones: 225, documentos: 2 });
    expect(p[1]).toMatchObject({ clave: 'G', subclave: '03', provincia: '03', percepcionIntegra: 200, retenciones: 14 });
    expect(codigoProvincia(null, 'Illes Balears')).toBe('07');
    expect(codigoProvincia('28080', null)).toBe('28');
    expect(codigoProvincia(null, 'Castellón/Castelló')).toBe('12');
    expect(codigoProvincia(null, 'Narnia')).toBeNull();
  });
});

describe('fichero del 190 (diseno de registro del ejercicio 2025)', () => {
  const perceptorA: Perceptor190 = {
    clave: 'A',
    subclave: null,
    nif: nif(30000001),
    nombre: 'Prueba Uno Ana',
    provincia: '46',
    percepcionIntegra: 24000,
    retenciones: 3600.5,
    valoracionEspecie: 1200,
    ingresosACuentaEfectuados: 240,
    ingresosACuentaRepercutidos: 0,
    ejercicioDevengo: null,
    gastosDeducibles: 1524,
    anioNacimiento: 1985,
    situacionFamiliar: 2,
    nifConyuge: nif(30000009),
    discapacidad: 1,
    contrato: 1,
    movilidadGeografica: true,
    origen: 'nomina',
    documentos: 12,
    faltan: [],
  };
  const perceptorL: Perceptor190 = { ...perceptorA, clave: 'L', subclave: '01', percepcionIntegra: 600, retenciones: 0, valoracionEspecie: 0, ingresosACuentaEfectuados: 0, gastosDeducibles: 0, anioNacimiento: null, situacionFamiliar: null, nifConyuge: null, discapacidad: null, contrato: null, movilidadGeografica: false };
  const perceptorG: Perceptor190 = { ...perceptorL, clave: 'G', subclave: '01', nif: 'B12345674', nombre: 'Asesoría Muñoz, S.L.', provincia: '03', percepcionIntegra: 1500, retenciones: 225, origen: 'profesional' };
  const declarante = { nif: 'B98765432', nombre: 'Empresa de Prueba, S.L.', telefono: '600000000', contacto: 'Persona Contacto', email: 'contacto@example.com' };

  it('ejercicio sin diseno verificado: 409 con un mensaje claro', () => {
    expect(() => comprobarDiseno190(2026)).toThrow(expect.objectContaining({ statusCode: 409, message: expect.stringMatching(/2026 no está verificado/) }));
    expect(() => generarFicheroModelo190(2026, declarante, [perceptorA])).toThrow(/informe por perceptor/);
    expect(() => comprobarDiseno190(2025)).not.toThrow();
  });

  it('registros de 500 posiciones: declarante con los totales y un registro por perceptor', () => {
    const f = generarFicheroModelo190(2025, declarante, [perceptorA, perceptorL, perceptorG]);
    expect(f.endsWith('\r\n')).toBe(true);
    const regs = f.replace(/\r\n$/, '').split('\r\n');
    expect(regs).toHaveLength(4);
    for (const r of regs) expect(r).toHaveLength(LONGITUD_REGISTRO_190);
    const c = (r: string, desde: number, hasta: number) => r.slice(desde - 1, hasta);

    const t1 = regs[0];
    expect(c(t1, 1, 1)).toBe('1');
    expect(c(t1, 2, 4)).toBe('190');
    expect(c(t1, 5, 8)).toBe('2025');
    expect(c(t1, 9, 17)).toBe('B98765432');
    expect(c(t1, 18, 57)).toBe('EMPRESA DE PRUEBA S L'.padEnd(40, ' '));
    expect(c(t1, 58, 58)).toBe('T');
    expect(c(t1, 59, 67)).toBe('600000000');
    expect(c(t1, 68, 107)).toBe('PERSONA CONTACTO'.padEnd(40, ' '));
    expect(c(t1, 108, 120)).toBe('1902025000001');
    expect(c(t1, 121, 135)).toBe('  0000000000000');
    expect(c(t1, 136, 144)).toBe('000000003');
    // Percepciones: 24000 + 1200 especie + 600 + 1500 = 27300,00. Retenciones: 3600,50 + 240 + 225 = 4065,50.
    expect(c(t1, 145, 160)).toBe(' 000000002730000');
    expect(c(t1, 161, 175)).toBe('000000000406550');
    expect(c(t1, 176, 225)).toBe('contacto@example.com'.padEnd(50, ' '));
    expect(c(t1, 226, 500)).toBe(' '.repeat(275));

    const a = regs[1];
    expect(c(a, 1, 8)).toBe('21902025');
    expect(c(a, 9, 17)).toBe('B98765432');
    expect(c(a, 18, 26)).toBe(nif(30000001));
    expect(c(a, 27, 35)).toBe(' '.repeat(9));
    expect(c(a, 36, 75)).toBe('PRUEBA UNO ANA'.padEnd(40, ' '));
    expect(c(a, 76, 77)).toBe('46');
    expect(c(a, 78, 78)).toBe('A');
    expect(c(a, 79, 80)).toBe('  ');
    expect(c(a, 81, 81)).toBe(' ');
    expect(c(a, 82, 94)).toBe('0000002400000');
    expect(c(a, 95, 107)).toBe('0000000360050');
    expect(c(a, 108, 108)).toBe(' ');
    expect(c(a, 109, 121)).toBe('0000000120000');
    expect(c(a, 122, 134)).toBe('0000000024000');
    expect(c(a, 135, 147)).toBe('0000000000000');
    expect(c(a, 148, 152)).toBe('00000');
    expect(c(a, 153, 156)).toBe('1985');
    expect(c(a, 157, 157)).toBe('2');
    expect(c(a, 158, 166)).toBe(nif(30000009));
    expect(c(a, 167, 170)).toBe('1101'); // discapacidad 1, contrato 1, unidad convivencia 0, movilidad 1
    expect(c(a, 171, 183)).toBe('0'.repeat(13));
    expect(c(a, 184, 196)).toBe('0000000152400');
    expect(c(a, 197, 254)).toBe('0'.repeat(58));
    expect(c(a, 255, 255)).toBe(' ');
    expect(c(a, 395, 500)).toBe(' '.repeat(106));

    const l = regs[2];
    expect(c(l, 78, 80)).toBe('L01');
    expect(c(l, 82, 94)).toBe('0000000060000');
    // Sin datos personales en la L.01.
    expect(c(l, 153, 170)).toBe('0000' + '0' + ' '.repeat(9) + '0000');

    const g = regs[3];
    expect(c(g, 18, 26)).toBe('B12345674');
    expect(c(g, 36, 75)).toBe('ASESORIA MUÑOZ S L'.padEnd(40, ' '));
    expect(c(g, 76, 80)).toBe('03G01');
  });

  it('faltan datos: 400 con la lista (provincia, ano de nacimiento, NIF de la empresa)', () => {
    const sinDatos = { ...perceptorA, provincia: null, anioNacimiento: null };
    expect(erroresFichero190({ nif: '', nombre: 'X' }, [sinDatos])).toEqual([
      'Falta el NIF de la empresa (Registro Mercantil > Datos para la memoria).',
      'Prueba Uno Ana: falta el código de provincia.',
      'Prueba Uno Ana: falta el año de nacimiento.',
    ]);
    expect(() => generarFicheroModelo190(2025, declarante, [sinDatos])).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('texto AEAT: mayusculas, sin acentos ni signos; la Ñ se mantiene', () => {
    expect(textoAeat('Peña Ibáñez, José-María')).toBe('PEÑA IBAÑEZ JOSE MARIA');
    expect(registroPerceptor190(2025, 'B98765432', perceptorA)).toHaveLength(500);
  });
});

describe('cuentas de pago', () => {
  it('caja (570) y la 471 de la IT con la longitud del plan', () => {
    expect(cuentasNominasPorDefecto(6)).toMatchObject({ caja: '570000', ssDeudoraIt: '471000' });
    expect(cuentasNominasPorDefecto(10)).toMatchObject({ caja: '5700000000', ssDeudoraIt: '4710000000' });
  });
});

describe('permisos de las rutas nuevas de nominas', () => {
  function app(rol: string) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: 'u1', roles: [rol], companies: ['A'], rolesPorEmpresa: { A: [rol] } };
      req.companyId = 'A';
      next();
    });
    a.use('/nominas', nominasRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('solo-lectura, ventas y tesoreria: 403 en el 190, los PDF, la SS, el 111, el coste y la prevision', async () => {
    for (const rol of ['solo_lectura', 'ventas', 'tesoreria']) {
      for (const ruta of [
        '/nominas/190/2025/perceptores',
        '/nominas/190/2025/fichero',
        '/nominas/documentos?ejercicio=2026',
        '/nominas/documentos/d1/descargar',
        '/nominas/documentos/zip?ejercicio=2026',
        '/nominas/periodos/2026/1/documentos',
        '/nominas/seguros-sociales?ejercicio=2026',
        '/nominas/retenciones/2026/1T',
        '/nominas/informes/coste?ejercicio=2026',
        '/nominas/prevision',
        '/nominas/conciliacion/sugerencias?movimientoId=m1',
      ]) {
        expect(`${rol} ${ruta} ${(await request(app(rol)).get(ruta)).status}`).toBe(`${rol} ${ruta} 403`);
      }
      expect((await request(app(rol)).post('/nominas/periodos/2026/1/pago').send({})).status).toBe(403);
      expect((await request(app(rol)).post('/nominas/seguros-sociales/2026/1/pago').send({})).status).toBe(403);
    }
  });

  it('el contable recibe 400 (no 500) con datos mal formados, antes de tocar la base de datos', async () => {
    const a = app('contable');
    expect((await request(a).post('/nominas/periodos/2026/1/pago').send({ fecha: '2026-02-30' })).status).toBe(400);
    expect((await request(a).post('/nominas/periodos/2026/1/pago').send({ cuenta: '572' })).status).toBe(400);
    expect((await request(a).put('/nominas/seguros-sociales/2026/1').send({ totalRlc: -5 })).status).toBe(400);
    expect((await request(a).post('/nominas/retenciones/2026/1T/pago').send({ cuentaProfesionales: '400000' })).status).toBe(400);
    expect((await request(a).get('/nominas/retenciones/2026/7T')).status).toBe(400);
    expect((await request(a).get('/nominas/informes/coste?ejercicio=2026&agrupar=semana')).status).toBe(400);
    expect((await request(a).get('/nominas/190/2026/fichero')).status).toBe(409);
    const pdf = await request(a).post('/nominas/periodos/2026/1/documentos').attach('archivo', Buffer.from('hola'), { filename: 'nomina.txt', contentType: 'text/plain' });
    expect(pdf.status).toBe(400);
    expect(pdf.body.message).toMatch(/PDF/);
  });
});
