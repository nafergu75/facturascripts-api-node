/**
 * Reglas puras de los abonos y rectificativas de proveedor
 * (domain/rectificativa-gasto.model.ts): cuenta propuesta, sentido, donde va
 * el IVA (tabla 10.1 de la especificacion), plazos de un incremento, redondeo
 * espejo y reparto entre originales.
 */
import { describe, it, expect } from '@jest/globals';
import {
  CAUSAS_RECTIFICACION,
  conSigno,
  cuentaPropuesta,
  fechaIvaGasto,
  imputacionIva,
  limiteIncremento,
  r2Gasto,
  r2GastoConSigno,
  repartir,
  sentido,
  textoRectifica,
  type Causa,
} from '../domain/rectificativa-gasto.model';
import { calcularTotales } from '../services/expense-invoices.service';
import { totalesLineas } from '../schemas/factura-gasto.schemas';
import { aCentimos } from '../utils/money';

describe('cuentaPropuesta', () => {
  it('en una línea de compras (60) propone 608, 609 o 606 según la causa', () => {
    expect(cuentaPropuesta('DEVOLUCION', '600', false)).toBe('608');
    expect(cuentaPropuesta('ANULACION_PRECIO', '6000001', false)).toBe('608');
    expect(cuentaPropuesta('DESCUENTO', '600', false)).toBe('608');
    expect(cuentaPropuesta('DESCUENTO', '600', true)).toBe('609');
    expect(cuentaPropuesta('RAPPEL', '600', true)).toBe('609');
    expect(cuentaPropuesta('PRONTO_PAGO', '601', false)).toBe('606');
  });

  it('sin cuenta propia para la causa, o fuera del subgrupo 60, la de la original', () => {
    expect(cuentaPropuesta('ERROR_IVA', '600', false)).toBe('600');
    expect(cuentaPropuesta('ERROR_DERECHO', '600', false)).toBe('600');
    expect(cuentaPropuesta('DEVOLUCION', '217', false)).toBe('217');
    expect(cuentaPropuesta('DESCUENTO', '623', false)).toBe('623');
    expect(cuentaPropuesta('RAPPEL', null, true)).toBeNull();
  });
});

describe('sentido', () => {
  it('abono, cargo o mixta', () => {
    expect(sentido(-100, -21)).toBe('ABONO');
    expect(sentido(0, -11)).toBe('ABONO');
    expect(sentido(100, 21)).toBe('CARGO');
    expect(sentido(100, -10)).toBe('MIXTA');
  });
});

describe('imputacionIva: tabla 10.1', () => {
  const art80: Causa[] = ['DEVOLUCION', 'DESCUENTO', 'RAPPEL', 'PRONTO_PAGO', 'ANULACION_PRECIO', 'ERROR_DERECHO'];
  it.each(art80)('%s que reduce: periodo de recepción, [40]/[41], y si su 303 está presentado hay que rectificarlo', (causa) => {
    expect(imputacionIva({ causa, cuota: -21, fechaContable: '2027-02-12', fechaOriginalContable: '2026-11-30' })).toEqual({
      fecha: '2027-02-12',
      casillasRectificacion: true,
      requiereRectificar303: true,
    });
  });
  it.each(art80)('%s que aumenta: periodo de recepción, [40]/[41] en positivo', (causa) => {
    expect(imputacionIva({ causa, cuota: 21, fechaContable: '2027-02-12', fechaOriginalContable: '2026-11-30' })).toEqual({
      fecha: '2027-02-12',
      casillasRectificacion: true,
      requiereRectificar303: false,
    });
  });
  it('ERROR_IVA que reduce: periodo de la original, netea en [28]/[29]', () => {
    expect(imputacionIva({ causa: 'ERROR_IVA', cuota: -11, fechaContable: '2027-05-10', fechaOriginalContable: '2027-02-15' })).toEqual({
      fecha: '2027-02-15',
      casillasRectificacion: false,
      requiereRectificar303: true,
    });
  });
  it('ERROR_IVA que reduce sin original conocida: su propia fecha', () => {
    expect(imputacionIva({ causa: 'ERROR_IVA', cuota: -11, fechaContable: '2027-05-10', fechaOriginalContable: null }).fecha).toBe('2027-05-10');
  });
  it('ERROR_IVA que aumenta: recepción y [40]/[41]', () => {
    expect(imputacionIva({ causa: 'ERROR_IVA', cuota: 11, fechaContable: '2027-05-10', fechaOriginalContable: '2027-02-15' })).toEqual({
      fecha: '2027-05-10',
      casillasRectificacion: true,
      requiereRectificar303: false,
    });
  });
  it('la cuota manda en una mixta', () => {
    expect(imputacionIva({ causa: 'ERROR_IVA', cuota: -5, fechaContable: '2027-05-10', fechaOriginalContable: '2027-02-15' }).casillasRectificacion).toBe(false);
  });
});

