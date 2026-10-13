/**
 * Rectificativas de venta: reglas puras (domain/rectificativa-venta.model.ts).
 */
import { describe, it, expect } from '@jest/globals';
import {
  MOTIVOS_VENTA,
  MOTIVO_INFO,
  cuentaPorTipoIva,
  diferenciaSustitucion,
  exigeImputarAlPeriodoOriginal,
  limitePlazo,
  motivoDeTexto,
  repartoCuadra,
  subeCuotaAConsumidorFinal,
  textoRectificaVenta,
  tipoFacturaDe,
} from '../domain/rectificativa-venta.model';
import { calcularImportesFactura } from '../domain/importesFactura';

describe('motivo y tipo de VERI*FACTU (lista L2)', () => {
  it('cada motivo da su tipo; con ticket siempre R5', () => {
    const tabla = Object.fromEntries(MOTIVOS_VENTA.map((m) => [m, tipoFacturaDe(m, false)]));
    expect(tabla).toEqual({
      DEVOLUCION: 'R1',
      DESCUENTO: 'R1',
      RAPPEL: 'R1',
      CAMBIO_PRECIO: 'R1',
      ERROR_DERECHO: 'R1',
      ERROR: 'R4',
      OTROS: 'R4',
      CONCURSO: 'R2',
      IMPAGO: 'R3',
    });
    for (const m of MOTIVOS_VENTA) expect(tipoFacturaDe(m, true)).toBe('R5');
  });

  it('devolución, descuento, rappel, concurso e impago restan; solo descuento y rappel admiten un periodo', () => {
    expect(MOTIVOS_VENTA.filter((m) => MOTIVO_INFO[m].soloResta)).toEqual(['DEVOLUCION', 'DESCUENTO', 'RAPPEL', 'CONCURSO', 'IMPAGO']);
    expect(MOTIVOS_VENTA.filter((m) => MOTIVO_INFO[m].admitePeriodo)).toEqual(['DESCUENTO', 'RAPPEL']);
    expect(MOTIVOS_VENTA.filter((m) => MOTIVO_INFO[m].soloDiferencias)).toEqual(['CONCURSO', 'IMPAGO']);
  });

  it('impago y concurso salen desactivados, con su explicación', () => {
    for (const m of ['CONCURSO', 'IMPAGO'] as const) {
      expect(MOTIVO_INFO[m].disponible).toBe(false);
      expect(MOTIVO_INFO[m].aviso).toMatch(/modelo 952/);
    }
    expect(MOTIVOS_VENTA.filter((m) => !MOTIVO_INFO[m].disponible)).toEqual(['CONCURSO', 'IMPAGO']);
  });
});

describe('motivo propuesto por el texto leído', () => {
  it.each([
    ['Devolución de 3 cajas', 'DEVOLUCION'],
    ['Mercancía devuelta', 'DEVOLUCION'],
    ['RAPPEL 2T', 'RAPPEL'],
    ['Descuento por pronto pago', 'DESCUENTO'],
    ['Bonificación comercial', 'DESCUENTO'],
    ['Cliente en concurso de acreedores', 'CONCURSO'],
    ['Impagada', 'IMPAGO'],
    ['Crédito incobrable', 'IMPAGO'],
    ['Error en el precio', 'ERROR'],
    ['Factura incorrecta', 'ERROR'],
    ['Nos equivocamos de cliente', 'ERROR'],
  ])('«%s» -> %s', (texto, motivo) => {
    expect(motivoDeTexto(texto)).toBe(motivo);
  });

  it('sin texto o sin pista, no se propone nada', () => {
    expect(motivoDeTexto(null)).toBeNull();
    expect(motivoDeTexto('   ')).toBeNull();
    expect(motivoDeTexto('Según lo hablado')).toBeNull();
  });
});

