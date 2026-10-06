/**
 * Informes contables sin BD: periodo, sumas y saldos, mayor, diario, mayor de
 * clientes y proveedores, y la descarga en PDF y Excel.
 */
import { describe, it, expect } from '@jest/globals';
import * as XLSX from 'xlsx';
import {
  asientosParaTerceros,
  calcularDiario,
  calcularMayor,
  calcularMayorTerceros,
  calcularSumasYSaldos,
  crearNombrador,
  crearResolvedorTercero,
  cuentaEnFiltro,
  movimientosDelPeriodo,
  resolverPeriodo,
  SIN_IDENTIFICAR,
  type AsientoInforme,
  type ContextoTerceros,
  type Periodo,
} from '../services/informesContables.calculo';
import { nombreFichero, tablaAPdf, tablaAXlsx, textoPeriodo, type TablaInforme } from '../services/informesContables.documentos';

let n = 0;
const asiento = (
  fecha: string,
  lineas: Array<[string, number, number, string?]>,
  extra: Partial<AsientoInforme> = {},
): AsientoInforme => ({
  id: `a${++n}`,
  fecha,
  numero: `AS-${String(n).padStart(3, '0')}`,
  concepto: `Asiento ${n}`,
  tipo: 'NORMAL',
  invoiceId: null,
  invoiceType: null,
  lineas: lineas.map(([cuenta, debe, haber, referencia]) => ({ cuenta, nombre: '', debe, haber, referencia: referencia ?? null })),
  ...extra,
});

/**
 * 2025: dos ventas (cliente A y B), cobro de la de A, regularizacion y cierre.
 * 2026: apertura, compra al proveedor S y cobro de la de B.
 */
function libro(): AsientoInforme[] {
  n = 0;
  return [
    asiento('2025-01-10', [['430', 121, 0, 'A-1'], ['700', 0, 100], ['477', 0, 21]], { invoiceId: 'fA1', invoiceType: 'INGRESO', concepto: 'Factura A-1' }),
    asiento('2025-02-01', [['572', 121, 0], ['430', 0, 121]], { concepto: 'Cobro factura fA1' }),
    asiento('2025-03-01', [['430', 242, 0, 'A-2'], ['700', 0, 200], ['477', 0, 42]], { invoiceId: 'fA2', invoiceType: 'INGRESO' }),
    asiento('2025-12-31', [['700', 300, 0], ['129', 0, 300]], { tipo: 'REGULARIZACION', concepto: 'Regularizacion ejercicio 2025' }),
    asiento('2025-12-31', [['129', 300, 0], ['477', 63, 0], ['430', 0, 242], ['572', 0, 121]], { tipo: 'CIERRE', concepto: 'Cierre ejercicio 2025' }),
    asiento('2026-01-01', [['430', 242, 0], ['572', 121, 0], ['477', 0, 63], ['129', 0, 300]], { tipo: 'APERTURA', concepto: 'Apertura ejercicio 2026' }),
    asiento('2026-02-01', [['629', 50, 0], ['400', 0, 50, 'P-7']], { invoiceId: 'fP7', invoiceType: 'GASTO' }),
    asiento('2026-03-01', [['572', 242, 0], ['430', 0, 242, 'A-2']]),
  ];
}

const p = (q: Parameters<typeof resolverPeriodo>[0]): Periodo => {
  const r = resolverPeriodo(q);
  if (typeof r === 'string') throw new Error(r);
  return r;
};
const nombre = crearNombrador(new Map([['430', 'Clientes'], ['572', 'Bancos'], ['700', 'Ventas']]));
const ctxClientes: ContextoTerceros = {
  tipo: 'clientes',
  facturas: [
    { id: 'fA1', numero: 'A-1', terceroId: 'cliA' },
    { id: 'fA2', numero: 'A-2', terceroId: 'cliB' },
  ],
  fichas: [
    { id: 'cliA', nombre: 'Alfa SL', nif: 'B11111111' },
    { id: 'cliB', nombre: 'Beta SA', nif: 'A22222222' },
  ],
};

