/**
 * Nominas sin base de datos: NIF/NAF, cuadre, cuentas, asiento por trabajador,
 * lector del Excel de la gestoria, validacion de entradas (400, nunca 500),
 * permisos de las rutas y el lector de gastos (las nominas no son facturas).
 * Los NIF y NAF son inventados (numeros con su control calculado).
 */
jest.mock('../config/database', () => ({ prisma: {} }));

import express from 'express';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { controlNaf, errorNaf, errorNifPersona, letraNif, normalizarNaf, normalizarNif } from '../utils/nif';
import {
  cuadreNomina,
  cuentasNominasPorDefecto,
  generarAsientoNomina,
  longitudMasHabitual,
  resolverCuentasNominas,
  siguienteSubcuenta465,
  ultimoDiaMes,
  type DatosAsientoNomina,
} from '../services/nominas/calculo';
import {
  filasDesdeJson,
  leerNominasDeFilas,
  mapearTitulosNominas,
  normalizarTituloNomina,
  parsearPeriodo,
  parsearTipo,
  periodoEnTitulo,
} from '../services/nominas/lector';
import { leerFilasArchivo } from '../services/extractoBancario.service';
import { empleadoCrearSchema, nominaCrearSchema, parsear } from '../services/nominas/esquemas';
import { generarPlantillaNominas } from '../services/nominas.service';
import { permisosDeRoles, usuarioTienePermiso } from '../services/rbac.service';
import { clasificarDocumentoGasto, _construirGastoExtraido } from '../services/gastos-extractor.service';
import nominasRoutes from '../routes/nominas.routes';
import empleadosRoutes from '../routes/empleados.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import type { ImportesNomina } from '../domain/nominas.model';

const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const naf = (prov: number, num: number) => `${String(prov).padStart(2, '0')}${String(num).padStart(8, '0')}${controlNaf(prov, num)}`;

const importes = (p: Partial<ImportesNomina>): ImportesNomina => ({
  brutoDinerario: 0,
  dietasExentas: 0,
  especieValoracion: 0,
  ingresoACuenta: 0,
  ingresoACuentaRepercutido: false,
  indemnizacionExenta: 0,
  indemnizacionSujeta: 0,
  ssTrabajador: 0,
  irpf: 0,
  anticipos: 0,
  embargos: 0,
  otrasDeducciones: 0,
  liquido: 0,
  ssEmpresa: 0,
  ...p,
});

describe('NIF y NAF', () => {
  it('valida la letra del DNI, del NIE y de los NIF K/L/M', () => {
    expect(errorNifPersona('00000000T')).toBeNull();
    expect(errorNifPersona(nif(12345678))).toBeNull();
    expect(errorNifPersona('12345678A')).toMatch(/letra/);
    // NIE: X=0, Y=1, Z=2 delante del numero.
    expect(errorNifPersona(`X1234567${letraNif(1234567)}`)).toBeNull();
    expect(errorNifPersona(`Y1234567${letraNif(11234567)}`)).toBeNull();
    expect(errorNifPersona(`Z1234567${letraNif(21234567)}`)).toBeNull();
    expect(errorNifPersona(`K1234567${letraNif(1234567)}`)).toBeNull();
    expect(errorNifPersona('B12345678')).toMatch(/sociedad/);
    expect(errorNifPersona('1234')).toMatch(/formato/);
  });

  it('normaliza el NIF: mayusculas, sin separadores ni prefijo ES y con los ceros que quita Excel', () => {
    expect(normalizarNif(' 12.345.678-z ')).toBe('12345678Z');
    expect(normalizarNif('ES12345678Z')).toBe('12345678Z');
    expect(normalizarNif('1234567L')).toBe('01234567L');
    expect(normalizarNif('x-1234567-l')).toBe('X1234567L');
  });

  it('valida el NAF con sus digitos de control y recupera el cero de la provincia', () => {
    expect(errorNaf(naf(28, 12345678))).toBeNull();
    expect(naf(28, 12345678)).toBe('281234567840');
    expect(errorNaf(naf(8, 1234567))).toBeNull();
    expect(errorNaf('281234567841')).toMatch(/control/);
    expect(errorNaf('12345')).toMatch(/12 dígitos/);
    expect(normalizarNaf('28/12345678/40')).toBe('281234567840');
    expect(normalizarNaf(Number(naf(8, 1234567)))).toBe(naf(8, 1234567));
  });
});

