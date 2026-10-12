/**
 * Test dorado del modelo 190: el fichero que se importa en la sede, registro a
 * registro y campo a campo, contra la tabla del diseño oficial de 2025
 * (DISENOS_LOGICOS_190_2025.pdf, transcrito en src/domain/aeat/dr190-2025.json).
 * Caso real del ejercicio 2026 (borrador con el diseño de 2025): dos
 * trabajadores (clave A; una con discapacidad y conyuge a cargo), atrasos de
 * 2025 pagados en 2026, un reintegro de lo cobrado de mas en 2025, dietas
 * exentas (L.01) y dos profesionales (G.01 al 15 % y G.03 al 7 %).
 */
import { describe, it, expect } from '@jest/globals';
import { perceptoresDeNominas, perceptoresProfesionales, codigoProvincia, revisarPerceptoresG, tipoPerceptorG, type NominaFiscal, type Perceptor190 } from '../services/nominas/fiscal';
import { avisosFichero190, comprobarDiseno190, erroresFichero190, generarFicheroModelo190, resumen190, totales190 } from '../services/nominas/modelo190';
import { DR190, registroDr } from '../services/aeatRetenciones/diseno';
import { letraNif } from '../utils/nif';
import { cents, comprobarRegistro, comprobarTablaDiseno } from './aeat-dorado';

const T1 = registroDr(DR190, 'tipo1');
const T2 = registroDr(DR190, 'tipo2');
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const EMPRESA = 'B12345674';
/** Comunidad de bienes (entidad en atribucion de rentas): perceptor valido de la clave G. */
const ASESORIA = 'E12345674';
const ANA = nif(30000001);
const BLAS = nif(30000002);
const CONYUGE = nif(30000009);

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

const empleados = new Map([
  ['ana', { id: 'ana', nif: ANA, nombre: 'Ana María', apellidos: 'Peña Ibáñez', provincia: '46', anioNacimiento: 1984, situacionFamiliar: 2, nifConyuge: CONYUGE, discapacidad: 1, movilidadGeografica: false, tipoContrato: 'INDEFINIDO', clave190: 'A', subclave190: null }],
  ['blas', { id: 'blas', nif: BLAS, nombre: 'Blas', apellidos: 'García Ruiz', provincia: '38', anioNacimiento: 1999, situacionFamiliar: 3, nifConyuge: null, discapacidad: 0, movilidadGeografica: true, tipoContrato: 'TEMPORAL', clave190: 'A', subclave190: null }],
]);

/** Ejercicio 2026: nominas de enero a diciembre, atrasos y un reintegro de 2025, y dos profesionales. */
function perceptoresReales(): Perceptor190[] {
  const meses = Array.from({ length: 12 }, (_, i) => i + 1);
  const nominas = [
    ...meses.map((mes) => nomina({ empleadoId: 'ana', nif: ANA, mes, fechaPago: `2026-${String(mes).padStart(2, '0')}-28`, brutoDinerario: 2450.75, irpf: 330.85, ssTrabajador: 159.3, especieValoracion: 85.5, ingresoACuenta: 12.83, dietasExentas: mes === 3 ? 180 : 0 })),
    ...meses.map((mes) => nomina({ empleadoId: 'blas', nif: BLAS, mes, fechaPago: `2026-${String(mes).padStart(2, '0')}-28`, brutoDinerario: 1500, irpf: 135, ssTrabajador: 97.5 })),
    // Atrasos del convenio de 2025 pagados en enero de 2026.
    nomina({ empleadoId: 'ana', nif: ANA, ejercicio: 2025, mes: 12, ejercicioDevengo: 2025, tipo: 'ATRASOS', fechaPago: '2026-01-15', brutoDinerario: 600, irpf: 81 }),
    // Blas devuelve 200 € cobrados de más en 2025 (reintegro: sin retencion).
    nomina({ empleadoId: 'blas', nif: BLAS, ejercicio: 2025, mes: 11, ejercicioDevengo: 2025, fechaPago: '2026-02-10', brutoDinerario: -200 }),
  ];
  const profesionales = perceptoresProfesionales([
    { supplierId: 'asesoria', baseTotal: 500, retencionTotal: 75, tipoRetencion: 15, supplier: { nifCif: 'e-12345674', nombreFiscal: 'Asesoría Muñoz, C.B.', cp: '46001', provincia: null } },
    { supplierId: 'asesoria', baseTotal: 500, retencionTotal: 75, tipoRetencion: 15, supplier: { nifCif: 'e-12345674', nombreFiscal: 'Asesoría Muñoz, C.B.', cp: '46001', provincia: null } },
    { supplierId: 'disenadora', baseTotal: 1200, retencionTotal: 84, tipoRetencion: 7, supplier: { nifCif: nif(30000004), nombreFiscal: 'Lucía Díaz Sanz', cp: '38760', provincia: null } },
  ]);
  return [...perceptoresDeNominas(2026, nominas, empleados as never), ...profesionales];
}

