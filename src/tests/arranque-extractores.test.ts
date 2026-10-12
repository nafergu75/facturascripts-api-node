/**
 * Extraccion de datos de cada hoja de «Traer la contabilidad de 2026»: plan,
 * listados, sumas y saldos (con los saldos cero), diario, cartera,
 * inmovilizado y PyG oficial, con los formatos de cada programa. Sin base de
 * datos.
 */
import { describe, it, expect } from '@jest/globals';
import { clasificarHoja } from '../services/arranque/clasificador';
import { extraerHoja, type Extraccion } from '../services/arranque/extractores';
import { leerLibro } from '../services/arranque/lectorLibros';
import { leerBalanceDeFilas } from '../services/puestaEnMarcha/lectorContable';
import {
  a3SumasSaldos,
  CARTERA_A,
  contaplusDiario,
  contaplusSubcuentas,
  contasolSumasSaldos,
  DIARIO_A,
  ficherosEmpresaA,
  ficherosEmpresaB,
  holdedSumasSaldos,
  libro,
  mayorPorCuenta,
  NIF,
  planSinTitulos,
  SALDOS_A,
  sageSumasSaldos,
  sumasSaldosConCierre,
  type FicheroPrueba,
} from './fixtures/arranque/generar';

function extraer<T extends Extraccion["tipo"]>(f: FicheroPrueba, longitud: number | null = null): Extraccion & { tipo: T } {
  const l = leerLibro(f.contenido, f.nombre);
  const h = l.hojas[0];
  const c = clasificarHoja({ fichero: f.nombre, hoja: h.hoja, filas: h.filas, formato: l.formato });
  const r = extraerHoja(c.tipo, h.filas, { cabecera: c.cabecera, longitud, formato: l.formato });
  expect(r.error).toBeNull();
  return r.extraccion as Extraccion & { tipo: T };
}

const saldoDe = (cuentas: Array<{ codigo: string; saldo: number }>, codigo: string) => cuentas.find((c) => c.codigo === codigo)?.saldo;
const saldosA = new Map(SALDOS_A.map((s) => [s.codigo, s.saldo]));

describe('extracción: empresa A', () => {
  const a = ficherosEmpresaA();

  it('plan con NIF', () => {
    const e = extraer<'PLAN'>(a.plan);
    expect(e.cuentas.find((c) => c.codigo === '4300000001')).toEqual({ codigo: '4300000001', nombre: 'Cliente Alfa SL', nif: NIF.alfa });
    expect(e.cuentas.map((c) => c.codigo)).toContain('100');
  });

  it('listados de clientes y proveedores con sus datos de contacto', () => {
    const c = extraer<'TERCEROS_CLIENTES'>(a.clientes);
    expect(c.terceros).toHaveLength(3);
    expect(c.terceros[0]).toEqual({
      tipo: 'cliente',
      subcuenta: '4300000001',
      nif: NIF.alfa,
      nombre: 'Cliente Alfa SL',
      ficha: { direccion: 'Calle Mayor 1', cp: '46001', municipio: 'Valencia', provincia: 'Valencia', telefono: '960000001', email: 'alfa@ejemplo.es' },
    });
    const p = extraer<'TERCEROS_PROVEEDORES'>(a.proveedores);
    expect(p.terceros.map((t) => [t.subcuenta, t.tipo])).toEqual([
      ['4000000001', 'proveedor'],
      ['4000000002', 'proveedor'],
      ['4100000001', 'proveedor'],
    ]);
    expect(p.terceros[2].ficha?.direccion).toBe('Calle Ñandú 9');
  });

  it('sumas y saldos: todos los saldos, también los de cero', () => {
    const e = extraer<'SUMAS_Y_SALDOS'>(a.sumasSaldos);
    expect(e.lectura.cuentas).toHaveLength(SALDOS_A.length);
    expect(saldoDe(e.lectura.cuentas, '4300000003')).toBe(0);
    for (const c of e.lectura.cuentas) expect(c.saldo).toBe(saldosA.get(c.codigo));
  });

  it('diario completo', () => {
    const e = extraer<'DIARIO'>(a.diario);
    expect(e.lectura.apuntes).toHaveLength(DIARIO_A.reduce((s, x) => s + x.lineas.length, 0));
    expect(e.lectura.apuntes[0]).toMatchObject({ fecha: '2026-01-01', asiento: '1', cuenta: '5720000001', debe: 18000 });
  });

  it('cartera: subcuenta, factura, fechas, importe y pendiente', () => {
    const e = extraer<'CARTERA'>(a.cartera);
    expect(e.partidas).toHaveLength(CARTERA_A.length);
    expect(e.partidas[0]).toMatchObject({
      subcuenta: '4300000001',
      nif: NIF.alfa,
      documento: 'A-2026-001',
      fecha: '2026-02-15',
      vencimiento: '2026-03-15',
      importeOriginal: 12100,
      pendiente: 6050,
      moneda: 'EUR',
      tipoTercero: 'cliente',
    });
    expect(e.partidas[2].tipoTercero).toBe('proveedor');
  });

  it('inmovilizado', () => {
    const e = extraer<'INMOVILIZADO'>(a.inmovilizado);
    expect(e.activos).toEqual([
      expect.objectContaining({ descripcion: 'Torno CNC', cuentaBien: '2130000000', cuentaAmortAcum: '2813000000', fechaAlta: '2024-01-01', coste: 10000, amortAcumulada: 3000, coeficiente: 10 }),
      expect.objectContaining({ descripcion: 'Mesas y sillas', coste: 3000, amortAcumulada: 300 }),
    ]);
  });
});