describe('cuadre de la nomina', () => {
  it('liquido = devengado - deducciones; la especie suma y resta', () => {
    const q = cuadreNomina(importes({ brutoDinerario: 1700, especieValoracion: 100, ssTrabajador: 114.3, irpf: 180, embargos: 150, liquido: 1255.7, ssEmpresa: 540 }));
    expect(q).toMatchObject({ devengado: 1800, deducido: 544.3, liquidoCalculado: 1255.7, diferencia: 0, cuadra: true, costeEmpresa: 2240 });
  });

  it('admite 1 centimo de diferencia y no 2', () => {
    const base = { brutoDinerario: 2000, ssTrabajador: 127, irpf: 300 };
    expect(cuadreNomina(importes({ ...base, liquido: 1573.01 })).cuadra).toBe(true);
    const q = cuadreNomina(importes({ ...base, liquido: 1573.02 }));
    expect(q).toMatchObject({ cuadra: false, diferencia: 0.02 });
  });

  it('el ingreso a cuenta repercutido reduce el liquido; el no repercutido es coste de la empresa', () => {
    const rep = importes({ brutoDinerario: 2000, especieValoracion: 200, ingresoACuenta: 30, ingresoACuentaRepercutido: true, ssTrabajador: 127, irpf: 300, liquido: 1543 });
    expect(cuadreNomina(rep).cuadra).toBe(true);
    const noRep = { ...rep, ingresoACuentaRepercutido: false, liquido: 1573 };
    expect(cuadreNomina(noRep)).toMatchObject({ cuadra: true, costeEmpresa: 2030 });
  });
});

describe('cuentas de nominas', () => {
  it('genera las subcuentas con la longitud del plan', () => {
    expect(cuentasNominasPorDefecto(6)).toMatchObject({
      sueldos: '640000',
      ssEmpresa: '642000',
      ssAcreedora: '476000',
      irpfTrabajo: '475101',
      anticipos: '460000',
      embargos: '465999',
      otrasDeducciones: '465998',
      dietas: '640000',
    });
    expect(cuentasNominasPorDefecto(10)).toMatchObject({ sueldos: '6400000000', irpfTrabajo: '4751000001', embargos: '4659999999' });
    // La 4751 de trabajo no es la de profesionales de las reglas por defecto (475100).
    expect(cuentasNominasPorDefecto(6).irpfTrabajo).not.toBe('475100');
  });

  it('la longitud es la mas habitual de la empresa (sin contar las de 3 digitos); sin datos, 6', () => {
    expect(longitudMasHabitual(['430', '700', '5720000001', '4300000001', '7000000000', '477000'])).toBe(10);
    expect(longitudMasHabitual(['430', '570'])).toBe(6);
    expect(longitudMasHabitual([])).toBe(6);
  });

  it('las reglas contables pueden fijar cuentas (p. ej. dietas a la 629)', () => {
    const c = resolverCuentasNominas({ dietas: '629000', sueldos: 'x' } as never, 6);
    expect(c.dietas).toBe('629000');
    expect(c.sueldos).toBe('640000');
  });

  it('subcuenta 465 por trabajador: la siguiente libre, sin pisar las reservadas', () => {
    const c = cuentasNominasPorDefecto(6);
    expect(siguienteSubcuenta465([], 6, c)).toBe('465001');
    expect(siguienteSubcuenta465(['465001', '465002', '465999', '465998'], 6, c)).toBe('465003');
    expect(siguienteSubcuenta465(['4650000007'], 10, cuentasNominasPorDefecto(10))).toBe('4650000008');
  });
});

