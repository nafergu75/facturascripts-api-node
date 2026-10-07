/**
 * Contabilidad con divisas y tipo de operacion (puro, sin BD):
 *  - asiento del cobro en divisa con sus cuentas (572/570, 430, 626, 668, 768);
 *  - guarda del tipo de cambio y nota de divisa del asiento de la factura;
 *  - libro de emitidas repartido por tipo para la pantalla del 303;
 *  - resumen.csv del archivo con la moneda del documento;
 *  - cuentas del motor (todas las ventas a la 700; 768 en el plan base).
 */
import { calcularCobroDivisa, motivoSinTipoFijado, notaDivisa } from '../domain/divisas';
import { apuntesDeCobro } from '../services/cobrosPagos.service';
import { CONTABLE_RULES } from '../services/accounting-engine.service';
import { PGC_BASE } from '../domain/pgc-model';
import { repartoLibroEmitidas } from '../services/tax-documents.service';
import { resumenCsv, type ElementoTrimestre } from '../services/archivoFacturas.service';
import { TIPOS_OPERACION_VENTA } from '../domain/tipo-operacion.model';

const CUENTAS = {
  tesoreria: { cuenta: '5720001', nombre: 'Banco' },
  tercero: { cuenta: '430', nombre: 'Clientes · ACME' },
};
const porCuenta = (apuntes: Array<{ cuenta: string; debe: number; haber: number }>) =>
  Object.fromEntries(apuntes.map((a) => [a.cuenta, [a.debe, a.haber]]));

/** Factura de 1.000 USD a 1,10 (909,09 €), sin cobros. */
const FACTURA = { tipo: 'INGRESO' as const, moneda: 'USD', monedaCuenta: 'EUR', monedaTesoreria: 'EUR', totalCuenta: 909.09, totalDoc: 1000, cobradoCuenta: 0, cobradoDoc: 0 };

describe('asiento del cobro en divisa', () => {
  it('cobro total a 1,05: 572 D 952,38 / 430 H 909,09 / 768 H 43,29', () => {
    const c = calcularCobroDivisa({ ...FACTURA, importeDoc: 1000, tipoCambio: 1.05, fuenteTipoCambio: 'MANUAL' });
    expect(porCuenta(apuntesDeCobro(c.apuntes, CUENTAS))).toEqual({
      '5720001': [952.38, 0],
      '430': [0, 909.09],
      '768': [0, 43.29],
    });
  });

  it('cobros parciales: el segundo a peor tipo va a la 668 y la 430 queda saldada', () => {
    const c1 = calcularCobroDivisa({ ...FACTURA, importeDoc: 400, tipoCambio: 1.05, fuenteTipoCambio: 'MANUAL' });
    expect(porCuenta(apuntesDeCobro(c1.apuntes, CUENTAS))).toEqual({ '5720001': [380.95, 0], '430': [0, 363.64], '768': [0, 17.31] });
    const c2 = calcularCobroDivisa({
      ...FACTURA,
      cobradoCuenta: c1.importe,
      cobradoDoc: c1.importeDoc,
      importeDoc: 600,
      tipoCambio: 1.12,
      fuenteTipoCambio: 'MANUAL',
    });
    expect(porCuenta(apuntesDeCobro(c2.apuntes, CUENTAS))).toEqual({ '5720001': [535.71, 0], '668': [9.74, 0], '430': [0, 545.45] });
    expect(Math.round((c1.importe + c2.importe) * 100) / 100).toBe(909.09);
  });

  it('con lo recibido en el banco y comision: 572 945,00 / 626 7,38 / 430 909,09 / 768 43,29', () => {
    const c = calcularCobroDivisa({ ...FACTURA, importeDoc: 1000, importeRecibido: 945, comisionBancaria: 7.38 });
    expect(porCuenta(apuntesDeCobro(c.apuntes, CUENTAS))).toEqual({
      '5720001': [945, 0],
      '626': [7.38, 0],
      '430': [0, 909.09],
      '768': [0, 43.29],
    });
    expect(c.fuenteTipoCambio).toBe('BANCO');
  });

  it('en euros salen los dos apuntes de siempre', () => {
    const c = calcularCobroDivisa({ ...FACTURA, moneda: 'EUR', totalCuenta: 1210, totalDoc: 1210, importeDoc: 500 });
    expect(apuntesDeCobro(c.apuntes, CUENTAS)).toEqual([
      { cuenta: '5720001', nombre: 'Banco', debe: 500, haber: 0 },
      { cuenta: '430', nombre: 'Clientes · ACME', debe: 0, haber: 500 },
    ]);
  });
});