describe('extracción: empresa B y formatos de cada programa', () => {
  it('PyG oficial: resultado del ejercicio y cifra de negocios', () => {
    const e = extraer<'PYG'>(ficherosEmpresaB().pyg);
    expect(e.totales).toMatchObject({ resultado: 3000, cifraNegocios: 8000 });
  });

  it('a3ECO por niveles: solo las subcuentas, sin los grupos', () => {
    const e = extraer<'SUMAS_Y_SALDOS'>(a3SumasSaldos());
    expect(e.lectura.cuentas.every((c) => c.codigo.length === 10)).toBe(true);
    expect(saldoDe(e.lectura.cuentas, '5720000001')).toBe(saldosA.get('5720000001'));
  });

  it('Sage 50, Holded (punto decimal) y Contasol («430.1» con la longitud del plan)', () => {
    for (const f of [sageSumasSaldos(), holdedSumasSaldos()]) {
      const e = extraer<'SUMAS_Y_SALDOS'>(f);
      expect(saldoDe(e.lectura.cuentas, '4300000001')).toBe(6050);
      expect(saldoDe(e.lectura.cuentas, '4000000001')).toBe(-2420);
    }
    const l = leerLibro(contasolSumasSaldos().contenido, 'contasol_sys.xlsx');
    const h = l.hojas[0];
    const c = clasificarHoja({ fichero: 'contasol_sys.xlsx', hoja: h.hoja, filas: h.filas });
    const r = extraerHoja(c.tipo, h.filas, { cabecera: c.cabecera, longitud: 10 });
    expect(r.codigosExpandidos).toBe(SALDOS_A.length);
    expect(r.avisos.join(' ')).toMatch(/punto de relleno/);
    const cuentas = (r.extraccion as Extract<Extraccion, { tipo: 'SUMAS_Y_SALDOS' }>).lectura.cuentas;
    expect(saldoDe(cuentas, '4300000001')).toBe(6050);
    expect(saldoDe(cuentas, '1000000000')).toBe(-20000);
  });

  it('ContaPlus: plan desde SUBCTA.DBF y diario en euros (no en pesetas)', () => {
    const p = extraer<'PLAN'>(contaplusSubcuentas());
    expect(p.cuentas.find((c) => c.codigo === '4300000001')).toMatchObject({ nif: NIF.alfa, ficha: { direccion: 'Calle Mayor 1', cp: '46001' } });
    const d = extraer<'DIARIO'>(contaplusDiario());
    expect(d.lectura.apuntes[0]).toMatchObject({ fecha: '2026-01-01', cuenta: '5720000001', debe: 18000 });
  });

  it('mayor por cuenta y plan sin títulos', () => {
    const m = extraer<'DIARIO'>(mayorPorCuenta());
    expect(m.lectura.mayorPorCuenta).toBe(true);
    expect(m.lectura.apuntes.find((x) => x.cuenta === '4300000001')).toBeDefined();
    const p = extraer<'PLAN'>(planSinTitulos());
    expect(p.cuentas.find((c) => c.codigo === '4300000002')?.nombre).toBe('Cliente Beta SA');
  });

  it('sumas y saldos con cierre: todo a cero, pero se lee (para avisar)', () => {
    const e = extraer<'SUMAS_Y_SALDOS'>(sumasSaldosConCierre());
    expect(e.lectura.cuentas.length).toBeGreaterThan(10);
    expect(e.lectura.cuentas.every((c) => c.saldo === 0)).toBe(true);
  });
});