describe('asiento de la nomina (uno por trabajador)', () => {
  const cuentas = cuentasNominasPorDefecto(6);
  const trabajador = { nombreCompleto: 'Persona Prueba Uno', nif: nif(10000001), subcuenta465: '465001' };
  const datos = (p: Partial<ImportesNomina>): DatosAsientoNomina => ({ ...importes(p), ejercicio: 2026, mes: 1, tipo: 'ORDINARIA', fechaDevengo: '2026-01-31' });
  const porCuenta = (a: ReturnType<typeof generarAsientoNomina>) => Object.fromEntries(a.lineas.map((l) => [l.subcuenta, [l.debe, l.haber]]));

  it('nomina simple: 640 y 642 al debe; 476, 4751 y la 465 del trabajador al haber', () => {
    const a = generarAsientoNomina(datos({ brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 }), cuentas, trabajador);
    expect(a.fecha).toBe('2026-01-31');
    expect(a.descripcion).toBe('Nómina 01/2026 - Persona Prueba Uno');
    expect(porCuenta(a)).toEqual({ '640000': [2000, 0], '642000': [600, 0], '476000': [0, 727], '475101': [0, 300], '465001': [0, 1573] });
    expect(a.debeTotal).toBe(2600);
    expect(a.haberTotal).toBe(2600);
    expect(a.lineas.find((l) => l.subcuenta === '465001')?.concepto).toBe('Persona Prueba Uno');
  });

  it('con anticipo (460) y embargo (465 de embargos)', () => {
    const a = generarAsientoNomina(datos({ brutoDinerario: 1500, ssTrabajador: 95.25, irpf: 120, anticipos: 200, embargos: 50, liquido: 1034.75, ssEmpresa: 450 }), cuentas, trabajador);
    expect(porCuenta(a)).toEqual({
      '640000': [1500, 0],
      '642000': [450, 0],
      '476000': [0, 545.25],
      '475101': [0, 120],
      '460000': [0, 200],
      '465999': [0, 50],
      '465001': [0, 1034.75],
    });
  });

  it('especie: no es gasto aqui; el ingreso a cuenta repercutido va a la 4751 y reduce el liquido', () => {
    const a = generarAsientoNomina(
      datos({ brutoDinerario: 2000, especieValoracion: 200, ingresoACuenta: 30, ingresoACuentaRepercutido: true, ssTrabajador: 127, irpf: 300, liquido: 1543, ssEmpresa: 600 }),
      cuentas,
      trabajador,
    );
    expect(porCuenta(a)).toEqual({ '640000': [2000, 0], '642000': [600, 0], '476000': [0, 727], '475101': [0, 330], '465001': [0, 1543] });
  });

  it('especie con ingreso a cuenta no repercutido: la empresa lo carga a la 640', () => {
    const a = generarAsientoNomina(
      datos({ brutoDinerario: 2000, especieValoracion: 200, ingresoACuenta: 30, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 }),
      cuentas,
      trabajador,
    );
    expect(porCuenta(a)).toEqual({ '640000': [2030, 0], '642000': [600, 0], '476000': [0, 727], '475101': [0, 330], '465001': [0, 1573] });
  });

  it('indemnizacion a la 641 y dietas a la 629 si asi se configura', () => {
    const c = resolverCuentasNominas({ dietas: '629000' }, 6);
    const a = generarAsientoNomina(
      datos({ brutoDinerario: 1000, dietasExentas: 80, indemnizacionExenta: 3000, indemnizacionSujeta: 500, ssTrabajador: 63.5, irpf: 150, liquido: 4366.5, ssEmpresa: 300 }),
      c,
      trabajador,
    );
    expect(porCuenta(a)).toEqual({
      '640000': [1000, 0],
      '629000': [80, 0],
      '641000': [3500, 0],
      '642000': [300, 0],
      '476000': [0, 363.5],
      '475101': [0, 150],
      '465001': [0, 4366.5],
    });
  });

  it('el centimo de redondeo va a la 640 y el asiento cuadra', () => {
    const a = generarAsientoNomina(datos({ brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573.01, ssEmpresa: 600 }), cuentas, trabajador);
    expect(porCuenta(a)['640000']).toEqual([2000.01, 0]);
    expect(a.debeTotal).toBe(a.haberTotal);
  });

  it('una nomina que no cuadra no genera asiento', () => {
    expect(() => generarAsientoNomina(datos({ brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1600 }), cuentas, trabajador)).toThrow(/no cuadra/);
  });
});

