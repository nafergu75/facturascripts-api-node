/**
 * Columnas de los listados de «Traer la contabilidad de 2026» (sin base de
 * datos): en un inmovilizado o una cartera con «Código» (del bien o del
 * cliente) y «Cuenta», la cuenta es «Cuenta»; «% Amort.» es el coeficiente; y
 * si la columna elegida como cuenta del bien no trae cuentas 2xx, se piden
 * las columnas a mano.
 */
import { describe, it, expect } from '@jest/globals';
import { detectarCabecera } from '../services/arranque/campos';
import { clasificarHoja } from '../services/arranque/clasificador';
import { extraerHoja, type Extraccion } from '../services/arranque/extractores';
import { leerLibro } from '../services/arranque/lectorLibros';
import { libro } from './fixtures/arranque/generar';

const TITULOS = ['Código', 'Descripción', 'Cuenta', 'Fecha adquisición', 'Valor adquisición', '% Amort.', 'Amort. acumulada'];
const BIENES = [
  [1, 'Nave industrial', '2110000000', '01/01/2020', 100000, 3, 21000],
  [2, 'Furgoneta', '2180000000', '01/07/2024', 24000, 16, 5760],
];

function leer(filas: unknown[][]) {
  const l = leerLibro(libro([['Inmovilizado', filas]]), 'inmovilizado.xlsx');
  const h = l.hojas[0];
  const c = clasificarHoja({ fichero: 'inmovilizado.xlsx', hoja: h.hoja, filas: h.filas, formato: l.formato });
  return { c, r: extraerHoja(c.tipo, h.filas, { cabecera: c.cabecera, longitud: 10, formato: l.formato }) };
}

describe('columna de la cuenta', () => {
  it('con «Código» y «Cuenta», la cuenta es «Cuenta» (vaya antes o despues)', () => {
    expect(detectarCabecera([TITULOS])!.campos.cuenta).toBe(2);
    expect(detectarCabecera([['Cuenta', 'Código', 'Descripción', 'Importe pendiente']])!.campos.cuenta).toBe(0);
    // Si solo hay «Código», es la cuenta (plan de cuentas de Contasol, por ejemplo).
    expect(detectarCabecera([['Código', 'Descripción', 'Saldo']])!.campos.cuenta).toBe(0);
  });

  it('«% Amort.», «Porc. amort.» y «% Amortización» son el coeficiente', () => {
    for (const t of ['% Amort.', 'Porc. amort.', '% Amortización', 'Porcentaje amort.']) expect(detectarCabecera([['Cuenta', t]])!.campos.coeficiente).toBe(1);
  });

  it('el listado de inmovilizado tipico se lee con su cuenta y su coeficiente', () => {
    const { c, r } = leer([['Fichas de inmovilizado'], TITULOS, ...BIENES]);
    expect(c.tipo).toBe('INMOVILIZADO');
    expect(r.error).toBeNull();
    const e = r.extraccion as Extraccion & { tipo: 'INMOVILIZADO' };
    expect(e.activos.map((a) => [a.cuentaBien, a.coeficiente, a.coste, a.amortAcumulada])).toEqual([
      ['2110000000', 3, 100000, 21000],
      ['2180000000', 16, 24000, 5760],
    ]);
  });

  it('si la columna de la cuenta no trae 2xx, pide las columnas a mano', () => {
    const { r } = leer([['Fichas de inmovilizado'], ['Código', 'Descripción', 'Fecha adquisición', 'Valor adquisición', 'Amort. acumulada'], ...BIENES.map((b) => [b[0], b[1], b[3], b[4], b[6]])]);
    expect(r.error?.necesitaMapeo).toBe(true);
    expect(r.error?.mensaje).toMatch(/no trae cuentas del grupo 2/);
    expect(r.error?.columnas.length).toBeGreaterThan(0);
  });
});

describe('hoja sin reconocer y columnas para elegir', () => {
  const RARO = [
    ['Listado'],
    ['Codigo contable X', 'Denominacion Y', 'Importe A', 'Importe B'],
    ['57200001', 'Banco', '9000,00', '0,00'],
    ['10000000', 'Capital', '0,00', '9000,00'],
  ];

  it('enseña sus primeras filas y las columnas con su título y dos ejemplos de datos', () => {
    const r = extraerHoja('DESCONOCIDO', RARO, { cabecera: null, longitud: 8, formato: 'csv' });
    expect(r.error?.muestra?.slice(0, 2)).toEqual([['Listado'], ['Codigo contable X', 'Denominacion Y', 'Importe A', 'Importe B']]);
    expect(r.error?.columnas.map((c) => [c.letra, c.titulo, c.ejemplos])).toEqual([
      ['A', 'Codigo contable X', ['57200001', '10000000']],
      ['B', 'Denominacion Y', ['Banco', 'Capital']],
      ['C', 'Importe A', ['9000,00', '0,00']],
      ['D', 'Importe B', ['0,00', '9000,00']],
    ]);
    expect(r.error?.filaTitulos).toBe(2);
  });

  it('al elegir «Sumas y saldos» el mapeo enseña títulos reales y la fila de títulos para mandarla', () => {
    const r = extraerHoja('SUMAS_Y_SALDOS', RARO, { cabecera: null, longitud: 8, formato: 'csv' });
    const columnas = r.error?.columnas ?? r.columnas ?? [];
    expect(columnas[0]).toMatchObject({ titulo: 'Codigo contable X', ejemplo: '57200001' });
    // Con las columnas y la fila de titulos elegidas a mano, se lee bien.
    const m = extraerHoja('SUMAS_Y_SALDOS', RARO, { cabecera: null, mapeo: { cuenta: 0, nombre: 1, saldoDeudor: 2, saldoAcreedor: 3 }, filaCabecera: 2, longitud: 8, formato: 'csv' });
    expect(m.error).toBeNull();
    const e = m.extraccion as Extract<Extraccion, { tipo: 'SUMAS_Y_SALDOS' }>;
    expect(e.lectura.cuentas.map((c) => [c.codigo, c.saldo]).sort()).toEqual([
      ['10000000', -9000],
      ['57200001', 9000],
    ]);
    // Una hoja leida trae tambien sus columnas, para revisarlas.
    expect(m.columnas?.map((c) => c.titulo)).toEqual(['Codigo contable X', 'Denominacion Y', 'Importe A', 'Importe B']);
    expect(m.filaTitulos).toBe(2);
  });
});
