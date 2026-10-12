/**
 * Revision contable de «Traer la contabilidad de 2026» (sin base de datos):
 *  - Los asientos de apertura, regularizacion y cierre se reconocen por lo que
 *    contienen, no por el concepto: «Regularización de existencias» o
 *    «Comisión apertura póliza» son asientos normales.
 *  - Los grupos 8 y 9 no pasan a la apertura de 2027: su saldo va a su cuenta
 *    del subgrupo 13 (o error si no hay una segura), y la apertura cuadra
 *    tambien cuando sale del diario.
 */
import { describe, it, expect } from '@jest/globals';
import { comprobarCarga, type EntradaComprobaciones } from '../services/arranque/comprobaciones';
import { analizarDiario, origenHistorico, saldosDesdeDiario } from '../services/arranque/historico';
import { analizarSaldos, destinoGrupo89 } from '../services/arranque/saldos';
import { agruparAsientos, especialDe, type ApunteLeido, type CuentaSaldo } from '../services/puestaEnMarcha/lectorContable';
import { DIARIO_A, PLAN_A, sumasYSaldos, type AsientoPrueba } from './fixtures/arranque/generar';

const apuntesDe = (diario: AsientoPrueba[]): ApunteLeido[] =>
  diario.flatMap((a) => a.lineas.map(([cuenta, debe, haber], i) => ({ fila: i, fecha: a.fecha, asiento: String(a.numero), cuenta, nombre: '', concepto: a.concepto, debe, haber })));
const saldosDe = (diario: AsientoPrueba[]): CuentaSaldo[] => sumasYSaldos(diario, PLAN_A).map((s) => ({ codigo: s.codigo, nombre: s.nombre, saldo: s.saldo }));
const cuadra = (lineas: Array<{ debe: number; haber: number }>) =>
  Math.round(lineas.reduce((s, l) => s + l.debe, 0) * 100) === Math.round(lineas.reduce((s, l) => s + l.haber, 0) * 100);

/** El diario de la empresa A con dos asientos normales cuyo concepto confundia al lector. */
const CONFUSOS: AsientoPrueba[] = [
  { numero: 12, fecha: '2026-03-01', concepto: 'Comisión apertura póliza crédito', lineas: [['6260000000', 150, 0], ['5720000001', 0, 150]] },
  { numero: 13, fecha: '2026-12-31', concepto: 'Regularización de existencias finales', lineas: [['3000000000', 3000, 0], ['6100000000', 0, 3000]] },
];
const DIARIO_CONFUSO = [...DIARIO_A, ...CONFUSOS];

