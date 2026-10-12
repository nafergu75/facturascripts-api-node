/**
 * Clasificador de hojas de «Traer la contabilidad de 2026»: cada fichero
 * sintetico sale con su tipo y su confianza; las dudosas, con dos candidatos;
 * el contenido manda sobre la huella del programa. Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import { clasificarHoja, detectarPrograma, fechaCorteDeTitulos, UMBRAL_TIPO, type TipoHoja } from '../services/arranque/clasificador';
import { leerLibro } from '../services/arranque/lectorLibros';
import {
  a3SumasSaldos,
  contaplusDiario,
  contaplusSubcuentas,
  contasolSumasSaldos,
  ficherosEmpresaA,
  ficherosEmpresaB,
  holdedSumasSaldos,
  libro,
  libroCompleto,
  mayorPorCuenta,
  monitorPlan,
  planSinTitulos,
  planWindows1252,
  sageSumasSaldos,
  type FicheroPrueba,
} from './fixtures/arranque/generar';

function clasificar(f: FicheroPrueba) {
  const l = leerLibro(f.contenido, f.nombre);
  expect(l.error).toBeNull();
  return l.hojas.map((h) => clasificarHoja({ fichero: f.nombre, hoja: h.hoja, filas: h.filas, formato: l.formato }));
}

function esperar(f: FicheroPrueba, tipo: TipoHoja, programa?: string) {
  const [c] = clasificar(f);
  expect({ fichero: f.nombre, tipo: c.tipo }).toEqual({ fichero: f.nombre, tipo });
  expect(c.confianza).toBeGreaterThanOrEqual(UMBRAL_TIPO);
  expect(c.dudosa).toBe(false);
  if (programa) expect(c.programa).toBe(programa);
  return c;
}

describe('clasificador: ficheros de la empresa A (Excel genérico)', () => {
  const a = ficherosEmpresaA();
  it('reconoce cada fichero por sus columnas y contenido', () => {
    esperar(a.plan, 'PLAN', 'generico');
    const sys = esperar(a.sumasSaldos, 'SUMAS_Y_SALDOS', 'generico');
    expect(sys.fechaCorte).toBe('2026-12-31');
    esperar(a.diario, 'DIARIO');
    esperar(a.clientes, 'TERCEROS_CLIENTES');
    esperar(a.proveedores, 'TERCEROS_PROVEEDORES');
    const cartera = esperar(a.cartera, 'CARTERA');
    expect(cartera.fechaCorte).toBe('2026-12-31');
    esperar(a.inmovilizado, 'INMOVILIZADO');
  });
});

describe('clasificador: empresa B', () => {
  const b = ficherosEmpresaB();
  it('plan de 8 dígitos, sumas y saldos regularizado, PyG oficial y cartera', () => {
    esperar(b.plan, 'PLAN');
    esperar(b.sumasSaldos, 'SUMAS_Y_SALDOS');
    esperar(b.pyg, 'PYG');
    esperar(b.cartera, 'CARTERA');
  });
});

describe('clasificador: formatos de cada programa', () => {
  it('a3ECO: sumas y saldos por niveles, con su huella', () => {
    const c = esperar(a3SumasSaldos(), 'SUMAS_Y_SALDOS', 'a3');
    expect(c.textoPrograma).toBe('Parece un listado de a3ECO / a3asesor');
    expect(c.fechaCorte).toBe('2026-12-31');
  });
  it('ContaPlus: SUBCTA.DBF es el plan y DIARIO.DBF el diario', () => {
    esperar(contaplusSubcuentas(), 'PLAN', 'contaplus');
    esperar(contaplusDiario(), 'DIARIO', 'contaplus');
  });
  it('Sage 50, Holded y Contasol: sumas y saldos', () => {
    esperar(sageSumasSaldos(), 'SUMAS_Y_SALDOS', 'sage');
    esperar(holdedSumasSaldos(), 'SUMAS_Y_SALDOS', 'holded');
    esperar(contasolSumasSaldos(), 'SUMAS_Y_SALDOS', 'contasol');
  });
  it('Monitor: plan de cuentas', () => {
    esperar(monitorPlan(), 'PLAN', 'monitor');
  });
  it('Excel sin títulos: código y nombre es un plan', () => {
    const c = esperar(planSinTitulos(), 'PLAN');
    expect(c.cabecera).toBeNull();
  });
  it('libro con plan, sumas y saldos y diario en tres hojas', () => {
    expect(clasificar(libroCompleto()).map((c) => c.tipo)).toEqual(['PLAN', 'SUMAS_Y_SALDOS', 'DIARIO']);
  });
  it('mayor por cuenta (la cuenta en líneas de encabezado) cuenta como diario', () => {
    esperar(mayorPorCuenta(), 'DIARIO');
  });
  it('CSV en Windows-1252 con un título: plan', () => {
    esperar(planWindows1252(), 'PLAN');
  });
});

describe('clasificador: dudas y huellas', () => {
  it('un listado con NIF y nombre sin pistas de clientes o proveedores queda dudoso con los dos candidatos', () => {
    const f = { nombre: 'listado.xlsx', contenido: libro([['Hoja1', [['NIF', 'Nombre'], ['B12345674', 'Uno SL'], ['B76543214', 'Dos SL']]]]) };
    const [c] = clasificar(f);
    expect(c.dudosa).toBe(true);
    expect(c.tipo).toBe('DESCONOCIDO');
    expect(c.candidatos.map((x) => x.tipo).sort()).toEqual(['TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES']);
  });

  it('el contenido manda sobre la huella: un «a3» que trae un diario es un diario', () => {
    const f = { nombre: 'a3eco_listado.xlsx', contenido: libro([['Hoja1', [['A3ECO'], ['Fecha', 'Asiento', 'Cuenta', 'Concepto', 'Debe', 'Haber'], ['01/02/2026', 1, '4300000001', 'x', 10, ''], ['01/02/2026', 1, '7000000000', 'x', '', 10], ['02/02/2026', 2, '4300000001', 'y', 5, ''], ['02/02/2026', 2, '7000000000', 'y', '', 5]]]]) };
    const [c] = clasificar(f);
    expect(c.tipo).toBe('DIARIO');
    expect(c.programa).toBe('a3');
  });

  it('una hoja que no se parece a nada no tiene tipo', () => {
    const f = { nombre: 'notas.xlsx', contenido: libro([['Hoja1', [['Hola'], ['Esto son notas'], ['sin datos contables']]]]) };
    const [c] = clasificar(f);
    expect(c.tipo).toBe('DESCONOCIDO');
    expect(c.candidatos).toEqual([]);
  });

  it('huellas por programa y fechas de corte de los títulos', () => {
    expect(detectarPrograma('sumas y saldos holded', [])).toBe('holded');
    expect(detectarPrograma('listado', ['subcta', 'titulo'])).toBe('contaplus');
    expect(detectarPrograma('software del sol contasol', [])).toBe('contasol');
    expect(detectarPrograma('sage 200', [])).toBe('sage');
    expect(detectarPrograma('balance', [], 'dbf')).toBe('contaplus');
    expect(detectarPrograma('balance', [])).toBe('generico');
    expect(fechaCorteDeTitulos([['Sumas y saldos del 01/01/2026 al 30/11/2026']])).toBe('2026-11-30');
    expect(fechaCorteDeTitulos([['Saldos a 31 de diciembre de 2026']])).toBe('2026-12-31');
    expect(fechaCorteDeTitulos([['Sin fecha']])).toBeNull();
  });
});
