/**
 * Calculos de «Traer la contabilidad de 2026» y comprobaciones de A4: tipo de
 * sumas y saldos, lineas de la apertura, masas, signos raros; diario frente al
 * sumas y saldos; cuadre de la cartera con «Saldo sin detalle» (D3); y los
 * tres niveles del mensaje final, con los ficheros complementarios que no
 * cuadran fuera de la carga (D2). Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import { cuadrarCartera, DOCUMENTO_SIN_DETALLE } from '../services/arranque/cartera';
import { comprobarCarga, type EntradaComprobaciones } from '../services/arranque/comprobaciones';
import type { PartidaLeida } from '../services/arranque/extractores';
import { analizarDiario, origenHistorico, saldosDesdeDiario } from '../services/arranque/historico';
import { analizarSaldos, saldosDeLineas } from '../services/arranque/saldos';
import type { ApunteLeido, CuentaSaldo } from '../services/puestaEnMarcha/lectorContable';
import { CARTERA_A, DIARIO_A, SALDOS_A, SALDOS_B, type AsientoPrueba } from './fixtures/arranque/generar';

const cuentasA: CuentaSaldo[] = SALDOS_A.map((s) => ({ codigo: s.codigo, nombre: s.nombre, saldo: s.saldo }));
const apuntesDe = (diario: AsientoPrueba[]): ApunteLeido[] =>
  diario.flatMap((a) => a.lineas.map(([cuenta, debe, haber], i) => ({ fila: i, fecha: a.fecha, asiento: String(a.numero), cuenta, nombre: '', concepto: a.concepto, debe, haber })));
const partidasA = (): PartidaLeida[] => CARTERA_A.map((p, i) => ({ fila: i + 3, subcuenta: p.subcuenta, nif: p.nif, nombre: p.nombre, documento: p.documento, fecha: p.fecha, vencimiento: p.vencimiento, importeOriginal: p.importe, pendiente: p.pendiente, moneda: 'EUR' }));

describe('sumas y saldos', () => {
  it('empresa A sin regularizar: resultado a la 129, masas y una línea por subcuenta', () => {
    const a = analizarSaldos(cuentasA);
    expect(a.tipo).toBe('SIN_REGULARIZAR');
    expect(a.totales.cuadra).toBe(true);
    expect(a.resultadoPyg).toBe(7200);
    expect(a.resultado).toBe(7200);
    expect(a.cuenta129).toBe('1290000000');
    expect(a.lineas.find((l) => l.cuenta === '1290000000')).toEqual({ cuenta: '1290000000', debe: 0, haber: 7200 });
    expect(a.lineas.some((l) => /^[67]/.test(l.cuenta))).toBe(false);
    expect(a.lineas.some((l) => l.cuenta === '4300000003')).toBe(false);
    expect(a.masas).toEqual({ activo: 40430, patrimonioNeto: 33200, pasivo: 7230 });
    expect(a.heredados.map((h) => h.codigo)).toEqual(['4750000000']);
    expect(a.ivaSinLiquidar).toEqual([]);
    expect(a.anomalias).toEqual([]);
    const debe = a.lineas.reduce((s, l) => s + l.debe, 0);
    const haber = a.lineas.reduce((s, l) => s + l.haber, 0);
    expect(Math.round(debe * 100)).toBe(Math.round(haber * 100));
  });

  it('empresa B regularizada: el resultado ya está en la 129', () => {
    const b = analizarSaldos(SALDOS_B);
    expect(b.tipo).toBe('REGULARIZADO');
    expect(b.saldo129).toBe(3000);
    expect(b.resultado).toBe(3000);
  });

  it('con cierre (todo a cero), signos raros e IVA sin liquidar', () => {
    expect(analizarSaldos(cuentasA.map((c) => ({ ...c, saldo: 0 }))).tipo).toBe('CON_CIERRE');
    const raro = analizarSaldos([
      { codigo: '5720000001', nombre: 'Banco', saldo: -100 },
      { codigo: '4300000001', nombre: 'Cliente', saldo: -50 },
      { codigo: '4720000000', nombre: 'IVA soportado', saldo: 30 },
      { codigo: '1000000000', nombre: 'Capital', saldo: 120 },
    ]);
    expect(raro.anomalias.map((x) => x.codigo)).toEqual(['5720000001', '4300000001', '1000000000']);
    expect(raro.ivaSinLiquidar.map((x) => x.codigo)).toEqual(['4720000000']);
  });
});

describe('diario de 2026', () => {
  const sys = { cuentas: cuentasA, tipo: 'SIN_REGULARIZAR' as const, fechaCorte: '2026-12-31' };

  it('cuadra con el sumas y saldos y marca la apertura como histórica', () => {
    const d = analizarDiario(apuntesDe(DIARIO_A), 2026, sys);
    expect(d.resumen).toMatchObject({ asientos: 11, desde: '2026-01-01', hasta: '2026-12-31' });
    expect(d.especiales.apertura).toBe(1);
    expect(d.descuadrados).toEqual([]);
    expect(d.comparacion).toEqual({ cuadra: true, diferencias: [] });
    expect(origenHistorico(d.asientos[0])).toBe('HISTORICO_APERTURA');
    expect(origenHistorico(d.asientos[1])).toBe('HISTORICO');
  });

  it('un diario incompleto no coincide con el sumas y saldos, subcuenta a subcuenta', () => {
    const d = analizarDiario(apuntesDe(DIARIO_A.filter((a) => a.numero !== 7)), 2026, sys);
    expect(d.comparacion?.diferencias.map((x) => x.codigo)).toEqual(['4300000001', '5720000001']);
  });

  it('asiento descuadrado, apuntes de otros años y saldos desde el diario', () => {
    const malo = DIARIO_A.map((a) => (a.numero === 3 ? { ...a, lineas: [['4300000002', 6050, 0], ['7000000000', 0, 5000], ['4770000000', 0, 1000]] as Array<[string, number, number]> } : a));
    const otro: AsientoPrueba = { numero: 99, fecha: '2025-12-31', concepto: 'De 2025', lineas: [['5720000001', 1, 0], ['7000000000', 0, 1]] };
    const d = analizarDiario(apuntesDe([...malo, otro]), 2026, null);
    expect(d.descuadrados.map((x) => x.clave)).toEqual(['3']);
    expect(d.deOtrosAnios).toBe(2);
    expect(d.comparacion).toBeNull();
    const saldos = saldosDesdeDiario(analizarDiario(apuntesDe(DIARIO_A), 2026, null).asientos);
    expect(saldos.find((c) => c.codigo === '4300000001')?.saldo).toBe(6050);
  });
});

describe('cartera', () => {
  const saldos = saldosDeLineas(analizarSaldos(cuentasA).lineas);

  it('cuadra con el saldo de cada subcuenta', () => {
    const r = cuadrarCartera(partidasA(), saldos, () => null);
    expect(r.partidas).toHaveLength(5);
    expect(r.partidas.filter((p) => p.tipo === 'COBRO')).toHaveLength(2);
    expect(r.cuadre.every((c) => c.diferencia === 0)).toBe(true);
    expect(r.sinDetalle).toEqual([]);
    expect(r.cuadre.find((c) => c.subcuenta === '4000000001')).toMatchObject({ tipo: 'PAGO', saldoApertura: 2420, sumaPartidas: 2420 });
  });

  it('la diferencia queda como «Saldo sin detalle» y una subcuenta con saldo sin partidas también', () => {
    const partidas = partidasA()
      .filter((p) => p.subcuenta !== '4100000001')
      .map((p) => (p.subcuenta === '4300000002' ? { ...p, pendiente: 6000 } : p));
    const r = cuadrarCartera(partidas, saldos, () => null);
    expect(r.sinDetalle.map((p) => [p.subcuenta, p.tipo, p.pendiente, p.documento])).toEqual([
      ['4100000001', 'PAGO', 605, DOCUMENTO_SIN_DETALLE],
      ['4300000002', 'COBRO', 50, DOCUMENTO_SIN_DETALLE],
    ]);
  });

  it('una partida sin subcuenta se busca por NIF; si no se encuentra, error', () => {
    const [alfa] = partidasA();
    const sinSub = { ...alfa, subcuenta: undefined };
    expect(cuadrarCartera([sinSub], saldos, (p) => (p.nif === alfa.nif ? '4300000001' : null)).partidas[0].subcuenta).toBe('4300000001');
    expect(cuadrarCartera([sinSub], saldos, () => null).sinTercero).toEqual([{ fila: 3, documento: 'A-2026-001', nombre: 'Cliente Alfa SL', nif: alfa.nif }]);
  });
});

describe('comprobaciones (A4)', () => {
  const sAnalisis = analizarSaldos(cuentasA);
  const base = (): EntradaComprobaciones => ({
    ejercicioOrigen: 2026,
    tipoCarga: 'PROVISIONAL',
    presentes: new Set(['PLAN', 'SUMAS_Y_SALDOS', 'TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES', 'CARTERA', 'DIARIO', 'INMOVILIZADO']),
    hojasConError: [],
    repetidos: [],
    sumasSaldos: { analisis: sAnalisis, fechaCorte: '2026-12-31' },
    saldosDesdeDiario: false,
    pyg: null,
    resultadoDeclarado: 7200,
    diario: analizarDiario(apuntesDe(DIARIO_A), 2026, { cuentas: cuentasA, tipo: 'SIN_REGULARIZAR', fechaCorte: '2026-12-31' }),
    tercerosSinNifEnPlan: 0,
    sinMadreConSaldo: [],
    longitudesIncoherentes: [],
    longitud: { delPlan: 10, motivo: null },
    tercerosConSaldoSinFicha: [],
    cartera: cuadrarCartera(partidasA(), saldosDeLineas(sAnalisis.lineas), () => null),
    inmovilizado: { diferencias: [] },
    retirados: {},
  });

  it('todo correcto', () => {
    const r = comprobarCarga(base());
    expect(r.puntos.filter((p) => p.nivel !== 'INFO')).toEqual([]);
    expect(r.nivel).toBe('CORRECTO');
    expect(r.mensaje).toBe('La contabilidad de 2026 está completa y cuadra. Ya puedes seguir con 2027.');
  });

  it('faltan datos: ficheros que no están y el resultado sin escribir', () => {
    const e = base();
    e.presentes = new Set(['PLAN', 'TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES']);
    e.sumasSaldos = null;
    e.diario = null;
    e.cartera = null;
    e.resultadoDeclarado = null;
    const r = comprobarCarga(e);
    expect(r.nivel).toBe('FALTAN_DATOS');
    expect(r.puntos.filter((p) => p.nivel === 'FALTA').map((p) => p.clave)).toEqual(['falta:SUMAS_Y_SALDOS', 'falta:CARTERA', 'falta:DIARIO']);
    expect(r.mensaje).toMatch(/^Puedes seguir, pero faltan datos: Falta el sumas y saldos/);
  });

  it('los listados no hacen falta si el plan trae el NIF de todos', () => {
    const e = base();
    e.presentes.delete('TERCEROS_CLIENTES');
    e.presentes.delete('TERCEROS_PROVEEDORES');
    expect(comprobarCarga(e).nivel).toBe('CORRECTO');
    e.tercerosSinNifEnPlan = 2;
    expect(comprobarCarga(e).puntos.map((p) => p.clave)).toEqual(expect.arrayContaining(['falta:TERCEROS_CLIENTES', 'falta:TERCEROS_PROVEEDORES']));
  });

  it('D2: un diario que no cuadra con el sumas y saldos se deja fuera y la carga sigue', () => {
    const e = base();
    e.diario = analizarDiario(apuntesDe(DIARIO_A.filter((a) => a.numero !== 7)), 2026, { cuentas: cuentasA, tipo: 'SIN_REGULARIZAR', fechaCorte: '2026-12-31' });
    const r = comprobarCarga(e);
    expect(r.nivel).toBe('FALTAN_DATOS');
    expect(r.excluidos).toEqual(['DIARIO']);
    expect(r.puntos.find((p) => p.clave === 'diario:sumas-saldos')?.texto).toMatch(/no se importará/);
  });

  it('D2: sin sumas y saldos, un diario descuadrado sí es error (de él sale la apertura)', () => {
    const e = base();
    e.sumasSaldos = null;
    e.saldosDesdeDiario = true;
    e.diario = { ...e.diario!, descuadrados: [{ clave: '3', fecha: '2026-02-20', debe: 6050, haber: 6000, diferencia: 50 }], comparacion: null };
    expect(comprobarCarga(e).nivel).toBe('ERRORES');
  });

  it('D3: cartera que no cuadra = faltan datos', () => {
    const e = base();
    e.cartera = cuadrarCartera(partidasA().map((p) => (p.subcuenta === '4300000002' ? { ...p, pendiente: 6000 } : p)), saldosDeLineas(sAnalisis.lineas), () => null);
    const r = comprobarCarga(e);
    expect(r.nivel).toBe('FALTAN_DATOS');
    expect(r.puntos.find((p) => p.clave === 'cartera:cuadre')?.detalle).toEqual(['4300000002: saldo 6.050,00 €, facturas 6.000,00 €, diferencia 50,00 €']);
  });

  it('errores: sumas y saldos con cierre, descuadrado, de otro año, cuentas fuera del PGC y partidas sin tercero', () => {
    const conCierre = base();
    conCierre.sumasSaldos = { analisis: analizarSaldos(cuentasA.map((c) => ({ ...c, saldo: 0 }))), fechaCorte: '2026-12-31' };
    conCierre.diario = null;
    expect(comprobarCarga(conCierre).puntos[0]).toMatchObject({ clave: 'sys:cierre', nivel: 'ERROR' });

    const descuadrado = base();
    descuadrado.sumasSaldos = { analisis: analizarSaldos([...cuentasA, { codigo: '5720000009', nombre: 'Otro', saldo: 10 }]), fechaCorte: '2026-12-31' };
    descuadrado.diario = null;
    const r = comprobarCarga(descuadrado);
    expect(r.nivel).toBe('ERRORES');
    expect(r.mensaje).toMatch(/^Todavía no se puede traer la contabilidad: El sumas y saldos no cuadra/);

    const otroAnio = base();
    otroAnio.sumasSaldos = { analisis: sAnalisis, fechaCorte: '2025-12-31' };
    expect(comprobarCarga(otroAnio).puntos.find((p) => p.clave === 'sys:corte')?.nivel).toBe('ERROR');

    const noviembre = base();
    noviembre.sumasSaldos = { analisis: sAnalisis, fechaCorte: '2026-11-30' };
    expect(comprobarCarga(noviembre).puntos.find((p) => p.clave === 'sys:corte')?.nivel).toBe('AVISO');
    noviembre.tipoCarga = 'DEFINITIVA';
    expect(comprobarCarga(noviembre).puntos.find((p) => p.clave === 'sys:corte')?.nivel).toBe('ERROR');

    const otros = base();
    otros.sinMadreConSaldo = ['1390000000'];
    otros.longitudesIncoherentes = ['43000002'];
    otros.cartera = { ...otros.cartera!, sinTercero: [{ fila: 4, documento: 'X-1' }] };
    expect(comprobarCarga(otros).puntos.filter((p) => p.nivel === 'ERROR').map((p) => p.clave)).toEqual(['plan:sin-madre', 'plan:longitud', 'cartera:sin-tercero']);
  });

  it('resultado: frente a la PyG (error) y frente al que escribe la persona (aviso)', () => {
    const e = base();
    e.pyg = { resultado: 7000, cifraNegocios: null, totalActivo: null, totalPnPasivo: null };
    expect(comprobarCarga(e).puntos.find((p) => p.clave === 'sys:resultado-pyg')?.nivel).toBe('ERROR');
    const d = base();
    d.resultadoDeclarado = 7100;
    const r = comprobarCarga(d);
    expect(r.puntos.find((p) => p.clave === 'resultado-declarado')?.nivel).toBe('AVISO');
    expect(r.nivel).toBe('CORRECTO');
  });

  it('regularizado sin PyG: falta la PyG para el comparativo', () => {
    const e = base();
    e.sumasSaldos = { analisis: analizarSaldos(SALDOS_B), fechaCorte: '2026-12-31' };
    e.diario = null;
    e.presentes.delete('DIARIO');
    e.cartera = null;
    e.resultadoDeclarado = 3000;
    const r = comprobarCarga(e);
    expect(r.puntos.map((p) => p.clave)).toContain('falta:PYG');
  });
});
