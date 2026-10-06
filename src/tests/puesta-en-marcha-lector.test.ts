/**
 * Lectura de balances y diarios de otros programas (sin BD): importes con coma
 * o punto, signos, codigos de cuenta, deteccion de columnas, agrupacion de
 * asientos y calculo de los asientos de cierre.
 */
import * as XLSX from 'xlsx';
import {
  agruparAsientos,
  cuentaYNombre,
  detectarSeparadorDecimal,
  leerBalance,
  leerBalanceDeFilas,
  leerDiario,
  leerDiarioDeFilas,
  normalizarCuenta,
  parsearFecha,
  parsearImporte,
  totalesSaldos,
} from '../services/puestaEnMarcha/lectorContable';
import { calcularAsientosCierre } from '../services/cierreEjercicio.service';
import { cuentaResultado } from '../services/puestaEnMarcha/puestaEnMarcha.service';
import type { AsientoSimple } from '../services/contabilidadDatos.service';

describe('importes', () => {
  it('coma decimal con puntos de miles y punto decimal con comas de miles', () => {
    expect(parsearImporte('1.234,56', ',')).toBe(1234.56);
    expect(parsearImporte('1,234.56', '.')).toBe(1234.56);
    expect(parsearImporte('1234,5', ',')).toBe(1234.5);
    expect(parsearImporte('1234.5', '.')).toBe(1234.5);
    expect(parsearImporte(1234.567, ',')).toBe(1234.57);
  });

  it('signos: delante, detras, parentesis y sufijo D/H', () => {
    expect(parsearImporte('-1.000,00')).toBe(-1000);
    expect(parsearImporte('1.000,00-')).toBe(-1000);
    expect(parsearImporte('(1.000,00)')).toBe(-1000);
    expect(parsearImporte('1.000,00 H')).toBe(-1000);
    expect(parsearImporte('1.000,00 D')).toBe(1000);
    expect(parsearImporte('1.000,00 €')).toBe(1000);
  });

  it('vacio es cero y un texto no es un importe', () => {
    expect(parsearImporte('')).toBe(0);
    expect(Number.isNaN(parsearImporte('abc'))).toBe(true);
  });

  it('detecta el separador decimal mirando la columna', () => {
    expect(detectarSeparadorDecimal(['1.234,56', '10,00'])).toBe(',');
    expect(detectarSeparadorDecimal(['1,234.56', '10.00'])).toBe('.');
    expect(detectarSeparadorDecimal([100, 200])).toBe(',');
  });
});

describe('cuentas y fechas', () => {
  it('codigos de 3 a 10 digitos, con puntos o como numero', () => {
    expect(normalizarCuenta('4300000001')).toBe('4300000001');
    expect(normalizarCuenta(5720001)).toBe('5720001');
    expect(normalizarCuenta('430.0001')).toBe('4300001');
    expect(normalizarCuenta('57')).toBeNull();
    expect(normalizarCuenta('12345678901')).toBeNull();
    expect(normalizarCuenta('Total grupo 1')).toBeNull();
    expect(cuentaYNombre('Cuenta: 4300000001 Cliente S.L.')).toEqual({ codigo: '4300000001', nombre: 'Cliente S.L.' });
  });

  it('fechas de Excel y en texto', () => {
    expect(parsearFecha(45658)).toBe('2025-01-01');
    expect(parsearFecha('31/12/2025')).toBe('2025-12-31');
    expect(parsearFecha('5-3-26')).toBe('2026-03-05');
    expect(parsearFecha('2026-03-05')).toBe('2026-03-05');
    expect(parsearFecha('31/02/2026')).toBeNull();
    expect(parsearFecha('Saldo anterior')).toBeNull();
  });
});

