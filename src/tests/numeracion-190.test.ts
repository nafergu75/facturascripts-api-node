/**
 * Numero identificativo del 190 (posiciones 108-120): lo genera la app, 190 +
 * ejercicio + contador, sin repetirse en la empresa y el ejercicio, y distinto
 * del de la declaracion anterior (123-135) de una complementaria o sustitutiva.
 */
import { describe, it, expect } from '@jest/globals';
import { conservarNumeracion190, firmaRegistros, numeracionDeDatos, siguienteNumero190, type Numeracion190 } from '../services/nominas/numeracion190';

const vacia: Numeracion190 = { emitidos: [] };
const emitido = (numero: string, tipo: 'N' | 'C' | 'S' = 'N', anterior: string | null = null, firma = 'f1') => ({ numero, tipo, anterior, firma, emitidoEn: '2026-01-20T10:00:00.000Z' });

describe('siguienteNumero190', () => {
  it('el primero: 190 + ejercicio + 000001 (13 cifras)', () => {
    expect(siguienteNumero190(2025, vacia, { tipo: 'N', anterior: null, firma: 'f1', presentado: false })).toEqual({ numero: '1902025000001', nuevo: true });
  });

  it('la misma declaracion sin presentar reutiliza su numero; otra seleccion o ya presentada, numero nuevo', () => {
    const n: Numeracion190 = { emitidos: [emitido('1902025000001')] };
    expect(siguienteNumero190(2025, n, { tipo: 'N', anterior: null, firma: 'f1', presentado: false })).toEqual({ numero: '1902025000001', nuevo: false });
    expect(siguienteNumero190(2025, n, { tipo: 'N', anterior: null, firma: 'f2', presentado: false })).toEqual({ numero: '1902025000002', nuevo: true });
    expect(siguienteNumero190(2025, n, { tipo: 'N', anterior: null, firma: 'f1', presentado: true })).toEqual({ numero: '1902025000002', nuevo: true });
  });

  it('nunca repite uno ya usado ni el de la declaracion anterior', () => {
    const n: Numeracion190 = { emitidos: [emitido('1902025000001'), emitido('1902025000003', 'C', '1902025000001')] };
    // El siguiente al mayor del ejercicio (el 4), y salta el de la anterior si coincide.
    expect(siguienteNumero190(2025, n, { tipo: 'S', anterior: '1902025000004', firma: 'f9', presentado: true })).toEqual({ numero: '1902025000005', nuevo: true });
    const r = siguienteNumero190(2025, n, { tipo: 'C', anterior: '1902025000001', firma: 'f2', presentado: false });
    expect(r.numero).not.toBe('1902025000001');
    expect(r).toEqual({ numero: '1902025000004', nuevo: true });
  });

  it('cada ejercicio tiene su contador', () => {
    const n: Numeracion190 = { emitidos: [emitido('1902025000007')] };
    expect(siguienteNumero190(2026, n, { tipo: 'N', anterior: null, firma: 'f1', presentado: false }).numero).toBe('1902026000001');
  });
});

describe('numeracion guardada en los datos del 190', () => {
  it('se lee del JSON y se conserva al reescribirlo (recalcular el 190)', () => {
    const previos = { totales: { registros: 3 }, numeracion190: { emitidos: [emitido('1902025000001')] } };
    expect(numeracionDeDatos(previos).emitidos).toHaveLength(1);
    expect(numeracionDeDatos(null)).toEqual({ emitidos: [] });
    expect(numeracionDeDatos({ numeracion190: { emitidos: [{ numero: 'basura' }] } })).toEqual({ emitidos: [] });
    expect(conservarNumeracion190(previos, { totales: { registros: 4 } })).toEqual({ totales: { registros: 4 }, numeracion190: previos.numeracion190 });
    expect(conservarNumeracion190({}, { totales: 1 })).toEqual({ totales: 1 });
  });

  it('la huella no depende del orden de los registros', () => {
    expect(firmaRegistros(['b', 'a'])).toBe(firmaRegistros(['a', 'b']));
    expect(firmaRegistros(['a'])).not.toBe(firmaRegistros(['a', 'b']));
  });
});
