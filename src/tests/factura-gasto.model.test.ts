/**
 * Reglas puras de las facturas de gasto (domain/factura-gasto.model.ts):
 * donde cuenta cada factura en los modelos, el numero del proveedor, el
 * desglose de retenciones y los textos de estado.
 */
import { describe, it, expect } from '@jest/globals';
import {
  aparicionesFiscales,
  cabeceraTipos,
  desgloseRetencionGasto,
  esVencida,
  fechaContableGasto,
  importe347Gasto,
  normalizarNumeroProveedor,
  textoEstadoGasto,
  textoEstadoPago,
  tipoGastoDeCuenta,
  tipoRetencionLibro,
  whereGastosFiscales,
} from '../domain/factura-gasto.model';

describe('aparicionesFiscales', () => {
  const base = { fechaEmision: '2026-02-10', fechaRegistro: null, anuladaEn: null, anulacionAsientoId: null };

  it('un borrador del lector no cuenta', () => {
    expect(aparicionesFiscales({ ...base, estado: 'DRAFT' })).toEqual([]);
  });

  it('contabilizada: en su fecha de emision', () => {
    expect(aparicionesFiscales({ ...base, estado: 'ACCOUNTED' })).toEqual([{ fecha: '2026-02-10', signo: 1 }]);
  });

  it('con fecha de registro: en la de registro', () => {
    expect(aparicionesFiscales({ ...base, estado: 'ACCOUNTED', fechaRegistro: '2026-04-02' })).toEqual([{ fecha: '2026-04-02', signo: 1 }]);
  });

  it('anulada sin contraasiento: no cuenta', () => {
    expect(aparicionesFiscales({ ...base, estado: 'ANULADA', anuladaEn: '2026-02-20' })).toEqual([]);
  });

  it('anulada con contraasiento: suma en su periodo y resta en el de la anulacion', () => {
    expect(aparicionesFiscales({ ...base, estado: 'ANULADA', anuladaEn: '2026-04-05', anulacionAsientoId: 'a1' })).toEqual([
      { fecha: '2026-02-10', signo: 1 },
      { fecha: '2026-04-05', signo: -1 },
    ]);
  });

  it('las anteriores sin contabilizar siguen contando', () => {
    for (const estado of ['PENDING', 'OVERDUE', 'CONFIRMED']) {
      expect(aparicionesFiscales({ ...base, estado })).toEqual([{ fecha: '2026-02-10', signo: 1 }]);
    }
  });
});

describe('whereGastosFiscales', () => {
  it('vigentes por fecha contable y anuladas con contraasiento tambien por la de anulacion', () => {
    const w = whereGastosFiscales('E1', '2026-01-01', '2026-03-31') as { companyId: string; OR: unknown[] };
    expect(w.companyId).toBe('E1');
    expect(w.OR).toHaveLength(2);
    expect(JSON.stringify(w)).toContain('anuladaEn');
    expect(JSON.stringify(w)).toContain('"notIn":["DRAFT","ANULADA"]');
  });
});

describe('numero del proveedor', () => {
  it('se normaliza en mayusculas y sin espacios', () => {
    expect(normalizarNumeroProveedor(' f 2026/12 ')).toBe('F2026/12');
  });
});

describe('desgloseRetencionGasto', () => {
  it('lineas al 15 % y al 0 %: una fila con la base de las del 15 %', () => {
    const f = {
      baseTotal: 1500,
      retencionTotal: 150,
      tipoRetencion: 15,
      lineas: [
        { tipoRetencion: 15, baseLine: 1000, retencionImporte: 150 },
        { tipoRetencion: 0, baseLine: 500, retencionImporte: 0 },
      ],
    };
    expect(desgloseRetencionGasto(f)).toEqual([{ porcentaje: 15, base: 1000, cuota: 150 }]);
  });

  it('sin lineas: la cabecera (y el porcentaje deducido si falta)', () => {
    expect(desgloseRetencionGasto({ baseTotal: 1000, retencionTotal: 150, tipoRetencion: 0, lineas: [] })).toEqual([
      { porcentaje: 15, base: 1000, cuota: 150 },
    ]);
  });

  it('sin retencion: nada', () => {
    expect(desgloseRetencionGasto({ baseTotal: 1000, retencionTotal: 0, tipoRetencion: 0, lineas: [] })).toEqual([]);
  });
});