describe('extracción: columnas que no se pueden deducir', () => {
  it('si faltan columnas obligatorias, pide el mapeo con las columnas de la hoja', () => {
    const filas = [['Código raro', 'Texto', 'Cifra'], ['4300000001', 'Alfa', '10'], ['5720000001', 'Banco', '-10']];
    const r = extraerHoja('SUMAS_Y_SALDOS', filas, { cabecera: { fila: 0, titulos: ['codigo raro', 'texto', 'cifra'], campos: { nombre: 1 } } });
    expect(r.error).toMatchObject({ necesitaMapeo: true, faltan: ['cuenta', 'saldo'] });
    expect(r.error!.columnas.map((c) => c.titulo)).toEqual(['Código raro', 'Texto', 'Cifra']);
    // Con el mapeo a mano, se lee.
    const ok = extraerHoja('SUMAS_Y_SALDOS', filas, { cabecera: null, mapeo: { cuenta: 0, nombre: 1, saldo: 2 }, filaCabecera: 1 });
    expect(ok.error).toBeNull();
    expect((ok.extraccion as Extract<Extraccion, { tipo: 'SUMAS_Y_SALDOS' }>).lectura.cuentas.map((c) => [c.codigo, c.saldo])).toEqual([
      ['4300000001', 10],
      ['5720000001', -10],
    ]);
  });

  it('sumas y saldos sin títulos: columnas deducidas por el contenido', () => {
    const f = { nombre: 'saldos.xlsx', contenido: libro([['Hoja1', [['4300000001', 'Alfa', 10, 0], ['5720000001', 'Banco', 0, 10]]]]) };
    const l = leerLibro(f.contenido, f.nombre);
    const r = extraerHoja('SUMAS_Y_SALDOS', l.hojas[0].filas, { cabecera: null });
    expect(r.error).toBeNull();
    expect((r.extraccion as Extract<Extraccion, { tipo: 'SUMAS_Y_SALDOS' }>).lectura.cuentas.map((c) => c.saldo)).toEqual([10, -10]);
  });

  it('hoja sin tipo: error que pide elegir el tipo', () => {
    expect(extraerHoja('DESCONOCIDO', [['x']], { cabecera: null }).error).toMatchObject({ necesitaMapeo: false });
  });

  it('el lector de saldos de la puesta en marcha sigue quitando los ceros por defecto', () => {
    const filas = [['Cuenta', 'Saldo'], ['4300000001', 0], ['5720000001', 5], ['1000000000', -5]];
    expect(leerBalanceDeFilas(filas).cuentas.map((c) => c.codigo)).toEqual(['1000000000', '5720000001']);
    expect(leerBalanceDeFilas(filas, { conservarCeros: true }).cuentas.map((c) => c.codigo)).toEqual(['1000000000', '4300000001', '5720000001']);
  });
});
