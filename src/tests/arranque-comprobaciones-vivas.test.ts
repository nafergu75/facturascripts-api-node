/**
 * Comprobaciones «vivas» de A4 (las que se completan fuera de los ficheros):
 * bancos con su extracto, 303 del 4T y cuotas a compensar, datos de la
 * empresa, series de 2027, ejercicio, fichas de terceros; y como se juntan con
 * las de los ficheros y con los avisos aceptados. Sin base de datos.
 */
import { describe, it, expect } from '@jest/globals';
import { comprobarVivas, juntarComprobaciones, nivelDe, type EntradaVivas, type PuntoComprobacion } from '../services/arranque/comprobaciones';

const base: EntradaVivas = { ejercicioOrigen: 2026, bancos: null, iva: null, empresaFaltan: [], series: { faltan: [], usadasAntes: [] }, ejercicioCreado: null };
const claves = (ps: PuntoComprobacion[]) => ps.map((p) => `${p.nivel}:${p.clave}`);

describe('comprobaciones vivas', () => {
  it('todo escrito y cuadrado: sin puntos', () => {
    const p = comprobarVivas({
      ...base,
      bancos: [{ subcuenta: '5720000001', nombre: 'Sabadell', saldoApertura: 18630, saldoExtracto: 18630, cuenta: 'ES91...', aceptada: false }],
      iva: { saldo4750: 1785, saldo4700: 0, resultado303: 1785, cuotasACompensar: null },
      ejercicioCreado: true,
    });
    expect(p).toEqual([]);
  });

  it('bancos: sin extracto, sin cuenta de Tesorería y con diferencia; aceptada pasa a información', () => {
    const p = comprobarVivas({
      ...base,
      bancos: [
        { subcuenta: '5720000001', nombre: 'Sabadell', saldoApertura: 100, saldoExtracto: null, cuenta: null, aceptada: false },
        { subcuenta: '5720000002', nombre: 'Santander', saldoApertura: 100, saldoExtracto: 90, cuenta: 'ES', aceptada: false },
        { subcuenta: '5720000003', nombre: 'BBVA', saldoApertura: 100, saldoExtracto: 95, cuenta: 'ES', aceptada: true },
      ],
    });
    expect(claves(p)).toEqual(['FALTA:bancos:extracto', 'FALTA:bancos:cuenta', 'FALTA:bancos:diferencia', 'INFO:bancos:transito']);
    expect(p[2].detalle).toEqual(['5720000002 Santander: contabilidad 100,00 €, extracto 90,00 €, diferencia 10,00 €']);
  });

  it('303 del 4T: sin escribir, que no cuadra con la 4750 o la 4700, y negativo sin cuotas a compensar', () => {
    expect(claves(comprobarVivas({ ...base, iva: { saldo4750: 1785, saldo4700: 0, resultado303: null, cuotasACompensar: null } }))).toEqual(['FALTA:iva:303-4t']);
    const mal = comprobarVivas({ ...base, iva: { saldo4750: 1785, saldo4700: 0, resultado303: 1700, cuotasACompensar: null } });
    expect(mal[0].texto).toMatch(/la 4750 \(IVA a ingresar\) tiene 1\.785,00 €/);
    expect(claves(comprobarVivas({ ...base, iva: { saldo4750: 0, saldo4700: 300, resultado303: -300, cuotasACompensar: null } }))).toEqual(['FALTA:iva:compensar']);
    expect(comprobarVivas({ ...base, iva: { saldo4750: 0, saldo4700: 300, resultado303: -300, cuotasACompensar: 300 } })).toEqual([]);
    expect(claves(comprobarVivas({ ...base, iva: { saldo4750: 0, saldo4700: 0, resultado303: 50, cuotasACompensar: null } }))).toEqual(['FALTA:iva:303-4t']);
  });

  it('empresa, series, ejercicio y fichas de terceros', () => {
    const p = comprobarVivas({
      ...base,
      empresaFaltan: ['teléfono', 'epígrafe del IAE'],
      series: { faltan: ['rectificativas'], usadasAntes: [] },
      ejercicioCreado: false,
      tercerosSinFicha: [{ codigo: '4300000009', nombre: 'Sin NIF SL' }],
    });
    expect(claves(p)).toEqual(['FALTA:empresa:datos', 'FALTA:series:2027', 'FALTA:ejercicio:2027', 'FALTA:terceros:sin-ficha']);
    expect(p[0].texto).toMatch(/teléfono, epígrafe del IAE/);
    expect(claves(comprobarVivas({ ...base, series: { faltan: [], usadasAntes: ['A'] } }))).toEqual(['INFO:series:anteriores']);
  });

  it('se juntan con las de los ficheros: las vivas sustituyen, lo aceptado pasa a información y el nivel se recalcula', () => {
    const ficheros: PuntoComprobacion[] = [
      { clave: 'falta:DIARIO', nivel: 'FALTA', texto: 'Falta el diario.' },
      { clave: 'bancos:extracto', nivel: 'FALTA', texto: 'Viejo.' },
    ];
    const vivos: PuntoComprobacion[] = [{ clave: 'empresa:datos', nivel: 'FALTA', texto: 'Faltan datos de la empresa.' }];
    const r = juntarComprobaciones({ puntos: ficheros, excluidos: [] }, vivos, 2026, [
      { clave: 'falta:DIARIO', motivo: 'No lo usamos', userId: 'u', en: '2027-01-10' },
      { clave: 'ya-no-existe', motivo: 'x', userId: 'u', en: '2027-01-10' },
    ]);
    expect(claves(r.puntos)).toEqual(['INFO:falta:DIARIO', 'FALTA:empresa:datos']);
    expect(r.puntos[0].texto).toBe('Falta el diario. (Aceptado: No lo usamos)');
    expect(r.nivel).toBe('FALTAN_DATOS');
    expect(r.aceptados.map((a) => a.clave)).toEqual(['falta:DIARIO']);
    expect(nivelDe([{ clave: 'x', nivel: 'ERROR', texto: 'Mal.' }], 2026)).toEqual({ nivel: 'ERRORES', mensaje: 'Todavía no se puede traer la contabilidad: Mal.' });
    expect(nivelDe([], 2026).mensaje).toBe('La contabilidad de 2026 está completa y cuadra. Ya puedes seguir con 2027.');
  });
});