const declarante = { nif: EMPRESA, nombre: 'Newzeland Center, S.L.', telefono: '963 000 000', contacto: 'Fernández Gil, Ignacio', email: 'contabilidad@example.com', numeroDeclaracion: '1902026000001' };

describe('190: tabla del diseño oficial de 2025', () => {
  it('registros de 500 posiciones, campos seguidos y sin huecos', () => {
    comprobarTablaDiseno(DR190);
    expect(DR190.registros.map((r) => [r.id, r.longitud])).toEqual([
      ['tipo1', 500],
      ['tipo2', 500],
    ]);
    const pos = (r: typeof T2, clave: string) => r.campos.find((c) => c.clave === clave)?.pos;
    expect(pos(T1, 'importePercepciones')).toBe(146);
    expect(pos(T1, 'importeRetenciones')).toBe(161);
    expect(pos(T2, 'percepcionIntegra')).toBe(82);
    expect(pos(T2, 'gastosDeducibles')).toBe(184);
    expect(pos(T2, 'percepcionIT')).toBe(256);
    expect(pos(T2, 'prestacionResto')).toBe(394);
  });

  it('2026 y 2027 se generan con el diseño de 2025 como borrador; antes de 2025, 409', () => {
    expect(comprobarDiseno190(2025)).toEqual({ disenoEjercicio: 2025, borrador: false, aviso: null });
    expect(comprobarDiseno190(2027)).toMatchObject({ disenoEjercicio: 2025, borrador: true, aviso: expect.stringMatching(/diseño de registro de 2025.*ejercicio 2027/) });
    expect(() => comprobarDiseno190(2024)).toThrow(expect.objectContaining({ statusCode: 409 }));
  });
});