describe('balance de sumas y saldos', () => {
  it('con columnas Saldo deudor / Saldo acreedor y titulo en la fila 3', () => {
    const filas = [
      ['EMPRESA DEMO SL'],
      ['Balance de sumas y saldos a 31/12/2025'],
      ['Cuenta', 'Descripción', 'Sumas Debe', 'Sumas Haber', 'Saldo Deudor', 'Saldo Acreedor'],
      ['1000000000', 'Capital social', '0,00', '3.000,00', '', '3.000,00'],
      ['5720000001', 'Banco', '10.500,00', '2.000,00', '8.500,00', ''],
      ['4000000001', 'Proveedor', '500,00', '1.500,00', '', '1.000,00'],
      ['6000000000', 'Compras', '2.000,00', '', '2.000,00', ''],
      ['7000000000', 'Ventas', '', '6.500,00', '', '6.500,00'],
      ['', 'TOTAL', '', '', '10.500,00', '10.500,00'],
    ];
    const r = leerBalanceDeFilas(filas);
    expect(r.filaCabecera).toBe(3);
    expect(r.cuentas).toHaveLength(5);
    expect(r.cuentas.find((c) => c.codigo === '5720000001')?.saldo).toBe(8500);
    expect(r.cuentas.find((c) => c.codigo === '1000000000')?.saldo).toBe(-3000);
    expect(totalesSaldos(r.cuentas)).toEqual({ deudor: 10500, acreedor: 10500, diferencia: 0 });
  });

  it('dos pares Debe/Haber: el segundo son los saldos', () => {
    const filas = [
      ['Cuenta', 'Nombre', 'Debe', 'Haber', 'Debe', 'Haber'],
      ['572', 'Bancos', 1000, 400, 600, 0],
      ['100', 'Capital', 0, 600, 0, 600],
    ];
    const r = leerBalanceDeFilas(filas);
    expect(r.mapeo.saldoDeudor).toBe(4);
    expect(r.cuentas.map((c) => [c.codigo, c.saldo])).toEqual([
      ['100', -600],
      ['572', 600],
    ]);
  });

  it('quita las cuentas de nivel superior si vienen tambien sus subcuentas', () => {
    const filas = [
      ['Cuenta', 'Título', 'Saldo'],
      ['430', 'Clientes', '1.500,00'],
      ['4300000001', 'Cliente A', '1.000,00'],
      ['4300000002', 'Cliente B', '500,00'],
      ['100', 'Capital', '-1.500,00'],
    ];
    const r = leerBalanceDeFilas(filas);
    expect(r.agregadasOmitidas).toEqual(['430']);
    expect(r.cuentas.map((c) => c.codigo)).toEqual(['100', '4300000001', '4300000002']);
    expect(r.convencionSigno).toBe('deudor');
  });

  it('saldos en positivo: se interpretan por la naturaleza de la cuenta', () => {
    const filas = [
      ['Código', 'Cuenta', 'Importe'],
      ['2810000', 'Amort. acumulada', '200,00'],
      ['2160000', 'Mobiliario', '1.000,00'],
      ['5720000', 'Banco', '700,00'],
      ['1000000', 'Capital', '1.000,00'],
      ['4000000', 'Proveedores', '500,00'],
    ];
    const r = leerBalanceDeFilas(filas);
    expect(r.convencionSigno).toBe('naturaleza');
    expect(r.cuentas.find((c) => c.codigo === '2810000')?.saldo).toBe(-200);
    expect(r.cuentas.find((c) => c.codigo === '4000000')?.saldo).toBe(-500);
    expect(totalesSaldos(r.cuentas).diferencia).toBe(0);
  });

  it('mapeo manual cuando no hay titulos reconocibles', () => {
    const filas = [
      ['xx', 'yy', 'zz'],
      ['5720001', 'Banco', '100,00'],
      ['1000001', 'Capital', '-100,00'],
    ];
    expect(() => leerBalanceDeFilas(filas)).toThrow(/fila de títulos/);
    const r = leerBalanceDeFilas(filas, { mapeo: { cuenta: 0, nombre: 1, saldo: 2 }, filaCabecera: 1, convencionSigno: 'deudor' });
    expect(r.cuentas).toHaveLength(2);
  });

  it('lee un CSV con punto y coma y un Excel', () => {
    const csv = Buffer.from('Cuenta;Descripcion;Debe;Haber\n5720001;Banco;1.000,50;0\n1000001;Capital;0;1.000,50\n', 'utf8');
    const r = leerBalance(csv, 'balance.csv');
    expect(r.formato).toBe('csv');
    expect(r.cuentas.find((c) => c.codigo === '5720001')?.saldo).toBe(1000.5);

    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      libro,
      XLSX.utils.aoa_to_sheet([
        ['Subcuenta', 'Nombre', 'Saldo'],
        [5720001, 'Banco', 250.25],
        [1000001, 'Capital', -250.25],
      ]),
      'Hoja1',
    );
    const xlsx = XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    const r2 = leerBalance(xlsx, 'balance.xlsx');
    expect(r2.cuentas.map((c) => c.saldo)).toEqual([-250.25, 250.25]);
  });
});