describe('asiento de la factura en divisa', () => {
  const usd = {
    moneda: 'USD',
    tipoCambio: 1.149,
    fuenteTipoCambio: 'BCE',
    fechaTipoCambio: '2026-09-21',
    baseTotal: 1148.81 - 191.47,
    ivaTotal: 191.47,
    retencionTotal: 0,
    totalFactura: 1148.81,
    baseTotalDoc: 1099.99,
    ivaTotalDoc: 220,
    retencionTotalDoc: 0,
    totalFacturaDoc: 1319.99,
  };

  it('sin tipo fijado (PENDIENTE, sin importes en dolares o tipo 0) no se contabiliza', () => {
    expect(motivoSinTipoFijado(usd, 'EUR')).toBeNull();
    expect(motivoSinTipoFijado({ ...usd, fuenteTipoCambio: 'PENDIENTE' }, 'EUR')).toBe('Factura en USD sin tipo de cambio: no se contabiliza.');
    expect(motivoSinTipoFijado({ ...usd, totalFacturaDoc: null }, 'EUR')).toMatch(/sin tipo de cambio/);
    expect(motivoSinTipoFijado({ ...usd, tipoCambio: 0 }, 'EUR')).toMatch(/sin tipo de cambio/);
    // En la moneda de cuenta (y las facturas anteriores, sin *Doc) siempre se contabiliza.
    expect(motivoSinTipoFijado({ moneda: 'EUR', baseTotal: 100, ivaTotal: 21, retencionTotal: 0, totalFactura: 121 }, 'EUR')).toBeNull();
    // Una empresa en USD con factura en USD va a la par.
    expect(motivoSinTipoFijado({ ...usd, fuenteTipoCambio: 'PAR', tipoCambio: 1 }, 'USD')).toBeNull();
  });

  it('nota de la descripcion: importe en la moneda de la factura y tipo; vacia en euros', () => {
    expect(notaDivisa(usd, 'EUR')).toBe(' (1.319,99 USD; 1 EUR = 1,1490 USD, BCE 21/09/2026)');
    expect(notaDivisa({ ...usd, fuenteTipoCambio: 'MANUAL' }, 'EUR')).toBe(' (1.319,99 USD; 1 EUR = 1,1490 USD, tipo indicado a mano)');
    expect(notaDivisa({ moneda: 'EUR', baseTotal: 100, ivaTotal: 21, retencionTotal: 0, totalFactura: 121 }, 'EUR')).toBe('');
  });
});

describe('cuentas del motor contable', () => {
  it('todas las ventas a la 700, sea cual sea el tipo de operacion', () => {
    for (const tipo of TIPOS_OPERACION_VENTA) {
      const regla = (CONTABLE_RULES as Record<string, { ingreso?: string }>)[`VENTA_${tipo}`];
      expect(regla?.ingreso).toBe('700');
    }
  });

  it('diferencias de cambio (768/668) y comision (626), en el plan base', () => {
    expect(CONTABLE_RULES.DIFERENCIAS_CAMBIO).toEqual({ positiva: '768', negativa: '668' });
    expect(CONTABLE_RULES.COMISION_BANCARIA.cuenta).toBe('626');
    const nombres = new Map(PGC_BASE.map((n) => [n.code, n.name]));
    expect(nombres.get('768')).toBe('Diferencias positivas de cambio');
    expect(nombres.get('668')).toBe('Diferencias negativas de cambio');
    expect(nombres.get('626')).toBe('Servicios bancarios y similares');
  });
});

