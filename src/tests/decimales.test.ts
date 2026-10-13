// Importes en Decimal: conversion a number al leer.
//
// Los importes pasaron de Float a DECIMAL(14,2): con Float, MySQL los guarda en
// binario (0,1 no es exacto) y SUM() arrastra error. Prisma devuelve Decimal;
// config/decimales.ts los convierte a number para que el codigo y el JSON sigan
// recibiendo numeros. Aqui se prueba la conversion; la extension completa
// necesita una BD MySQL y se valida al desplegar.
import { Prisma } from '@prisma/client';
import { aNumero, CAMPOS_DECIMALES, decimalesANumero } from '../config/decimales';

const D = (v: string) => new Prisma.Decimal(v);

describe('aNumero', () => {
  it('convierte Decimal y respeta lo demas', () => {
    expect(aNumero(D('1234.56'))).toBe(1234.56);
    expect(aNumero(null)).toBeNull();
    expect(aNumero(undefined)).toBeUndefined();
    expect(aNumero(7)).toBe(7);
  });

  it('el Decimal es exacto donde el Float no lo era', () => {
    expect(D('0.1').plus(D('0.2')).toNumber()).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3);
  });
});

describe('decimalesANumero', () => {
  it('convierte los campos migrados, tambien en relaciones anidadas', () => {
    const factura = {
      id: 'f1',
      baseTotal: D('100.00'),
      totalFactura: D('121.00'),
      fechaEmision: '2026-10-06',
      creada: new Date('2026-10-06T00:00:00Z'),
      notas: null,
      lineas: [{ baseLine: D('100.00'), ivaImporte: D('21.00'), precioUnitario: D('33.3333'), cantidad: 3 }],
    };
    const r = decimalesANumero(factura) as typeof factura & { lineas: Array<Record<string, unknown>> };
    expect(r.baseTotal).toBe(100);
    expect(r.totalFactura).toBe(121);
    expect(r.lineas[0]).toEqual({ baseLine: 100, ivaImporte: 21, precioUnitario: 33.3333, cantidad: 3 });
    expect(r.creada).toBeInstanceOf(Date);
    expect(r.notas).toBeNull();
  });

  it('convierte los agregados (_sum de aggregate y groupBy)', () => {
    expect(decimalesANumero({ _sum: { importe: D('10.50') }, _count: 2 })).toEqual({ _sum: { importe: 10.5 }, _count: 2 });
    expect(decimalesANumero([{ cuentaBancariaId: 'a', _sum: { importe: D('-3.20') } }])).toEqual([
      { cuentaBancariaId: 'a', _sum: { importe: -3.2 } },
    ]);
  });

  it('deja como Decimal los campos que no se migraron (su codigo usa .plus)', () => {
    const mov = decimalesANumero({ amount: D('50.00') }) as { amount: unknown };
    expect(mov.amount).toBeInstanceOf(Prisma.Decimal);
    expect(CAMPOS_DECIMALES.has('amount')).toBe(false);
    // DocumentoArchivo ya era Decimal con base/iva/retencion/total: tampoco se tocan.
    for (const campo of ['base', 'iva', 'retencion', 'total']) expect(CAMPOS_DECIMALES.has(campo)).toBe(false);
  });
});

describe('abonos de proveedor: importes de las tablas nuevas', () => {
  it('lo rectificado por cada original y lo compensado se leen como number', () => {
    const fila = decimalesANumero({
      baseRectificada: D('-100.00'),
      cuotaRectificada: D('-21.00'),
      retencionRectificada: D('-15.00'),
      compensaciones: [{ importe: D('121.00') }],
    });
    expect(fila).toEqual({ baseRectificada: -100, cuotaRectificada: -21, retencionRectificada: -15, compensaciones: [{ importe: 121 }] });
  });

  it('los nombres propios no tocan DocumentoArchivo: su retencion sigue llegando como Decimal', () => {
    const doc = decimalesANumero({ base: D('100.00'), retencion: D('15.00') }) as { base: unknown; retencion: unknown };
    expect(doc.retencion).toBeInstanceOf(Prisma.Decimal);
    expect((doc.retencion as Prisma.Decimal).toNumber()).toBe(15);
    expect(CAMPOS_DECIMALES.has('retencion')).toBe(false);
  });
});

describe('rectificativas de venta: la tabla de enlaces', () => {
  it('la parte de cada original (base, cuota y retencion) se lee como number, tambien anidada en la factura', () => {
    const factura = decimalesANumero({
      totalFactura: D('-181.50'),
      enlacesRectifica: [
        { originalId: 'a', baseRectificada: D('-100.00'), cuotaRectificada: D('-21.00'), retencionRectificada: D('0.00') },
        { originalId: null, numeroOriginal: 'A-2026-7', baseRectificada: D('-50.00'), cuotaRectificada: D('-10.50'), retencionRectificada: null },
      ],
    });
    expect(factura).toEqual({
      totalFactura: -181.5,
      enlacesRectifica: [
        { originalId: 'a', baseRectificada: -100, cuotaRectificada: -21, retencionRectificada: 0 },
        { originalId: null, numeroOriginal: 'A-2026-7', baseRectificada: -50, cuotaRectificada: -10.5, retencionRectificada: null },
      ],
    });
  });

  it('el tipo del cliente de Prisma ya los da como number (bloque result de importesComoNumero)', () => {
    type Fila = Awaited<ReturnType<typeof import('../config/database').prisma.incomeInvoiceRectificada.findFirstOrThrow>>;
    const comprobar = (f: Fila): Array<number | null> => [f.baseRectificada, f.cuotaRectificada, f.retencionRectificada];
    expect(comprobar({ baseRectificada: -1, cuotaRectificada: -0.21, retencionRectificada: null } as Fila)).toEqual([-1, -0.21, null]);
  });

  it('DocumentoArchivo sigue llegando como Decimal: los nombres propios no lo tocan', () => {
    const doc = decimalesANumero({ base: D('80.00'), iva: D('16.80'), retencion: D('12.00'), total: D('84.80') }) as Record<string, unknown>;
    for (const campo of ['base', 'iva', 'retencion', 'total']) expect(doc[campo]).toBeInstanceOf(Prisma.Decimal);
  });
});