/** Excel como los de las gestorias: titulo, cabecera con sus nombres, filas y total. */
function excelGestoria(filas: unknown[][], titulos?: string[]): unknown[][] {
  const cab = titulos ?? [
    'Trabajador',
    'D.N.I.',
    'Nº Afiliación S.S.',
    'Total devengado',
    'Retribución en especie',
    'Aportación trabajador',
    'Retención IRPF',
    '% IRPF',
    'Embargos',
    'Anticipos',
    'Líquido a percibir',
    'Coste S.S. empresa',
    'Coste total',
  ];
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.aoa_to_sheet([['RESUMEN DE NÓMINAS - ENERO 2026'], ['Empresa de pruebas'], [], cab, ...filas, ['TOTAL', '', '', 5300]]),
    'Hoja1',
  );
  const buffer = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return leerFilasArchivo(buffer, 'nominas.xlsx').filas;
}

const FILA_A = ['Persona Prueba Uno', nif(10000001), naf(28, 12345678), 2000, 0, 127, 300, 15, 0, 0, 1573, 600, 2600];
// Total devengado con la especie dentro (100): dinerario 1700.
const FILA_B = ['Persona Prueba Dos', nif(10000002), naf(46, 1234567), 1800, 100, 114.3, 180, 10.59, 150, 0, 1255.7, 540, 2340];
const FILA_C = ['Persona Prueba Tres', nif(10000003), '', 1500, 0, -95.25, -120, 8, 0, 200, 1084.75, 450, 1950];