describe('asientos especiales por su contenido', () => {
  it('apertura, regularizacion y cierre de verdad', () => {
    const pos = { primero: false, ultimo: false };
    expect(especialDe({ fecha: '2026-01-01', lineas: [{ cuenta: '572' }, { cuenta: '100' }, { cuenta: '112' }], texto: 'asiento de apertura' }, pos)).toBe('APERTURA');
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '700' }, { cuenta: '600' }, { cuenta: '129' }], texto: 'regularizacion' }, pos)).toBe('REGULARIZACION');
    // Sin concepto tambien: los gastos e ingresos contra la 129.
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '700' }, { cuenta: '129' }], texto: '' }, pos)).toBe('REGULARIZACION');
    // Grupos 8 y 9 contra el subgrupo 13.
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '940' }, { cuenta: '130' }], texto: 'traspaso' }, pos)).toBe('REGULARIZACION');
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '572' }, { cuenta: '100' }, { cuenta: '129' }], texto: 'asiento de cierre' }, pos)).toBe('CIERRE');
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '572' }, { cuenta: '100' }, { cuenta: '129' }], texto: '' }, { primero: false, ultimo: true })).toBe('CIERRE');
  });

  it('asientos normales con esas palabras en el concepto', () => {
    const pos = { primero: false, ultimo: false };
    expect(especialDe({ fecha: '2026-03-01', lineas: [{ cuenta: '626' }, { cuenta: '572' }], texto: 'comision apertura poliza credito' }, pos)).toBeNull();
    expect(especialDe({ fecha: '2026-03-15', lineas: [{ cuenta: '572' }, { cuenta: '551' }], texto: 'apertura cuenta bancaria' }, pos)).toBeNull();
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '300' }, { cuenta: '610' }], texto: 'regularizacion de existencias finales' }, pos)).toBeNull();
    expect(especialDe({ fecha: '2026-06-30', lineas: [{ cuenta: '472' }, { cuenta: '477' }, { cuenta: '4750' }], texto: 'regularizacion iva' }, pos)).toBeNull();
    expect(especialDe({ fecha: '2026-11-30', lineas: [{ cuenta: '430' }, { cuenta: '650' }], texto: 'regularizacion saldo cliente' }, pos)).toBeNull();
    expect(especialDe({ fecha: '2026-12-31', lineas: [{ cuenta: '520' }, { cuenta: '572' }], texto: 'cierre poliza credito' }, pos)).toBeNull();
  });

  it('el diario de la empresa A con esos conceptos cuadra con el sumas y saldos sin regularizar', () => {
    const cuentas = saldosDe(DIARIO_CONFUSO);
    const d = analizarDiario(apuntesDe(DIARIO_CONFUSO), 2026, { cuentas, tipo: 'SIN_REGULARIZAR', fechaCorte: '2026-12-31' });
    expect(d.especiales).toEqual({ apertura: 1, regularizacion: 0, cierre: 0 });
    expect(d.comparacion).toEqual({ cuadra: true, diferencias: [] });
    const comision = d.asientos.find((a) => a.numeroOriginal === '12')!;
    expect(origenHistorico(comision)).toBe('HISTORICO');
    expect(origenHistorico(d.asientos.find((a) => a.numeroOriginal === '1')!)).toBe('HISTORICO_APERTURA');
  });

  it('solo con el diario: la apertura lleva las existencias y el resultado correcto', () => {
    const { asientos } = agruparAsientos(apuntesDe(DIARIO_CONFUSO));
    const a = analizarSaldos(saldosDesdeDiario(asientos));
    // 7.200 de la empresa A, menos 150 de comision, mas 3.000 de variacion de existencias.
    expect(a.resultado).toBe(10050);
    expect(a.lineas.find((l) => l.cuenta === '3000000000')).toEqual({ cuenta: '3000000000', debe: 3000, haber: 0 });
    expect(cuadra(a.lineas)).toBe(true);
  });
});