describe('periodo del informe', () => {
  it('ejercicio completo o desde/hasta dentro del mismo año', () => {
    expect(p({ ejercicio: '2025' })).toEqual({ desde: '2025-01-01', hasta: '2025-12-31', ejercicio: 2025 });
    expect(p({ desde: '2026-02-01', hasta: '2026-03-31' })).toEqual({ desde: '2026-02-01', hasta: '2026-03-31', ejercicio: 2026 });
    expect(p({ hasta: '2026-06-30' })).toEqual({ desde: '2026-01-01', hasta: '2026-06-30', ejercicio: 2026 });
  });
  it('rechaza periodos que cruzan de año o fechas mal escritas', () => {
    expect(resolverPeriodo({ desde: '2025-06-01', hasta: '2026-05-31' })).toMatch(/mismo ejercicio/);
    expect(resolverPeriodo({ desde: '01/02/2026' })).toMatch(/AAAA-MM-DD/);
    expect(resolverPeriodo({})).toMatch(/ejercicio/);
    expect(resolverPeriodo({ desde: '2026-05-01', hasta: '2026-04-01' })).toMatch(/posterior/);
  });
  it('texto del periodo', () => {
    expect(textoPeriodo('2025-01-01', '2025-12-31')).toBe('Ejercicio 2025');
    expect(textoPeriodo('2026-02-01', '2026-03-31')).toBe('Del 01/02/2026 al 31/03/2026');
  });
});

describe('balance de sumas y saldos', () => {
  it('un ejercicio cerrado no sale a cero: regularizacion y cierre fuera, y cuadra', () => {
    const r = calcularSumasYSaldos(movimientosDelPeriodo(libro(), p({ ejercicio: 2025 })), 'subcuenta', nombre);
    expect(r.cuadra).toBe(true);
    expect(r.totales.debe).toBe(r.totales.haber);
    const ventas = r.filas.find((f) => f.cuenta === '700')!;
    expect(ventas).toMatchObject({ nombre: 'Ventas', debe: 0, haber: 300, saldoAcreedor: 300 });
    expect(r.filas.find((f) => f.cuenta === '430')).toMatchObject({ debe: 363, haber: 121, saldoDeudor: 242 });
    expect(r.filas.find((f) => f.cuenta === '129')).toBeUndefined();
  });

  it('con apertura: el saldo inicial del 1 de enero es cero y la apertura es un movimiento', () => {
    const r = calcularSumasYSaldos(movimientosDelPeriodo(libro(), p({ ejercicio: 2026 })), 'subcuenta', nombre);
    expect(r.cuadra).toBe(true);
    expect(r.filas.every((f) => f.saldoInicial === 0)).toBe(true);
    expect(r.filas.find((f) => f.cuenta === '572')).toMatchObject({ debe: 363, saldoDeudor: 363 });
  });

  it('a mitad de año los saldos iniciales suman cero y no se cuenta dos veces lo anterior a la apertura', () => {
    const mov = movimientosDelPeriodo(libro(), p({ desde: '2026-02-15', hasta: '2026-12-31' }));
    expect(mov.saldosIniciales.get('430')).toBe(242);
    expect(mov.saldosIniciales.get('400')).toBe(-50);
    const total = [...mov.saldosIniciales.values()].reduce((s, v) => s + v, 0);
    expect(Math.abs(total)).toBeLessThan(0.005);
  });

  it('agrupa por 3 digitos', () => {
    const libroSub = [asiento('2026-01-05', [['4300000001', 10, 0], ['4300000002', 5, 0], ['7000000000', 0, 15]])];
    const r = calcularSumasYSaldos(movimientosDelPeriodo(libroSub, p({ ejercicio: 2026 })), 3, nombre);
    expect(r.filas.map((f) => [f.cuenta, f.debe, f.haber])).toEqual([
      ['430', 15, 0],
      ['700', 0, 15],
    ]);
  });

  it('sin apertura, lo de gastos e ingresos de años anteriores va a la 129', () => {
    const sinCierre = [
      asiento('2025-05-01', [['572', 100, 0], ['700', 0, 100]]),
      asiento('2026-01-10', [['572', 10, 0], ['700', 0, 10]]),
    ];
    const mov = movimientosDelPeriodo(sinCierre, p({ ejercicio: 2026 }));
    expect(mov.saldosIniciales.get('700')).toBeUndefined();
    expect(mov.saldosIniciales.get('129')).toBe(-100);
    expect(mov.saldosIniciales.get('572')).toBe(100);
  });
});