describe('190 de 2026: nominas, atrasos, reintegro y profesionales (caso real)', () => {
  const perceptores = perceptoresReales();
  const f = generarFicheroModelo190(2026, declarante, perceptores);
  const regs = f.replace(/\r\n$/, '').split('\r\n');
  const reg = (clave: string, nifP: string, extra: (r: string) => boolean = () => true) => regs.slice(1).find((r) => r[77] === clave && r.slice(17, 26) === nifP && extra(r))!;

  it('un registro por perceptor, clave, subclave, ejercicio de devengo y reintegro', () => {
    expect(f.endsWith('\r\n')).toBe(true);
    expect(perceptores.map((p) => `${p.clave}${p.subclave ?? ''} ${p.nif === ANA ? 'ANA' : p.nif === BLAS ? 'BLAS' : p.nif} ${p.ejercicioDevengo ?? ''}`).sort()).toEqual([
      'A ANA ',
      'A ANA 2025',
      'A BLAS ',
      'A BLAS 2025',
      `G01 ${ASESORIA} `,
      `G03 ${nif(30000004)} `,
      'L01 ANA ',
    ]);
    expect(regs).toHaveLength(8);
    for (const r of regs.slice(1)) comprobarRegistro(r, T2, { ejercicio: '2026', nifDeclarante: EMPRESA });
  });

  it('registro de declarante: totales iguales a la pantalla, con los reintegros restando', () => {
    // Percepciones: Ana 29409 + 1026 especie + 600 atrasos; Blas 18000 - 200; L01 180; G 1000 + 1200.
    // Retenciones: Ana 3970,20 + 153,96 + 81; Blas 1620; G 150 + 84.
    const t = totales190(perceptores);
    expect(t).toEqual({ registros: 7, percepciones: 51215, retenciones: 6059.16 });
    comprobarRegistro(regs[0], T1, {
      ejercicio: '2026',
      nifDeclarante: EMPRESA,
      nombreDeclarante: 'NEWZELAND CENTER SL'.padEnd(40, ' '),
      telefono: '963000000',
      contacto: 'FERNANDEZ GIL IGNACIO'.padEnd(40, ' '),
      numeroDeclaracion: '1902026000001',
      complementaria: ' ',
      sustitutiva: ' ',
      numeroDeclaracionAnterior: '0'.repeat(13),
      numeroPercepciones: '000000007',
      signoPercepciones: ' ',
      importePercepciones: cents(51215, 15),
      importeRetenciones: cents(6059.16, 15),
      email: 'contabilidad@example.com'.padEnd(50, ' '),
    });
    expect(resumen190(perceptores).map((r) => [r.casilla, r.valor])).toEqual([
      ['01', 7],
      ['02', 51215],
      ['03', 6059.16],
    ]);
  });

  it('trabajadora con discapacidad y conyuge a cargo (clave A)', () => {
    comprobarRegistro(reg('A', ANA, (r) => r.slice(147, 151) === '0000'), T2, {
      nifPerceptor: ANA,
      nifRepresentante: ' '.repeat(9),
      nombrePerceptor: 'PEÑA IBAÑEZ ANA MARIA'.padEnd(40, ' '),
      provincia: '46',
      clave: 'A',
      subclave: '00',
      signoPercepcion: ' ',
      percepcionIntegra: cents(29409, 13),
      retenciones: cents(3970.2, 13),
      signoEspecie: ' ',
      valoracionEspecie: cents(1026, 13),
      ingresosACuentaEfectuados: cents(153.96, 13),
      ingresosACuentaRepercutidos: '0'.repeat(13),
      ejercicioDevengo: '0000',
      anioNacimiento: '1984',
      situacionFamiliar: '2',
      nifConyuge: CONYUGE,
      discapacidad: '1',
      contrato: '1',
      movilidadGeografica: '0',
      gastosDeducibles: cents(1911.6, 13),
      percepcionIT: '0'.repeat(13),
    });
  });

  it('atrasos de 2025: registro aparte con el ejercicio de devengo', () => {
    comprobarRegistro(reg('A', ANA, (r) => r.slice(147, 151) === '2025'), T2, { percepcionIntegra: cents(600, 13), retenciones: cents(81, 13), ejercicioDevengo: '2025', signoPercepcion: ' ' });
  });

  it('reintegro de 2025: signo N, importe sin signo, retenciones a 0 y ejercicio de devengo', () => {
    comprobarRegistro(reg('A', BLAS, (r) => r.slice(147, 151) === '2025'), T2, {
      signoPercepcion: 'N',
      percepcionIntegra: cents(200, 13),
      retenciones: '0'.repeat(13),
      ejercicioDevengo: '2025',
      contrato: '2',
      movilidadGeografica: '1',
      provincia: '38',
    });
  });

  it('dietas exentas (L.01): sin datos personales ni gastos', () => {
    comprobarRegistro(reg('L', ANA), T2, { clave: 'L', subclave: '01', percepcionIntegra: cents(180, 13), anioNacimiento: '0000', situacionFamiliar: '0', discapacidad: '0', contrato: '0', gastosDeducibles: '0'.repeat(13) });
  });

  it('profesionales: G.01 al 15 % y G.03 al 7 % (La Palma = 53)', () => {
    comprobarRegistro(reg('G', ASESORIA), T2, { nombrePerceptor: 'ASESORIA MUÑOZ CB'.padEnd(40, ' '), provincia: '46', clave: 'G', subclave: '01', percepcionIntegra: cents(1000, 13), retenciones: cents(150, 13), anioNacimiento: '0000', contrato: '0' });
    comprobarRegistro(reg('G', nif(30000004)), T2, { nombrePerceptor: 'LUCIA DIAZ SANZ'.padEnd(40, ' '), provincia: '53', subclave: '03', percepcionIntegra: cents(1200, 13), retenciones: cents(84, 13) });
    expect(codigoProvincia('38700', null)).toBe('53');
    expect(codigoProvincia('38001', null)).toBe('38');
  });

  it('avisos: diseño de 2025 en borrador y el numero identificativo que pone el fichero (no se cambia en la sede)', () => {
    const avisos = avisosFichero190(2026, declarante);
    expect(avisos).toEqual([expect.stringMatching(/^Borrador con el diseño de registro de 2025/), expect.stringMatching(/^Número identificativo de esta declaración: 1902026000001\. Lo genera la app/)]);
    expect(avisos.join(' ')).not.toMatch(/sustitúyelo|provisional/);
  });

  it('sin numero identificativo no se compone el fichero (nunca uno fijo)', () => {
    expect(() => generarFicheroModelo190(2026, { ...declarante, numeroDeclaracion: null }, perceptores)).toThrow(/número identificativo/);
  });
});