describe('lector del Excel de la gestoria', () => {
  it('reconoce los titulos habituales de A3, Nominasol o Sage', () => {
    const t = (s: string) => normalizarTituloNomina(s);
    const m = mapearTitulosNominas(
      ['Apellidos y nombre', 'NIF', 'NAF', 'Bruto', 'SS Trab.', 'IRPF', 'Base IRPF', 'Neto a percibir', 'Cuota patronal', 'Coste empresa', 'Mes', 'Ingreso a cuenta'].map(t),
    );
    expect(m).toEqual({ nombre: 0, nif: 1, naf: 2, bruto: 3, ssTrabajador: 4, irpf: 5, liquido: 7, ssEmpresa: 8, costeTotal: 9, periodo: 10, ingresoACuenta: 11 });
    const m2 = mapearTitulosNominas(['Empleado', 'DNI', 'Total devengos', 'Cuota obrera', 'Retenciones', 'Embargo judicial', 'Líquido', 'Seguridad Social empresa'].map(t));
    expect(m2).toMatchObject({ nombre: 0, nif: 1, bruto: 2, ssTrabajador: 3, irpf: 4, embargos: 5, liquido: 6, ssEmpresa: 7 });
  });

  it('lee el Excel: salta el titulo y el total, toma el mes del titulo y deduce si el bruto incluye la especie', () => {
    const l = leerNominasDeFilas(excelGestoria([FILA_A, FILA_B, FILA_C]));
    expect(l.filaCabecera).toBe(4);
    expect(l.periodoTitulo).toEqual({ ejercicio: 2026, mes: 1 });
    expect(l.filasIgnoradas).toBe(1);
    expect(l.filas).toHaveLength(3);
    const [a, b, c] = l.filas;
    expect(a).toMatchObject({ fila: 5, nif: nif(10000001), naf: '281234567840', nombre: 'Persona Prueba Uno', ejercicio: 2026, mes: 1, tipo: 'ORDINARIA' });
    expect(a).toMatchObject({ brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, porcentajeIrpf: 15, liquido: 1573, ssEmpresa: 600, errores: [] });
    expect(b).toMatchObject({ brutoDinerario: 1700, especieValoracion: 100, embargos: 150, liquido: 1255.7, errores: [] });
    expect(b.avisos.join(' ')).toMatch(/incluye la especie/);
    expect(b.naf).toBe(naf(46, 1234567));
    // Deducciones en negativo: se toman en positivo.
    expect(c).toMatchObject({ ssTrabajador: 95.25, irpf: 120, anticipos: 200, naf: null, errores: [] });
    expect(l.avisos.join(' ')).toMatch(/en negativo/);
    for (const f of l.filas) expect(f.cuadre.cuadra).toBe(true);
  });

  it('marca la fila que no cuadra con la diferencia, y el NIF mal escrito', () => {
    const mala = [...FILA_A];
    mala[1] = '12345678A';
    mala[10] = 1580;
    const l = leerNominasDeFilas(excelGestoria([mala]));
    expect(l.filas[0].errores.join(' ')).toMatch(/letra del NIF/);
    expect(l.filas[0].errores.join(' ')).toMatch(/no cuadra.*diferencia de 7,00/);
  });

  it('un NAF con mal control es un aviso y no se guarda', () => {
    const f = [...FILA_A];
    f[2] = '281234567841';
    const l = leerNominasDeFilas(excelGestoria([f]));
    expect(l.filas[0].errores).toEqual([]);
    expect(l.filas[0].naf).toBeNull();
    expect(l.filas[0].avisos.join(' ')).toMatch(/control/);
  });

  it('el mes indicado al importar manda; si la columna Mes dice otro, error', () => {
    const titulos = ['Trabajador', 'NIF', 'Mes', 'Bruto', 'SS trabajador', 'IRPF', 'Líquido', 'SS empresa'];
    const filas = excelGestoria([['Uno', nif(10000001), '02/2026', 2000, 127, 300, 1573, 600]], titulos);
    expect(leerNominasDeFilas(filas).filas[0]).toMatchObject({ ejercicio: 2026, mes: 2, errores: [] });
    expect(leerNominasDeFilas(filas, { ejercicio: 2026, mes: 3 }).filas[0].errores.join(' ')).toMatch(/no es el indicado/);
  });

  it('sin mes en ningun sitio, error en la fila', () => {
    const libro = [['NIF', 'Bruto', 'Líquido', 'Nombre'], [nif(10000001), 100, 100, 'Uno']];
    expect(leerNominasDeFilas(libro).filas[0].errores.join(' ')).toMatch(/Falta el mes/);
    expect(leerNominasDeFilas(libro, { ejercicio: 2026, mes: 5 }).filas[0]).toMatchObject({ mes: 5, errores: [] });
  });

  it('CSV con punto y coma y coma decimal', () => {
    const csv = Buffer.from(`Nombre;NIF;Mes;Total devengado;SS trabajador;IRPF;Líquido;SS empresa\nUno;${nif(10000001)};01/2026;2.000,00;127,00;300,00;1.573,00;600,00\n`);
    const { filas } = leerFilasArchivo(csv, 'nominas.csv');
    const l = leerNominasDeFilas(filas, {}, 'csv');
    expect(l.separadorDecimal).toBe(',');
    expect(l.filas[0]).toMatchObject({ brutoDinerario: 2000, liquido: 1573, ssEmpresa: 600, errores: [] });
  });

  it('si no reconoce las columnas pide el mapeo, y con el mapeo lee', () => {
    const filas = [['Col1', 'Col2', 'Col3', 'Col4'], [nif(10000001), 'Uno', 1000, 1000]];
    let detalles: { necesitaMapeo?: boolean; columnas?: unknown[] } | undefined;
    try {
      leerNominasDeFilas(filas);
    } catch (e) {
      detalles = (e as { details?: typeof detalles }).details;
    }
    expect(detalles?.necesitaMapeo).toBe(true);
    expect(detalles?.columnas).toHaveLength(4);
    const l = leerNominasDeFilas(filas, { mapeo: { nif: 0, nombre: 1, bruto: 2, liquido: 3 }, filaCabecera: 1, ejercicio: 2026, mes: 1 });
    expect(l.filas[0]).toMatchObject({ nif: nif(10000001), brutoDinerario: 1000, liquido: 1000, errores: [] });
    expect(() => leerNominasDeFilas(filas, { mapeo: { nif: 0, bruto: 0, liquido: 3 } })).toThrow(/dos datos/);
  });

  it('el mes y el tipo se entienden en varios formatos', () => {
    expect(parsearPeriodo('01/2026')).toEqual({ ejercicio: 2026, mes: 1 });
    expect(parsearPeriodo('2026-11')).toEqual({ ejercicio: 2026, mes: 11 });
    expect(parsearPeriodo('Enero 2026')).toEqual({ ejercicio: 2026, mes: 1 });
    expect(parsearPeriodo('dic-25')).toEqual({ ejercicio: 2025, mes: 12 });
    expect(parsearPeriodo(202603)).toEqual({ ejercicio: 2026, mes: 3 });
    expect(parsearPeriodo(4, 2026)).toEqual({ ejercicio: 2026, mes: 4 });
    expect(parsearPeriodo('31/01/2026')).toEqual({ ejercicio: 2026, mes: 1 });
    expect(parsearPeriodo('13/2026')).toBeNull();
    expect(periodoEnTitulo([['Liquidación periodo 02/2026'], ['NIF']], 1)).toEqual({ ejercicio: 2026, mes: 2 });
    // Una fecha de emision no es el mes de las nominas.
    expect(periodoEnTitulo([['Fecha de emisión: 05/02/2026'], ['NIF']], 1)).toBeNull();
    expect(periodoEnTitulo([['Listado 31/01/2026'], ['NIF']], 1)).toBeNull();
    expect(parsearTipo('')).toBe('ORDINARIA');
    expect(parsearTipo('Paga extra de verano')).toBe('EXTRA');
    expect(parsearTipo('Finiquito')).toBe('FINIQUITO');
    expect(parsearTipo('cosa rara')).toBeNull();
  });

  it('filas ya revisadas (JSON): se validan igual y los importes que no son numeros dan error', () => {
    const [ok, mal] = filasDesdeJson([
      { nif: nif(10000001), nombre: 'Uno', ejercicio: 2026, mes: 1, brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 },
      { nif: nif(10000002), nombre: 'Dos', ejercicio: 2026, mes: 1, brutoDinerario: '2000', liquido: 2000 },
    ]);
    expect(ok.errores).toEqual([]);
    expect(mal.errores.join(' ')).toMatch(/brutoDinerario/);
    expect(() => filasDesdeJson('no es json')).toThrow(/JSON/);
  });

  it('la plantilla se puede volver a leer con el propio lector', () => {
    const { filas } = leerFilasArchivo(generarPlantillaNominas(), 'plantilla.xlsx');
    const m = mapearTitulosNominas(filas[0].map(normalizarTituloNomina));
    expect(Object.keys(m).sort()).toEqual(
      ['nombre', 'apellidos', 'nif', 'naf', 'periodo', 'tipo', 'bruto', 'especie', 'ingresoACuenta', 'dietas', 'indemnizacion', 'ssTrabajador', 'irpf', 'porcentajeIrpf', 'embargos', 'anticipos', 'otrasDeducciones', 'liquido', 'ssEmpresa', 'costeTotal'].sort(),
    );
  });

  it('ultimo dia del mes', () => {
    expect(ultimoDiaMes(2026, 2)).toBe('2026-02-28');
    expect(ultimoDiaMes(2028, 2)).toBe('2028-02-29');
    expect(ultimoDiaMes(2026, 12)).toBe('2026-12-31');
  });
});