describe('libro mayor', () => {
  it('ordena por fecha del asiento y lleva el saldo acumulado', () => {
    const datos = libro();
    // Se graba despues un asiento con fecha anterior: tiene que salir en su sitio.
    datos.push(asiento('2025-01-20', [['430', 10, 0], ['700', 0, 10]]));
    const [c430] = calcularMayor(movimientosDelPeriodo(datos, p({ ejercicio: 2025 })), { cuenta: '430' }, nombre);
    expect(c430.movimientos.map((m) => [m.fecha, m.saldo])).toEqual([
      ['2025-01-10', 121],
      ['2025-01-20', 131],
      ['2025-02-01', 10],
      ['2025-03-01', 252],
    ]);
    expect(c430).toMatchObject({ saldoInicial: 0, totalDebe: 373, totalHaber: 121, saldoFinal: 252, nombre: 'Clientes' });
  });

  it('parte del saldo inicial cuando el periodo empieza a mitad de año', () => {
    const [c572] = calcularMayor(movimientosDelPeriodo(libro(), p({ desde: '2026-02-01', hasta: '2026-12-31' })), { cuenta: '572' }, nombre);
    expect(c572.saldoInicial).toBe(121);
    expect(c572.movimientos).toHaveLength(1);
    expect(c572.saldoFinal).toBe(363);
  });

  it('rango de cuentas', () => {
    expect(cuentaEnFiltro('4300000001', { desde: '400', hasta: '430' })).toBe(true);
    expect(cuentaEnFiltro('4770000000', { desde: '400', hasta: '430' })).toBe(false);
    expect(cuentaEnFiltro('3990000000', { desde: '400', hasta: '430' })).toBe(false);
    const cuentas = calcularMayor(movimientosDelPeriodo(libro(), p({ ejercicio: 2026 })), { desde: '400', hasta: '477' }, nombre);
    expect(cuentas.map((c) => c.cuenta)).toEqual(['400', '430', '477']);
  });
});

describe('libro diario', () => {
  it('sin regularizacion ni cierre salvo que se pidan, y debe = haber', () => {
    const sin = calcularDiario(movimientosDelPeriodo(libro(), p({ ejercicio: 2025 })).asientos, nombre);
    expect(sin.asientos).toHaveLength(3);
    const con = calcularDiario(movimientosDelPeriodo(libro(), p({ ejercicio: 2025 }), { incluirCierre: true }).asientos, nombre);
    expect(con.asientos.map((a) => a.tipo)).toEqual(['NORMAL', 'NORMAL', 'NORMAL', 'REGULARIZACION', 'CIERRE']);
    expect(con.totalDebe).toBe(con.totalHaber);
  });
});