describe('grupos 8 y 9 en la apertura', () => {
  it('cada cuenta de 8 y 9 va a su cuenta del 13 (o a ninguna si no es segura)', () => {
    expect(destinoGrupo89('9400000000')).toBe('130');
    expect(destinoGrupo89('8400000000')).toBe('130');
    expect(destinoGrupo89('9410000')).toBe('131');
    expect(destinoGrupo89('9420000')).toBe('132');
    expect(destinoGrupo89('8000000')).toBe('133');
    expect(destinoGrupo89('8301000')).toBeNull();
  });

  /** Sumas y saldos sin regularizar con una subvencion de capital: 940 al haber y 840 al debe. */
  const CON_SUBVENCION: CuentaSaldo[] = [
    { codigo: '1000000000', nombre: 'Capital', saldo: -50000 },
    { codigo: '1300000000', nombre: 'Subvenciones oficiales de capital', saldo: -20000 },
    { codigo: '2110000000', nombre: 'Nave', saldo: 60000 },
    { codigo: '5720000001', nombre: 'Banco', saldo: 14000 },
    { codigo: '6290000000', nombre: 'Otros servicios', saldo: 1000 },
    { codigo: '7050000000', nombre: 'Servicios', saldo: -1000 },
    { codigo: '8400000000', nombre: 'Transferencia de subvenciones', saldo: 1000 },
    { codigo: '9400000000', nombre: 'Ingresos de subvenciones', saldo: -5000 },
  ];

  it('con el sumas y saldos: la 130 recoge el neto y no hay lineas de 8 ni de 9', () => {
    const a = analizarSaldos(CON_SUBVENCION);
    expect(a.lineas.some((l) => /^[89]/.test(l.cuenta))).toBe(false);
    expect(a.lineas.find((l) => l.cuenta === '1300000000')).toEqual({ cuenta: '1300000000', debe: 0, haber: 24000 });
    expect(a.grupos89.traspasos.map((t) => [t.codigo, t.a])).toEqual([
      ['8400000000', '1300000000'],
      ['9400000000', '1300000000'],
    ]);
    expect(a.totalesApertura.cuadra).toBe(true);
    expect(a.masas).toEqual({ activo: 74000, patrimonioNeto: 74000, pasivo: 0 });
  });

  it('solo con el diario: la contrapartida de las lineas de 8 y 9 no queda sola', () => {
    const diario: AsientoPrueba[] = [
      { numero: 1, fecha: '2026-01-01', concepto: 'Asiento de apertura', lineas: [['5720000001', 50000, 0], ['1000000000', 0, 50000]] },
      { numero: 2, fecha: '2026-02-01', concepto: 'Cobro subvención', lineas: [['5720000001', 5000, 0], ['9400000000', 0, 5000]] },
      { numero: 3, fecha: '2026-12-31', concepto: 'Imputación a resultados', lineas: [['8400000000', 1000, 0], ['7460000000', 0, 1000]] },
    ];
    const { asientos } = agruparAsientos(apuntesDe(diario));
    const a = analizarSaldos(saldosDesdeDiario(asientos));
    expect(a.totalesApertura).toEqual({ debe: 55000, haber: 55000, cuadra: true });
    expect(a.lineas.find((l) => l.cuenta === '1300000000')).toEqual({ cuenta: '1300000000', debe: 0, haber: 4000 });
    expect(a.lineas.find((l) => l.cuenta === '1290000000')).toEqual({ cuenta: '1290000000', debe: 0, haber: 1000 });
  });

  const entrada = (apertura: ReturnType<typeof analizarSaldos>): EntradaComprobaciones => ({
    ejercicioOrigen: 2026,
    tipoCarga: 'PROVISIONAL',
    presentes: new Set(['PLAN', 'SUMAS_Y_SALDOS', 'TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES', 'CARTERA', 'DIARIO']),
    hojasConError: [],
    repetidos: [],
    sumasSaldos: null,
    saldosDesdeDiario: true,
    apertura,
    pyg: null,
    resultadoDeclarado: null,
    diario: null,
    tercerosSinNifEnPlan: 0,
    sinMadreConSaldo: [],
    longitudesIncoherentes: [],
    longitud: { delPlan: 10, motivo: null },
    tercerosConSaldoSinFicha: [],
    cartera: null,
    inmovilizado: null,
    retirados: {},
  });

  it('una cuenta de 8 o 9 sin destino seguro es un error que impide confirmar', () => {
    const a = analizarSaldos([...CON_SUBVENCION, { codigo: '8301000000', nombre: 'Impuesto diferido', saldo: 500 }, { codigo: '5720000002', nombre: 'Banco 2', saldo: -500 }]);
    expect(a.grupos89.sinDestino.map((c) => c.codigo)).toEqual(['8301000000']);
    const r = comprobarCarga(entrada(a));
    expect(r.nivel).toBe('ERRORES');
    expect(r.puntos.find((p) => p.clave === 'apertura:grupos-89')?.nivel).toBe('ERROR');
  });

  it('una apertura que no cuadra es siempre un error (nunca falla a mitad de la importacion)', () => {
    const a = analizarSaldos([
      { codigo: '1000000000', nombre: 'Capital', saldo: -50000 },
      { codigo: '5720000001', nombre: 'Banco', saldo: 55000 },
    ]);
    expect(a.totalesApertura.cuadra).toBe(false);
    const r = comprobarCarga(entrada(a));
    expect(r.puntos.find((p) => p.clave === 'apertura:descuadre')?.nivel).toBe('ERROR');
    expect(r.nivel).toBe('ERRORES');
  });
});