describe('validacion de entradas (400, nunca 500)', () => {
  const base = { empleadoId: 'e1', ejercicio: 2026, mes: 1, brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 };
  const status = (fn: () => unknown) => {
    try {
      fn();
      return 200;
    } catch (e) {
      return (e as { statusCode?: number }).statusCode ?? 500;
    }
  };

  it('importes: string, negativo o con tres decimales dan 400', () => {
    expect(status(() => parsear(nominaCrearSchema, base))).toBe(200);
    expect(status(() => parsear(nominaCrearSchema, { ...base, brutoDinerario: '2000' }))).toBe(400);
    expect(status(() => parsear(nominaCrearSchema, { ...base, irpf: -1 }))).toBe(400);
    expect(status(() => parsear(nominaCrearSchema, { ...base, irpf: 300.001 }))).toBe(400);
    expect(status(() => parsear(nominaCrearSchema, { ...base, mes: 13 }))).toBe(400);
    expect(status(() => parsear(nominaCrearSchema, { ...base, campoRaro: 1 }))).toBe(400);
  });

  it('trabajador: NIF o NAF no validos dan 400', () => {
    expect(parsear(empleadoCrearSchema, { nif: ' 00000000t ', nombre: 'Uno' }).nif).toBe('00000000T');
    expect(status(() => parsear(empleadoCrearSchema, { nif: '12345678A', nombre: 'Uno' }))).toBe(400);
    expect(status(() => parsear(empleadoCrearSchema, { nif: '00000000T', nombre: 'Uno', naf: '281234567841' }))).toBe(400);
    expect(parsear(empleadoCrearSchema, { nif: '00000000T', nombre: 'Uno', naf: '28/12345678/40' }).naf).toBe('281234567840');
  });
});