describe('libro diario y mayor', () => {
  it('diario con numero de asiento, Debe y Haber', () => {
    const filas = [
      ['Fecha', 'Asiento', 'Cuenta', 'Concepto', 'Debe', 'Haber'],
      ['02/01/2026', '1', '6000000000', 'Compra', '100,00', ''],
      ['02/01/2026', '1', '4000000001', 'Compra', '', '100,00'],
      ['03/01/2026', '2', '4300000001', 'Venta', '121,00', ''],
      ['03/01/2026', '2', '7000000000', 'Venta', '', '100,00'],
      ['03/01/2026', '2', '4770000000', 'Venta', '', '21,00'],
    ];
    const l = leerDiarioDeFilas(filas);
    expect(l.apuntes).toHaveLength(5);
    const { asientos, agrupacion } = agruparAsientos(l.apuntes);
    expect(agrupacion).toBe('asiento');
    expect(asientos).toHaveLength(2);
    expect(asientos.every((a) => a.cuadra)).toBe(true);
  });

  it('importe con columna D/H y numero solo en la primera linea', () => {
    const filas = [
      ['Fecha', 'Nº Asiento', 'Subcuenta', 'Descripción', 'Importe', 'D/H'],
      ['10/02/2026', '7', '5720000', 'Cobro', '50,00', 'D'],
      ['10/02/2026', '', '4300001', 'Cobro', '50,00', 'H'],
    ];
    const l = leerDiarioDeFilas(filas);
    const { asientos } = agruparAsientos(l.apuntes);
    expect(asientos).toHaveLength(1);
    expect(asientos[0].lineas.map((x) => [x.cuenta, x.debe, x.haber])).toEqual([
      ['5720000', 50, 0],
      ['4300001', 0, 50],
    ]);
  });

  it('mayor por cuenta (sin columna de cuenta): agrupa por fecha', () => {
    const filas = [
      ['Fecha', 'Concepto', 'Debe', 'Haber', 'Saldo'],
      ['Cuenta: 5720000 Banco'],
      ['', 'Saldo anterior', '', '', '1.000,00'],
      ['15/03/2026', 'Cobro cliente', '200,00', '', '1.200,00'],
      ['Cuenta: 4300001 Cliente A'],
      ['15/03/2026', 'Cobro cliente', '', '200,00', '0,00'],
    ];
    const l = leerDiarioDeFilas(filas);
    expect(l.mayorPorCuenta).toBe(true);
    const { asientos, agrupacion } = agruparAsientos(l.apuntes);
    expect(agrupacion).toBe('fecha');
    expect(asientos).toHaveLength(1);
    expect(asientos[0].cuadra).toBe(true);
  });

  it('marca el asiento de apertura del fichero para no duplicarlo', () => {
    const l = leerDiario(
      Buffer.from('Fecha;Asiento;Cuenta;Concepto;Debe;Haber\n01/01/2026;1;5720000;Asiento de apertura;100;\n01/01/2026;1;1000000;Asiento de apertura;;100\n', 'utf8'),
      'diario.csv',
    );
    const { asientos } = agruparAsientos(l.apuntes);
    expect(asientos[0].especial).toBe('APERTURA');
  });
});

describe('asientos de cierre (calculo)', () => {
  const asiento = (fecha: string, lineas: Array<[string, number, number]>, tipo?: AsientoSimple['tipo']): AsientoSimple => ({
    fecha,
    numero: fecha,
    concepto: 'x',
    tipo,
    lineas: lineas.map(([subcuenta, debe, haber]) => ({ subcuenta, debe, haber })),
  });

  it('regularizacion, cierre y apertura cuadran y llevan el resultado a la 129', () => {
    const asientos = [
      asiento('2026-01-01', [['5720000001', 1000, 0], ['1000000000', 0, 1000]], 'APERTURA'),
      asiento('2026-02-01', [['4300000001', 1210, 0], ['7000000000', 0, 1000], ['4770000000', 0, 210]]),
      asiento('2026-03-01', [['6000000000', 400, 0], ['5720000001', 0, 400]]),
    ];
    const c = calcularAsientosCierre(asientos, 2026);
    expect(c.resultado).toBe(600);
    expect(c.cuentaResultado).toBe('1290000000');
    const sum = (l: typeof c.cierre) => [l.reduce((s, x) => s + x.debe, 0), l.reduce((s, x) => s + x.haber, 0)];
    for (const l of [c.regularizacion, c.cierre, c.apertura]) {
      const [d, h] = sum(l);
      expect(Math.round(d * 100)).toBe(Math.round(h * 100));
    }
    expect(c.regularizacion.find((l) => l.cuenta === '1290000000')).toMatchObject({ debe: 0, haber: 600 });
    expect(c.apertura.find((l) => l.cuenta === '1290000000')).toMatchObject({ debe: 0, haber: 600 });
    expect(c.apertura.find((l) => l.cuenta === '5720000001')).toMatchObject({ debe: 600, haber: 0 });
  });

  it('la cuenta 129 sigue la longitud de los codigos de la empresa', () => {
    expect(cuentaResultado(['5720001', '4300001'])).toBe('1290000');
    expect(cuentaResultado(['1290001', '5720001'])).toBe('1290001');
  });
});