describe('190: complementaria, sustitutiva y datos que faltan', () => {
  const perceptores = perceptoresReales();

  it('sustitutiva: S en la 122 y el numero de la declaracion anterior', () => {
    const f = generarFicheroModelo190(2026, { ...declarante, numeroDeclaracion: '1902026123457', tipoDeclaracion: 'S', numeroAnterior: '1902026123456' }, perceptores);
    comprobarRegistro(f.split('\r\n')[0], T1, { numeroDeclaracion: '1902026123457', complementaria: ' ', sustitutiva: 'S', numeroDeclaracionAnterior: '1902026123456' });
  });

  it('complementaria: C en la 121; sin numero anterior no se genera', () => {
    const f = generarFicheroModelo190(2026, { ...declarante, tipoDeclaracion: 'C', numeroAnterior: '1902026123456' }, perceptores);
    comprobarRegistro(f.split('\r\n')[0], T1, { complementaria: 'C', sustitutiva: ' ', numeroDeclaracionAnterior: '1902026123456' });
    expect(() => generarFicheroModelo190(2026, { ...declarante, tipoDeclaracion: 'C' }, perceptores)).toThrow(/número de la declaración anterior/);
  });

  it('la declaracion anterior no puede tener el mismo numero que la nueva', () => {
    expect(erroresFichero190({ ...declarante, tipoDeclaracion: 'S', numeroAnterior: declarante.numeroDeclaracion }, perceptores)).toEqual([
      'El número de la declaración anterior (1902026000001) no puede ser el mismo que el de esta declaración sustitutiva.',
    ]);
  });

  it('persona de contacto, subclave y reintegro sin ejercicio: errores claros', () => {
    const [g] = perceptores.filter((p) => p.clave === 'G');
    const reintegro = { ...perceptores.find((p) => p.percepcionIntegra < 0)!, ejercicioDevengo: null };
    expect(erroresFichero190({ ...declarante, telefono: '', contacto: '' }, [{ ...g, subclave: '09' }, reintegro])).toEqual([
      'Falta la persona de contacto con Hacienda (apellidos y nombre). Rellénala en Registro Mercantil > Datos.',
      'Falta el teléfono de contacto con Hacienda (9 cifras). Rellénalo en Registro Mercantil > Datos.',
      'Asesoría Muñoz, C.B.: la clave G necesita una subclave válida (01, 02, 03, 04, 05, 06, 07, 08).',
      'García Ruiz Blas: un reintegro (percepción negativa) necesita el ejercicio en que se cobró de más.',
    ]);
  });
});

