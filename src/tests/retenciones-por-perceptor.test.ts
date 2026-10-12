/**
 * Retención de los abonos por perceptor (decisión P1 con la revisión de
 * integracion-4), sin BD: un abono solo resta de lo retenido a su mismo
 * perceptor en el año hasta su trimestre; lo que no cabe, y el abono de una
 * factura de un año anterior, pasa a exceso.
 */
import { describe, it, expect } from '@jest/globals';
import { retencionesPorPerceptor } from '../domain/rectificativa-gasto.model';

describe('retencionesPorPerceptor', () => {
  it('las facturas cuentan enteras y el abono resta de su perceptor', () => {
    const r = retencionesPorPerceptor([
      { clave: 'X', fecha: '2027-02-01', base: 100000, retencion: 15000 },
      { clave: 'X', fecha: '2027-05-10', base: -100000, retencion: -15000 },
    ]);
    expect(r).toEqual([
      { base: 100000, retencion: 15000, exceso: 0, excesoBase: 0 },
      { base: -100000, retencion: -15000, exceso: 0, excesoBase: 0 },
    ]);
  });

  it('nunca resta de otro perceptor: lo que no cabe en el suyo es exceso', () => {
    const r = retencionesPorPerceptor([
      { clave: 'Y', fecha: '2027-02-10', base: 200000, retencion: 30000 },
      { clave: 'X', fecha: '2027-02-20', base: -100000, retencion: -15000 },
    ]);
    expect(r[1]).toEqual({ base: 0, retencion: 0, exceso: 15000, excesoBase: 100000 });
  });

  it('solo cuenta lo retenido hasta el trimestre del abono, y lo que ya restaron sus abonos anteriores', () => {
    const r = retencionesPorPerceptor([
      { clave: 'X', fecha: '2027-01-15', base: 40000, retencion: 6000 },
      { clave: 'X', fecha: '2027-02-15', base: -30000, retencion: -4500 },
      { clave: 'X', fecha: '2027-03-20', base: -30000, retencion: -4500 },
      // Posterior al trimestre de los abonos: no les sirve.
      { clave: 'X', fecha: '2027-04-02', base: 100000, retencion: 15000 },
    ]);
    expect(r[1]).toEqual({ base: -30000, retencion: -4500, exceso: 0, excesoBase: 0 });
    expect(r[2]).toEqual({ base: -10000, retencion: -1500, exceso: 3000, excesoBase: 20000 });
    expect(r[3]).toEqual({ base: 100000, retencion: 15000, exceso: 0, excesoBase: 0 });
  });

  it('una factura posterior del mismo trimestre sí le sirve', () => {
    const r = retencionesPorPerceptor([
      { clave: 'X', fecha: '2027-04-05', base: -10000, retencion: -1500 },
      { clave: 'X', fecha: '2027-06-28', base: 50000, retencion: 7500 },
    ]);
    expect(r[0]).toEqual({ base: -10000, retencion: -1500, exceso: 0, excesoBase: 0 });
  });

  it('el abono de una factura de un año anterior no cuenta: todo es exceso', () => {
    const r = retencionesPorPerceptor([
      { clave: 'X', fecha: '2027-01-15', base: 100000, retencion: 15000 },
      { clave: 'X', fecha: '2027-02-15', base: -50000, retencion: -7500, deAnioAnterior: true },
    ]);
    expect(r[1]).toEqual({ base: 0, retencion: 0, exceso: 7500, excesoBase: 50000 });
  });
});