describe('diferencia de una sustitución', () => {
  const lineas = (ls: Array<{ cantidad: number; precioUnitario: number; tipoIva: number; cuenta?: string }>) =>
    calcularImportesFactura(
      ls.map((l) => ({ descripcion: 'x', cantidad: l.cantidad, precioUnitario: l.precioUnitario, tipoIva: l.tipoIva, ...(l.cuenta ? { cuentaContable: l.cuenta } : {}) })),
      { tipoCambio: 1, mismaMoneda: true },
    ).lineas.map((l) => ({ tipoIva: l.tipoIva, cuenta: l.cuentaContable ?? null, ...l.cuenta }));

  it('dos líneas de 0,07 € frente a una de 0,14 € al 21 %: la base no cambia y la cuota baja un céntimo', () => {
    const dosLineas = lineas([
      { cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
      { cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
    ]);
    const d = diferenciaSustitucion(dosLineas, lineas([{ cantidad: 1, precioUnitario: 0.14, tipoIva: 21 }]));
    expect(d.porTipoIva).toEqual([{ tipoIva: 21, base: 0, cuota: -0.01 }]);
    expect(d).toMatchObject({ base: 0, cuota: -0.01, retencion: 0, total: -0.01 });
    expect(d.porCuenta).toEqual([]);
  });

  it('por tipo de IVA y por cuenta: lo que sube y lo que baja', () => {
    const original = lineas([
      { cantidad: 1, precioUnitario: 100, tipoIva: 21, cuenta: '700' },
      { cantidad: 1, precioUnitario: 50, tipoIva: 10, cuenta: '705' },
    ]);
    const corregida = lineas([
      { cantidad: 1, precioUnitario: 80, tipoIva: 21, cuenta: '700' },
      { cantidad: 1, precioUnitario: 50, tipoIva: 10, cuenta: '705' },
    ]);
    const d = diferenciaSustitucion(corregida, original);
    expect(d.porTipoIva).toEqual([{ tipoIva: 21, base: -20, cuota: -4.2 }]);
    expect(d.porCuenta).toEqual([{ cuenta: '700', base: -20 }]);
    expect(d.total).toBe(-24.2);
  });
});

describe('reparto entre varias facturas', () => {
  it('cuadra solo si suma al céntimo base, cuota y retención', () => {
    const total = { base: -150.01, cuota: -31.5, retencion: 0 };
    expect(repartoCuadra([{ base: -100, cuota: -21, retencion: 0 }, { base: -50.01, cuota: -10.5, retencion: 0 }], total)).toBe(true);
    expect(repartoCuadra([{ base: -100, cuota: -21, retencion: 0 }, { base: -50, cuota: -10.5, retencion: 0 }], total)).toBe(false);
    expect(repartoCuadra([{ base: -100, cuota: -21, retencion: 0 }, { base: -50.01, cuota: -10.51, retencion: 0 }], total)).toBe(false);
  });
});

describe('cuenta que se propone por tipo de IVA', () => {
  it('la de la línea de mayor base de cada tipo, entre todas las originales; sin cuenta, la 700', () => {
    expect(
      cuentaPorTipoIva([
        { tipoIva: 21, cuenta: '7000001', baseLine: 100 },
        { tipoIva: 21, cuenta: '705', baseLine: 300 },
        { tipoIva: 10, cuenta: null, baseLine: 20 },
        // De otra original: la de 400 € manda en el 21 %.
        { tipoIva: 21, cuenta: '7050002', baseLine: 400 },
      ]),
    ).toEqual({ '21': '7050002', '10': '700' });
  });
});

describe('plazos y límites de la ley', () => {
  it('cuatro años desde el devengo', () => {
    expect(limitePlazo('2027-03-15')).toBe('2031-03-15');
    expect(limitePlazo('2028-02-29')).toBe('2032-02-29');
    expect(limitePlazo('2026-12-31')).toBe('2030-12-31');
  });

  it('art. 89.Tres.1.º: subir la cuota a un consumidor final solo por el art. 80', () => {
    const base = { cuota: 21, clienteConNif: false, ticket: false };
    expect(subeCuotaAConsumidorFinal({ ...base, motivo: 'ERROR' })).toBe(true);
    expect(subeCuotaAConsumidorFinal({ ...base, motivo: 'ERROR_DERECHO' })).toBe(true);
    expect(subeCuotaAConsumidorFinal({ ...base, motivo: 'OTROS' })).toBe(true);
    expect(subeCuotaAConsumidorFinal({ ...base, motivo: 'CAMBIO_PRECIO' })).toBe(false);
    // Con NIF y sin ticket, sí se puede; bajarla, siempre.
    expect(subeCuotaAConsumidorFinal({ ...base, clienteConNif: true, motivo: 'ERROR' })).toBe(false);
    expect(subeCuotaAConsumidorFinal({ ...base, clienteConNif: true, ticket: true, motivo: 'ERROR' })).toBe(true);
    expect(subeCuotaAConsumidorFinal({ ...base, cuota: -21, motivo: 'ERROR' })).toBe(false);
  });

  it('una R4 que sube la cuota va al periodo de la original; el resto, no', () => {
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'ERROR', ticket: false, cuota: 2.1 })).toBe(true);
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'OTROS', ticket: false, cuota: 2.1 })).toBe(true);
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'ERROR', ticket: false, cuota: -2.1 })).toBe(false);
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'ERROR_DERECHO', ticket: false, cuota: 2.1 })).toBe(false);
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'CAMBIO_PRECIO', ticket: false, cuota: 2.1 })).toBe(false);
    expect(exigeImputarAlPeriodoOriginal({ motivo: 'ERROR', ticket: true, cuota: 2.1 })).toBe(false);
    expect(exigeImputarAlPeriodoOriginal({ motivo: null, ticket: false, cuota: 2.1 })).toBe(false);
  });
});

describe('texto del libro de expedidas', () => {
  it('tipo, forma, facturas rectificadas y causa', () => {
    expect(
      textoRectificaVenta({ tipoFactura: 'R1', forma: 'I', originales: [{ numero: 'A-12', fecha: '2027-02-03' }], motivo: 'DEVOLUCION' }),
    ).toBe('Rectificativa (R1, por diferencias) de A-12 de 03/02/2027. Causa: devolución de mercancías o envases.');
    expect(textoRectificaVenta({ tipoFactura: 'R1', forma: 'I', originales: [], periodo: { desde: '2027-01-01', hasta: '2027-03-31' }, motivo: 'RAPPEL' })).toBe(
      'Rectificativa (R1, por diferencias) de las ventas del 01/01/2027 al 31/03/2027. Causa: rappel por volumen.',
    );
    expect(textoRectificaVenta({ tipoFactura: 'R4', forma: 'S', originales: [{ numero: 'B-3', fecha: null }], motivo: null })).toBe(
      'Rectificativa (R4, por sustitución) de B-3.',
    );
  });
});