describe('190: perceptores de la clave G (solo contribuyentes del IRPF y entidades en atribucion de rentas)', () => {
  const factura = (supplierId: string, nifCif: string, nombreFiscal: string, tipoRetencion = 15) => ({
    supplierId,
    baseTotal: 1000,
    retencionTotal: (1000 * tipoRetencion) / 100,
    tipoRetencion,
    supplier: { nifCif, nombreFiscal, cp: '46001', provincia: null },
  });
  const facturas = [
    factura('dni', nif(30000004), 'Lucía Díaz Sanz'),
    factura('nie', 'X1234567L', 'John Smith'),
    factura('cb', 'E12345674', 'Asesoría Muñoz, C.B.'),
    factura('sc', 'J1234567D', 'Arquitectos Sociedad Civil'),
    factura('sl', 'B46000006', 'Consultora Levante, S.L.'),
    factura('sa', 'A10952364', 'Grandes Despachos, S.A.'),
  ];

  it('tipo de perceptor por la letra del NIF', () => {
    expect(['12345678Z', 'X1234567L', 'Y1234567X', 'K1234567L', 'E12345674', 'J1234567D', 'B46000006', 'A10952364', 'G12345678', ''].map(tipoPerceptorG)).toEqual([
      'fisica',
      'fisica',
      'fisica',
      'fisica',
      'atribucion',
      'atribucion',
      'juridica',
      'juridica',
      'juridica',
      'desconocido',
    ]);
  });

  it('las sociedades se quitan con un aviso que dice cuales', () => {
    const r = revisarPerceptoresG(perceptoresProfesionales(facturas), facturas);
    expect(r.perceptores.map((p) => p.proveedorId).sort()).toEqual(['cb', 'dni', 'nie', 'sc']);
    expect(r.avisos).toEqual([
      'Se han quitado del 190 estos 2 proveedores con NIF de sociedad: Consultora Levante, S.L. (B46000006), Grandes Despachos, S.A. (A10952364). ' +
        'En la clave G solo van personas físicas y entidades en atribución de rentas (comunidades de bienes, sociedades civiles, herencias yacentes). ' +
        'Si les retuviste IRPF por error, corrige esas facturas (sus retenciones siguen en el 111 y el cuadre no coincidirá); si el NIF está mal, corrígelo en la ficha del proveedor.',
    ]);
  });

  it('subclave: 15 % -> G.01; 7 % -> G.03 con aviso (podria ser G.02); otro tipo -> G.01 con aviso', () => {
    const fs = [factura('a', nif(30000004), 'Lucía Díaz Sanz', 7), factura('b', nif(30000005), 'Pedro Gil', 19), factura('c', nif(30000006), 'Eva Sol', 15)];
    const r = revisarPerceptoresG(perceptoresProfesionales(fs), fs);
    expect(r.perceptores.map((p) => `${p.proveedorId}${p.subclave}`).sort()).toEqual(['a03', 'b01', 'c01']);
    expect(r.avisos).toEqual([expect.stringMatching(/al 7 % van con la subclave G\.03.*G\.02/), expect.stringMatching(/retención del 19 %, que no es el 15 % general: van con la subclave G\.01/)]);
    // Solo el 15 %: sin avisos.
    expect(revisarPerceptoresG(perceptoresProfesionales([fs[2]]), [fs[2]]).avisos).toEqual([]);
  });
});

describe('190: NIF con su letra o digito de control (declarante, perceptores y conyuge)', () => {
  const [ana] = perceptoresReales().filter((p) => p.clave === 'A' && p.nif === ANA && !p.ejercicioDevengo);
  const [g] = perceptoresReales().filter((p) => p.clave === 'G' && p.nif === ASESORIA);

  it('cada error dice que NIF falla y donde se corrige', () => {
    const malDni = `${ANA.slice(0, 8)}${ANA[8] === 'A' ? 'B' : 'A'}`;
    expect(
      erroresFichero190({ ...declarante, nif: 'B12345678' }, [
        { ...ana, nif: malDni },
        { ...ana, nif: 'B46000006', clave: 'L', subclave: '01' },
        { ...ana, nifConyuge: 'X1234567A' },
        { ...g, nif: 'E12345670' },
      ]),
    ).toEqual([
      'El NIF de la empresa (B12345678) no es válido: el dígito de control no corresponde a sus cifras. Corrígelo en Registro Mercantil > Datos para la memoria.',
      `Peña Ibáñez Ana María: el NIF del trabajador (${malDni}) no es válido: la letra no corresponde a sus cifras. Corrígelo en Nóminas > Empleados, en su ficha.`,
      'Peña Ibáñez Ana María: el NIF del trabajador (B46000006) no es válido: es el NIF de una sociedad, no el de una persona. Corrígelo en Nóminas > Empleados, en su ficha.',
      'Peña Ibáñez Ana María: el NIF del cónyuge (X1234567A) no es válido: la letra no corresponde a sus cifras. Corrígelo en Nóminas > Empleados, en la ficha del trabajador.',
      'Asesoría Muñoz, C.B.: el NIF del proveedor (E12345670) no es válido: el dígito de control no corresponde a sus cifras. Corrígelo en la ficha del proveedor (Proveedores).',
    ]);
  });

  it('con todos los NIF bien no hay errores de NIF', () => {
    expect(erroresFichero190(declarante, [ana, g])).toEqual([]);
  });
});