describe('libro de emitidas para la pantalla del 303', () => {
  it('las filas sin tipo y las NACIONAL devengan; las demas van a [59], [60], [120] o [122]', () => {
    const r = repartoLibroEmitidas([
      { baseImponible: 100, nifTercero: 'B1' }, // anterior: como siempre
      { baseImponible: 50, tipoOperacion: null, nifTercero: 'B1' }, // anterior al 0 %: tambien, como siempre
      { baseImponible: 1000, tipoOperacion: 'NACIONAL', nifTercero: 'B2' },
      { baseImponible: 2000, tipoOperacion: 'INTRACOMUNITARIA', causaExencion: 'E5', nifTercero: 'FR12345678901' },
      { baseImponible: 300, tipoOperacion: 'SERVICIOS_EXTRANJERO', nifTercero: 'DE123456789' },
      { baseImponible: 400, tipoOperacion: 'SERVICIOS_EXTRANJERO', nifTercero: '12-3456789' },
      { baseImponible: 9000, tipoOperacion: 'EXPORTACION', causaExencion: 'E2', nifTercero: '12-3456789' },
      { baseImponible: 60, tipoOperacion: 'EXENTA', causaExencion: 'E3', nifTercero: 'B3' },
      { baseImponible: 70, tipoOperacion: 'EXENTA', causaExencion: 'E1', nifTercero: 'B3' },
      { baseImponible: 800, tipoOperacion: 'ISP_NACIONAL', nifTercero: 'B4' },
    ]);
    expect(r.baseDevengada).toBe(1150);
    expect(r.informativas).toEqual({ '59': 2300, '60': 9060, '120': 400, '122': 800 });
  });
});

describe('resumen.csv del archivo con divisas', () => {
  const fila = (extra: Partial<ElementoTrimestre>): ElementoTrimestre & { tipo: 'Venta' | 'Gasto'; archivo: string } => ({
    tipo: 'Venta',
    facturaId: 'f1',
    numero: 'A-1',
    fecha: '2026-09-21',
    tercero: 'ACME',
    nif: 'B1',
    base: 870.32,
    iva: 182.77,
    total: 1053.09,
    documentoId: null,
    archivoNombre: null,
    tieneArchivo: false,
    descargable: true,
    origen: 'emitida',
    archivo: 'ventas/a.pdf',
    ...extra,
  });

  it('en euros, las 9 columnas de siempre', () => {
    const csv = resumenCsv([fila({ moneda: 'EUR', totalDivisa: null, tipoCambio: null })]).toString('utf8').replace(/^﻿/, '');
    expect(csv.split('\r\n')[0]).toBe('Tipo;Fecha;Número;Tercero;NIF;Base;IVA;Total;Archivo');
  });

  it('con alguna factura en divisa, Moneda, Total divisa y Tipo de cambio AL FINAL', () => {
    const csv = resumenCsv([
      fila({ moneda: 'USD', totalDivisa: 1210, tipoCambio: 1.149 }),
      fila({ numero: 'A-2', base: 100, iva: 21, total: 121, moneda: 'EUR', totalDivisa: null, tipoCambio: null }),
    ])
      .toString('utf8')
      .replace(/^﻿/, '')
      .trim()
      .split('\r\n');
    expect(csv[0]).toBe('Tipo;Fecha;Número;Tercero;NIF;Base;IVA;Total;Archivo;Moneda;Total divisa;Tipo de cambio');
    expect(csv[1]).toBe('Venta;2026-09-21;A-1;ACME;B1;870,32;182,77;1053,09;ventas/a.pdf;USD;1210,00;1,149');
    expect(csv[2]).toBe('Venta;2026-09-21;A-2;ACME;B1;100,00;21,00;121,00;ventas/a.pdf;EUR;;');
  });
});
