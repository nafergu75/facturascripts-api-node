// Extractos bancarios en Excel o CSV, y movimientos repetidos.
//
// Regresion: importar dos extractos que se solapan duplicaba los movimientos.
const existentes: Array<{ cuentaBancariaId: string; fecha: string; importe: number; concepto: string }> = [];
const creados: unknown[] = [];
jest.mock('../config/database', () => ({
  prisma: {
    bankAccount: { findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === 'c1' ? { id: 'c1', companyId: 'e1' } : null)) },
    bankMovement: {
      findMany: jest.fn(async ({ where }: { where: { cuentaBancariaId: string; fecha: { gte: string; lte: string } } }) =>
        existentes.filter((m) => m.cuentaBancariaId === where.cuentaBancariaId && m.fecha >= where.fecha.gte && m.fecha <= where.fecha.lte),
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const m = { id: `m${creados.length}`, referencia: null, ...data };
        creados.push(m);
        return m;
      }),
    },
  },
}));

import * as XLSX from 'xlsx';
import { leerExtracto, leerImporte, leerFecha } from '../services/extractoBancario.service';
import { importarExtractoArchivo, separarRepetidos } from '../services/bancos.service';

/** Numero de serie de Excel de una fecha (asi guardan las fechas los bancos). */
const serie = (a: number, m: number, d: number) => ({ t: 'n', v: Math.round((Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000), z: 'dd/mm/yyyy' });

function excel(filas: unknown[][], tipo: 'xlsx' | 'biff8' = 'xlsx'): Buffer {
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, XLSX.utils.aoa_to_sheet(filas), 'Movimientos');
  return XLSX.write(libro, { type: 'buffer', bookType: tipo }) as Buffer;
}

// Formato tipico: titular e IBAN arriba, fecha operacion y valor, importe con signo y saldo.
const CON_IMPORTE = [
  ['Consulta de movimientos'],
  ['Titular:', 'EJEMPLO SL'],
  ['Cuenta:', 'ES91 2100 0418 4502 0005 1332'],
  [],
  ['Fecha Operación', 'Fecha Valor', 'Concepto', 'Importe', 'Saldo'],
  [serie(2026, 5, 3), serie(2026, 5, 3), 'TRANSFERENCIA DE CLIENTE SA', 1210, 6210],
  [serie(2026, 5, 5), serie(2026, 5, 6), 'RECIBO LUZ', -85.4, 6124.6],
  [serie(2026, 5, 5), serie(2026, 5, 5), 'COMISION MANTENIMIENTO', -6, 6118.6],
  [],
  ['Saldo final', '', '', '', 6118.6],
];

// Columnas de cargo y abono, importes en texto con formato europeo, fechas en texto.
const CARGO_ABONO = [
  ['Fecha', 'Descripción', 'Cargo', 'Abono', 'Referencia'],
  ['03/05/2026', 'Pago proveedor', '1.234,56', '', 'F-77'],
  ['04/05/2026', 'Cobro factura 12', '', '2.000,00', ''],
];