describe('mayor de clientes y proveedores', () => {
  it('identifica al cliente por la factura enlazada, la referencia o el concepto', () => {
    const r = crearResolvedorTercero(ctxClientes);
    const [venta, cobro, , , , , , cobroB] = libro();
    expect(r.clave(venta, venta.lineas[0])).toBe('cliA');
    expect(r.clave(cobro, cobro.lineas[1])).toBe('cliA'); // "Cobro factura fA1"
    expect(r.clave(cobroB, cobroB.lineas[1])).toBe('cliB'); // referencia A-2
    expect(r.factura(cobroB, cobroB.lineas[1])).toBe('A-2');
    const suelto = asiento('2026-05-01', [['4300000007', 0, 30], ['572', 30, 0]]);
    expect(r.clave(suelto, suelto.lineas[0])).toBe('subcuenta:4300000007');
    const generico = asiento('2026-05-01', [['430', 0, 30], ['572', 30, 0]]);
    expect(r.clave(generico, generico.lineas[0])).toBe(SIN_IDENTIFICAR);
  });

  it('saldos por cliente en un ejercicio y arrastre al siguiente sin depender de la apertura', () => {
    const e2025 = calcularMayorTerceros(libro(), p({ ejercicio: 2025 }), ctxClientes, nombre);
    expect(e2025.map((t) => [t.nombre, t.saldoInicial, t.debe, t.haber, t.saldoFinal])).toEqual([
      ['Alfa SL', 0, 121, 121, 0],
      ['Beta SA', 0, 242, 0, 242],
    ]);
    const e2026 = calcularMayorTerceros(libro(), p({ ejercicio: 2026 }), ctxClientes, nombre);
    // La apertura (430 en una linea) no crea un "sin identificar": se usa la historia.
    expect(e2026.map((t) => [t.id, t.saldoInicial, t.haber, t.saldoFinal])).toEqual([['cliB', 242, 242, 0]]);
    expect(e2026[0].movimientos[0]).toMatchObject({ fecha: '2026-03-01', factura: 'A-2', saldo: 0 });
  });

  it('proveedores: saldo acreedor en positivo', () => {
    const ctx: ContextoTerceros = { tipo: 'proveedores', facturas: [{ id: 'fP7', numero: 'P-7', terceroId: 'prS' }], fichas: [{ id: 'prS', nombre: 'Suministros SL', nif: null }] };
    const [s] = calcularMayorTerceros(libro(), p({ ejercicio: 2026 }), ctx, nombre);
    expect(s).toMatchObject({ id: 'prS', haber: 50, saldoFinal: 50, cuentas: ['400'] });
  });

  it('se respeta la apertura de una empresa sin historia anterior', () => {
    const inicio = [
      asiento('2026-01-01', [['4300000001', 500, 0], ['129', 0, 500]], { tipo: 'APERTURA' }),
      asiento('2026-02-01', [['572', 200, 0], ['4300000001', 0, 200]]),
    ];
    expect(asientosParaTerceros(inicio, '2026-12-31')).toHaveLength(2);
    const [t] = calcularMayorTerceros(inicio, p({ desde: '2026-01-15', hasta: '2026-12-31' }), { ...ctxClientes, facturas: [] }, nombre);
    expect(t).toMatchObject({ id: 'subcuenta:4300000001', saldoInicial: 500, haber: 200, saldoFinal: 300 });
  });
});

describe('descarga en PDF y Excel', () => {
  const tabla: TablaInforme = {
    titulo: 'Libro mayor',
    periodo: 'Ejercicio 2026',
    empresa: { nombre: 'Empresa Ñandú SL', nif: 'B12345678' },
    apaisado: true,
    columnas: [
      { titulo: 'Fecha', tipo: 'fecha', ancho: 1.7 },
      { titulo: 'Concepto', tipo: 'texto', ancho: 6 },
      { titulo: 'Debe', tipo: 'importe', ancho: 2 },
      { titulo: 'Haber', tipo: 'importe', ancho: 2 },
    ],
    filas: [
      { celdas: ['572', 'Bancos', null, null], estilo: 'seccion' },
      { celdas: ['2026-03-01', 'Cobro de una factura con un concepto larguísimo que no cabe en la columna del informe', 1234.5, 0] },
      { celdas: [null, 'Total', 1234.5, 0], estilo: 'total' },
    ],
    notas: ['Nota de prueba.'],
    fichero: 'libro mayor 572 ñ',
  };

  it('el Excel guarda los importes como numeros y las fechas como fechas', () => {
    const wb = XLSX.read(tablaAXlsx(tabla), { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    expect(ws['A1'].v).toContain('Empresa Ñandú SL');
    expect(ws['C5'].v).toBe('Debe');
    expect(ws['C7']).toMatchObject({ t: 'n', v: 1234.5 });
    expect(ws['A7'].t === 'n' || ws['A7'].t === 'd').toBe(true);
    expect(ws['!autofilter']).toBeDefined();
  });

  it('genera un PDF/A', async () => {
    const pdf = await tablaAPdf(tabla);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(5000);
  });

  it('nombre de fichero sin tildes ni espacios', () => {
    expect(nombreFichero('Mayor de clientes 2026', 'pdf')).toBe('Mayor_de_clientes_2026.pdf');
    expect(nombreFichero(tabla.fichero, 'xlsx')).toBe('libro_mayor_572_n.xlsx');
  });
});