describe('cabecera de la factura', () => {
  it('IVA de la mayor base y retencion de la mayor base con retencion', () => {
    expect(
      cabeceraTipos([
        { tipoIva: 10, tipoRetencion: 0, baseLine: 800 },
        { tipoIva: 21, tipoRetencion: 15, baseLine: 300 },
      ]),
    ).toEqual({ tipoIva: 10, tipoRetencion: 15 });
    expect(cabeceraTipos([{ tipoIva: 21, tipoRetencion: 0, baseLine: 100 }])).toEqual({ tipoIva: 21, tipoRetencion: 0 });
  });
});

describe('textos y reglas', () => {
  it('estados de la factura en castellano', () => {
    expect(textoEstadoGasto('DRAFT')).toBe('Pendiente de revisar');
    expect(textoEstadoGasto('ACCOUNTED')).toBe('Contabilizada');
    expect(textoEstadoGasto('ANULADA')).toBe('Anulada');
    for (const e of ['PENDING', 'OVERDUE', 'CONFIRMED']) expect(textoEstadoGasto(e)).toBe('Sin contabilizar');
  });

  it('estados de pago en castellano', () => {
    expect(textoEstadoPago('PENDIENTE', false)).toBe('Pendiente de pago');
    expect(textoEstadoPago('PENDIENTE', true)).toBe('Vencida');
    expect(textoEstadoPago('PARCIAL', false)).toBe('Pagada en parte');
    expect(textoEstadoPago('PARCIAL', true)).toBe('Vencida');
    expect(textoEstadoPago('PAGADA', false)).toBe('Pagada');
  });

  it('vencida: sin pagar del todo, vencimiento pasado y no anulada', () => {
    const f = { estado: 'ACCOUNTED', estadoPago: 'PENDIENTE', fechaVencimiento: '2026-01-31' };
    expect(esVencida(f, '2026-02-01')).toBe(true);
    expect(esVencida(f, '2026-01-31')).toBe(false);
    expect(esVencida({ ...f, estadoPago: 'PAGADA' }, '2026-02-01')).toBe(false);
    expect(esVencida({ ...f, estado: 'ANULADA' }, '2026-02-01')).toBe(false);
  });

  it('fecha contable, libro de retenciones y tipo de gasto sugerido', () => {
    expect(fechaContableGasto({ fechaEmision: '2026-01-10' })).toBe('2026-01-10');
    expect(fechaContableGasto({ fechaEmision: '2026-01-10', fechaRegistro: '2026-04-01' })).toBe('2026-04-01');
    expect(tipoRetencionLibro('ALQUILER')).toBe('ARRENDAMIENTO');
    expect(tipoRetencionLibro('SERVICIO_PROFESIONAL')).toBe('PROFESIONAL');
    expect(tipoGastoDeCuenta('621')).toBe('ALQUILER');
    expect(tipoGastoDeCuenta('623')).toBe('SERVICIO_PROFESIONAL');
    expect(tipoGastoDeCuenta('600')).toBe('COMPRA');
    expect(tipoGastoDeCuenta('629')).toBe('SUMINISTROS');
    expect(tipoGastoDeCuenta(null)).toBe('SUMINISTROS');
  });
});

describe('importe347Gasto', () => {
  it('solo las lineas sin retencion de IRPF, con IVA', () => {
    const l = (tipoRetencion: number, baseLine: number, ivaImporte: number) => ({ tipoRetencion, baseLine, ivaImporte });
    expect(importe347Gasto({ baseTotal: 1200, ivaTotal: 252, retencionTotal: 150, lineas: [l(15, 1000, 210), l(0, 200, 42)] })).toBe(242);
    expect(importe347Gasto({ baseTotal: 1000, ivaTotal: 210, retencionTotal: 190, lineas: [l(19, 1000, 210)] })).toBe(0);
    expect(importe347Gasto({ baseTotal: 1000.1, ivaTotal: 210.02, retencionTotal: 0, lineas: [l(0, 1000.1, 210.02)] })).toBe(1210.12);
  });
  it('sin lineas: toda la factura o nada', () => {
    expect(importe347Gasto({ baseTotal: 1000, ivaTotal: 210, retencionTotal: 0 })).toBe(1210);
    expect(importe347Gasto({ baseTotal: 1000, ivaTotal: 210, retencionTotal: 150 })).toBe(0);
  });
});