describe('permisos de nominas', () => {
  it('admin y contable; no ventas, tesoreria ni solo-lectura', () => {
    for (const p of ['nominas:read', 'nominas:write']) {
      expect(usuarioTienePermiso(permisosDeRoles(['admin']), p)).toBe(true);
      expect(usuarioTienePermiso(permisosDeRoles(['contable']), p)).toBe(true);
      for (const rol of ['ventas', 'tesoreria', 'solo-lectura', 'solo_lectura']) expect(usuarioTienePermiso(permisosDeRoles([rol]), p)).toBe(false);
    }
  });

  function app(rol: string) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: 'u1', roles: [rol], companies: ['A'], rolesPorEmpresa: { A: [rol] } };
      req.companyId = 'A';
      next();
    });
    a.use('/nominas', nominasRoutes);
    a.use('/empleados', empleadosRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('solo-lectura, ventas y tesoreria reciben 403 al leer nominas o trabajadores', async () => {
    for (const rol of ['solo_lectura', 'ventas', 'tesoreria']) {
      expect((await request(app(rol)).get('/nominas?ejercicio=2026')).status).toBe(403);
      expect((await request(app(rol)).get('/nominas/resumen?ejercicio=2026')).status).toBe(403);
      expect((await request(app(rol)).get('/empleados')).status).toBe(403);
      expect((await request(app(rol)).get('/nominas/plantilla')).status).toBe(403);
    }
  });

  it('el contable recibe 400 (no 500) con datos mal formados, antes de tocar la base de datos', async () => {
    const r = await request(app('contable')).post('/nominas').send({ empleadoId: 'e1', ejercicio: 2026, mes: 1, brutoDinerario: 'mil', liquido: 1000 });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Bruto/);
    expect((await request(app('contable')).post('/empleados').send({ nif: '12345678A', nombre: 'X' })).status).toBe(400);
    expect((await request(app('contable')).get('/nominas/periodos/2026/13')).status).toBe(400);
    expect((await request(app('contable')).post('/nominas/resumen').send({ mes: 1, ejercicio: 2026, totalBruto: 1 })).status).toBe(400);
  });

  it('la plantilla se descarga como Excel', async () => {
    const r = await request(app('contable')).get('/nominas/plantilla');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
  });
});

describe('lector de gastos: las nominas no son facturas', () => {
  const lectura = {
    numero: '1',
    fecha: '2026-01-31',
    proveedor: 'Empresa',
    nif_proveedor: null,
    concepto: 'nómina',
    base: 1573,
    iva_porcentaje: null,
    iva_cantidad: null,
    total: 1573,
    raw_text: null,
  };

  it('si la lectura dice nomina o seguros sociales, no sugiere cuenta y avisa', () => {
    const g = _construirGastoExtraido({ ...lectura, tipo_documento: 'nomina' });
    expect(g).toMatchObject({ tipoDocumento: 'nomina', cuentaContableBase: null });
    expect(g.errores[0]).toMatch(/Nóminas/);
    expect(_construirGastoExtraido({ ...lectura, concepto: 'seguridad social', tipo_documento: 'seguros_sociales' }).cuentaContableBase).toBeNull();
  });

  it('sin tipo, solo un concepto "nómina" sin IVA cuenta como nomina; la factura de la gestoria no', () => {
    expect(clasificarDocumentoGasto({ concepto: 'Nómina', iva_cantidad: null, iva_porcentaje: null })).toBe('nomina');
    expect(clasificarDocumentoGasto({ concepto: 'gestión de nóminas', iva_cantidad: 21, iva_porcentaje: 21 })).toBe('factura');
    expect(clasificarDocumentoGasto({ tipo_documento: 'factura', concepto: 'nómina', iva_cantidad: null, iva_porcentaje: null })).toBe('factura');
    const g = _construirGastoExtraido({ ...lectura, concepto: 'servicios', iva_cantidad: 21, iva_porcentaje: 21, base: 100, total: 121, tipo_documento: 'factura' });
    expect(g.tipoDocumento).toBe('factura');
    expect(g.cuentaContableBase).not.toMatch(/^64/);
  });
});