describe('lectura de extractos', () => {
  it('Excel con filas de titulo, fecha de operacion, importe y saldo; salta el pie', () => {
    const r = leerExtracto(excel(CON_IMPORTE), 'movimientos.xlsx');
    expect(r.formato).toBe('xlsx');
    expect(r.columnas).toMatchObject({ fecha: 'Fecha Operación', concepto: 'Concepto', importe: 'Importe', saldo: 'Saldo' });
    expect(r.filas.map((f) => [f.fecha, f.importe, f.concepto])).toEqual([
      ['2026-05-03', 1210, 'TRANSFERENCIA DE CLIENTE SA'],
      ['2026-05-05', -85.4, 'RECIBO LUZ'],
      ['2026-05-05', -6, 'COMISION MANTENIMIENTO'],
    ]);
    expect(r.avisos).toEqual([]);
  });

  it('Excel antiguo (.xls) con cargo y abono en texto', () => {
    const r = leerExtracto(excel(CARGO_ABONO, 'biff8'), 'extracto.xls');
    expect(r.formato).toBe('xls');
    expect(r.filas.map((f) => [f.fecha, f.importe, f.referencia])).toEqual([
      ['2026-05-03', -1234.56, 'F-77'],
      ['2026-05-04', 2000, undefined],
    ]);
  });

  it('CSV con punto y coma, comillas y cabecera', () => {
    const csv = 'Fecha;Concepto;Importe;Saldo\n03/05/2026;"Pago; con punto y coma";-10,50;989,50\n04/05/2026;Ingreso;100;1.089,50\n';
    const r = leerExtracto(Buffer.from(csv), 'extracto.csv');
    expect(r.filas.map((f) => [f.concepto, f.importe])).toEqual([
      ['Pago; con punto y coma', -10.5],
      ['Ingreso', 100],
    ]);
  });

  it('avisa si los saldos no cuadran con los importes', () => {
    const malo = CON_IMPORTE.map((f) => [...f]);
    malo[6][4] = 9999;
    expect(leerExtracto(excel(malo)).avisos[0]).toMatch(/saldos del extracto no cuadran/);
  });

  it('todo o nada: una fila con importe y fecha ilegible rechaza el extracto, diciendo la fila', () => {
    const malo = [...CARGO_ABONO, ['31/02/2026', 'Fecha imposible', '10,00', '', '']];
    expect(() => leerExtracto(excel(malo))).toThrow(/fila 4: fecha no válida/);
  });

  it('sin columnas de fecha e importe no adivina', () => {
    expect(() => leerExtracto(excel([['Nombre', 'Apellidos'], ['a', 'b']]))).toThrow(/fila de títulos/);
  });

  it('un fichero que dice ser Excel y no lo es se rechaza', () => {
    expect(() => leerExtracto(Buffer.from('hola'), 'trampa.xlsx')).toThrow(/no lo es/);
  });

  it('importes y fechas en los formatos de los bancos', () => {
    expect(leerImporte('-1.234,56 €')).toBe(-1234.56);
    expect(leerImporte('(50,00)')).toBe(-50);
    expect(leerImporte('12,30-')).toBe(-12.3);
    expect(leerImporte('1.234')).toBe(1234);
    expect(leerImporte('1234.5')).toBe(1234.5);
    expect(leerImporte('')).toBeNull();
    expect(leerImporte('abc')).toBeNaN();
    expect(leerFecha('3/5/26')).toBe('2026-05-03');
    expect(leerFecha(46145)).toBe('2026-05-03');
  });
});

describe('movimientos repetidos', () => {
  beforeEach(() => {
    existentes.length = 0;
    creados.length = 0;
  });

  it('un extracto que se solapa con otro ya importado solo añade lo nuevo', async () => {
    existentes.push({ cuentaBancariaId: 'c1', fecha: '2026-05-03', importe: 1210, concepto: 'TRANSFERENCIA DE CLIENTE SA' });
    const vista = await importarExtractoArchivo('e1', 'c1', excel(CON_IMPORTE), 'm.xlsx', { vistaPrevia: true });
    expect(vista).toMatchObject({ total: 3, nuevos: 2, repetidos: 1, entradas: 1210, salidas: -91.4 });
    expect(creados).toHaveLength(0); // la vista previa no guarda

    const r = await importarExtractoArchivo('e1', 'c1', excel(CON_IMPORTE), 'm.xlsx');
    expect(r).toMatchObject({ importados: 2, repetidos: 1 });
    expect(creados.map((m) => (m as { origen: string }).origen)).toEqual(['excel', 'excel']);
  });

  it('dos pagos iguales el mismo dia son dos movimientos', async () => {
    existentes.push({ cuentaBancariaId: 'c1', fecha: '2026-05-05', importe: -6, concepto: 'Comision' });
    const m = { fecha: '2026-05-05', importe: -6, concepto: 'COMISION' };
    const r = await separarRepetidos('c1', [m, { ...m }]);
    expect(r.repetidos).toHaveLength(1);
    expect(r.nuevos).toHaveLength(1);
  });

  it('no deja importar en la cuenta de otra empresa', async () => {
    await expect(importarExtractoArchivo('otra', 'c1', excel(CON_IMPORTE), 'm.xlsx')).rejects.toThrow(/no encontrada/);
  });
});