describe('limiteIncremento', () => {
  it('art. 80: cuatro años desde la circunstancia (por defecto, la fecha de la rectificativa)', () => {
    expect(limiteIncremento({ causa: 'ANULACION_PRECIO', fechaDevengoOriginal: '2020-01-10', fechaEmision: '2027-03-01' })).toBe('2031-03-01');
    expect(limiteIncremento({ causa: 'ANULACION_PRECIO', fechaDevengoOriginal: '2020-01-10', fechaEmision: '2027-03-01', fechaCircunstancia: '2026-06-30' })).toBe('2030-06-30');
  });
  it('resto: el menor entre devengo + 4 años y expedición + 1 año', () => {
    expect(limiteIncremento({ causa: 'ERROR_IVA', fechaDevengoOriginal: '2023-05-20', fechaEmision: '2027-03-01' })).toBe('2027-05-20');
    expect(limiteIncremento({ causa: 'ERROR_IVA', fechaDevengoOriginal: '2026-05-20', fechaEmision: '2027-03-01' })).toBe('2028-03-01');
    expect(limiteIncremento({ causa: 'ERROR_IVA', fechaDevengoOriginal: null, fechaEmision: '2027-03-01' })).toBe('2028-03-01');
  });
  it('el 29 de febrero pasa al 28', () => {
    expect(limiteIncremento({ causa: 'ERROR_IVA', fechaDevengoOriginal: null, fechaEmision: '2028-02-29' })).toBe('2029-02-28');
  });
});

describe('redondeo espejo', () => {
  it('conSigno da el espejo exacto de la original', () => {
    expect(r2Gasto(10.125)).toBe(10.13);
    expect(conSigno(-1, 10.125)).toBe(-10.13);
    expect(r2GastoConSigno(-10.125)).toBe(-10.13);
    // El Math.round de siempre daria -10,12.
    expect(r2Gasto(-10.125)).toBe(-10.12);
    expect(conSigno(-1, 0)).toBe(0);
    expect(Object.is(conSigno(-1, 0), -0)).toBe(false);
  });

  it('1 × 1,005 €: la original da 1,00 y su abono espejo -1,00 (no -1,01 como con redondear2)', () => {
    const original = calcularTotales([{ descripcion: 'x', cantidad: 1, precioUnitario: 1.005, tipoIva: 21 }]);
    const abono = calcularTotales([{ descripcion: 'x', cantidad: 1, precioUnitario: -1.005, tipoIva: 21 }]);
    expect(original.baseTotal).toBe(1);
    expect(abono.baseTotal).toBe(-1);
    expect(abono.ivaTotal).toBe(-original.ivaTotal);
    expect(abono.totalFactura).toBe(-original.totalFactura);
  });

  it('calcularTotales y totalesLineas dan el espejo con -10,125 y descuento', () => {
    const l = { descripcion: 'x', cantidad: 3, precioUnitario: 3.375, descuentoPorcentaje: 10, tipoIva: 21, tipoRetencion: 15 };
    const pos = calcularTotales([l]);
    const neg = calcularTotales([{ ...l, precioUnitario: -3.375 }]);
    expect(neg.baseTotal).toBe(-pos.baseTotal);
    expect(neg.ivaTotal).toBe(-pos.ivaTotal);
    expect(neg.retencionTotal).toBe(-pos.retencionTotal);
    const tp = totalesLineas([l]);
    const tn = totalesLineas([{ ...l, precioUnitario: -3.375 }]);
    expect(tn).toEqual({ base: -tp.base, iva: -tp.iva, retencion: -tp.retencion, total: -tp.total });
    expect(tp.base).toBe(pos.baseTotal);
  });

  it('las facturas en positivo no cambian', () => {
    const t = calcularTotales([{ descripcion: 'x', cantidad: 1, precioUnitario: 10.125, tipoIva: 21 }]);
    expect(t.baseTotal).toBe(10.13);
    expect(t.ivaTotal).toBe(2.13);
  });
});

describe('fechaIvaGasto', () => {
  it('la de imputación si la hay; si no, la contable', () => {
    expect(fechaIvaGasto({ fechaEmision: '2027-01-02', fechaRegistro: '2027-01-05', fechaImputacionIva: '2026-11-30' })).toBe('2026-11-30');
    expect(fechaIvaGasto({ fechaEmision: '2027-01-02', fechaRegistro: '2027-01-05' })).toBe('2027-01-05');
    expect(fechaIvaGasto({ fechaEmision: '2027-01-02', fechaImputacionIva: null })).toBe('2027-01-02');
  });
});

describe('repartir', () => {
  it('suma exacto en céntimos y respeta la proporción', () => {
    const r = repartir(-100, [1, 1, 1]);
    expect(r.reduce((a, x) => a + aCentimos(x), 0)).toBe(-10000);
    expect(r).toEqual([-33.34, -33.33, -33.33]);
    expect(repartir(-121, [100, 0])).toEqual([-121, 0]);
    expect(repartir(50, [300, 100])).toEqual([37.5, 12.5]);
  });
  it('sin pesos útiles, a partes iguales', () => {
    expect(repartir(-10, [0, 0])).toEqual([-5, -5]);
  });
  it('cualquier reparto suma exacto', () => {
    for (const total of [-0.01, -1234.57, 999.99]) {
      const r = repartir(total, [3.33, 7.77, 0.01, 12]);
      expect(r.reduce((a, x) => a + aCentimos(x), 0)).toBe(aCentimos(total));
    }
  });
});

describe('textoRectifica', () => {
  it('nombra la original, el tipo y la causa', () => {
    expect(textoRectifica({ tipo: 'I', causa: 'DEVOLUCION', originales: [{ numero: 'F-2026/118', fecha: '2026-11-30' }] })).toBe(
      'Rectificativa (por diferencias) de F-2026/118 de 30/11/2026. Causa: devolución de mercancías o envases.',
    );
    expect(textoRectifica({ tipo: 'I', causa: 'RAPPEL', originales: [], periodo: { desde: '2027-01-01', hasta: '2027-03-31' } })).toContain(
      'de las compras del 01/01/2027 al 31/03/2027',
    );
  });
  it('hay siete causas', () => {
    expect(CAUSAS_RECTIFICACION).toHaveLength(7);
  });
});
