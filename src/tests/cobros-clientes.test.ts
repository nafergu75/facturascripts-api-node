/**
 * Resumen de cobros de clientes del panel (calculo puro, sin BD): pendiente y
 * vencido, cobros parciales, cobradas del año, rectificativas y proximas.
 */
import { describe, it, expect } from '@jest/globals';
import { resumirCobrosClientes, type FacturaVentaCobro } from '../services/cobrosClientes.service';

const HOY = '2026-10-07';

let secuencia = 0;
function factura(datos: Partial<FacturaVentaCobro> & { totalFactura: number }): FacturaVentaCobro {
  secuencia++;
  return {
    id: `f${secuencia}`,
    numeroCompleto: `A-${secuencia}`,
    cliente: 'Cliente SL',
    fechaEmision: '2026-03-01',
    fechaVencimiento: '2099-12-31',
    estado: 'PENDING',
    facturaOriginalId: null,
    ...datos,
  };
}

const resumir = (facturas: FacturaVentaCobro[], cobrado: Record<string, number> = {}, anio = 2026, cobradoEnElAnio = 0) =>
  resumirCobrosClientes(facturas, new Map(Object.entries(cobrado)), { anio, hoy: HOY, cobradoEnElAnio });

describe('pendiente de cobro', () => {
  it('suma lo que queda de cada factura, descontando los cobros parciales', () => {
    const a = factura({ totalFactura: 1210 });
    const b = factura({ totalFactura: 605 });
    const r = resumir([a, b], { [b.id]: 205 });
    expect(r.pendientes).toEqual({ numero: 2, importe: 1610 });
    expect(r.parcialmenteCobradas).toEqual({ numero: 1, importe: 400 });
    expect(r.proximas.find((f) => f.id === b.id)).toMatchObject({ total: 605, cobrado: 205, pendiente: 400 });
  });

  it('una deuda de otro año sigue pendiente aunque se mire este año', () => {
    const vieja = factura({ totalFactura: 121, fechaEmision: '2024-05-01', fechaVencimiento: '2024-06-01' });
    expect(resumir([vieja], {}, 2026).pendientes).toEqual({ numero: 1, importe: 121 });
    expect(resumir([vieja], {}, 2025).pendientes).toEqual({ numero: 1, importe: 121 });
  });

  it('ACCOUNTED (antiguo) cuenta como pendiente; PAID sin cobros, como cobrada', () => {
    const contabilizada = factura({ totalFactura: 100, estado: 'ACCOUNTED' });
    const aMano = factura({ totalFactura: 50, estado: 'PAID' });
    const r = resumir([contabilizada, aMano]);
    expect(r.pendientes).toEqual({ numero: 1, importe: 100 });
    expect(r.cobradas).toEqual({ numero: 1, importe: 50 });
  });

  it('suma en centimos: sin decimales arrastrados', () => {
    const r = resumir([factura({ totalFactura: 0.1 }), factura({ totalFactura: 0.2 })]);
    expect(r.pendientes.importe).toBe(0.3);
  });
});

describe('vencidas', () => {
  it('vencimiento anterior a hoy, con los dias de retraso', () => {
    const vencida = factura({ totalFactura: 242, fechaVencimiento: '2026-09-27' });
    const venceHoy = factura({ totalFactura: 121, fechaVencimiento: HOY });
    const r = resumir([vencida, venceHoy]);
    expect(r.vencidas).toEqual({ numero: 1, importe: 242 });
    expect(r.proximas.find((f) => f.id === vencida.id)).toMatchObject({ vencida: true, diasRetraso: 10 });
    expect(r.proximas.find((f) => f.id === venceHoy.id)).toMatchObject({ vencida: false, diasRetraso: 0 });
  });

  it('el retraso cruza el cambio de año y el de hora', () => {
    const f = factura({ totalFactura: 10, fechaEmision: '2025-11-20', fechaVencimiento: '2025-12-20' });
    expect(resumir([f]).proximas[0].diasRetraso).toBe(291);
  });
});

describe('cobradas del año', () => {
  it('solo las emitidas en el año elegido y cobradas enteras', () => {
    const cobrada = factura({ totalFactura: 242, estado: 'PAID' });
    const delAnioPasado = factura({ totalFactura: 60.5, estado: 'PAID', fechaEmision: '2025-12-01' });
    const parcial = factura({ totalFactura: 605 });
    const r = resumir([cobrada, delAnioPasado, parcial], { [cobrada.id]: 242, [delAnioPasado.id]: 60.5, [parcial.id]: 100 }, 2026, 402.5);
    expect(r.cobradas).toEqual({ numero: 1, importe: 242 });
    expect(r.cobradoEnElAnio).toBe(402.5);
    expect(resumir([cobrada, delAnioPasado], { [cobrada.id]: 242, [delAnioPasado.id]: 60.5 }, 2025).cobradas).toEqual({ numero: 1, importe: 60.5 });
  });

  it('una factura a cero no es ni pendiente ni cobrada', () => {
    const r = resumir([factura({ totalFactura: 0 })]);
    expect(r.pendientes.numero).toBe(0);
    expect(r.cobradas.numero).toBe(0);
  });
});

describe('rectificativas', () => {
  it('una rectificativa en negativo no es un cobro pendiente: resta de su factura original', () => {
    const original = factura({ totalFactura: 1210 });
    const rect = factura({ totalFactura: -121, facturaOriginalId: original.id, numeroCompleto: 'R-1' });
    const r = resumir([original, rect]);
    expect(r.pendientes).toEqual({ numero: 1, importe: 1089 });
    expect(r.proximas.map((f) => f.id)).toEqual([original.id]);
  });

  it('si la anula entera, la original deja de estar pendiente y no cuenta como cobrada', () => {
    const original = factura({ totalFactura: 363 });
    const rect = factura({ totalFactura: -363, facturaOriginalId: original.id });
    const r = resumir([original, rect]);
    expect(r.pendientes.numero).toBe(0);
    expect(r.cobradas.numero).toBe(0);
  });

  it('con cobros parciales, lo pendiente no baja de cero', () => {
    const original = factura({ totalFactura: 1210 });
    const rect = factura({ totalFactura: -1210, facturaOriginalId: original.id });
    expect(resumir([original, rect], { [original.id]: 500 }).pendientes.numero).toBe(0);
  });

  it('sobre una factura ya cobrada no cuenta (el abono se debe al cliente)', () => {
    const original = factura({ totalFactura: 1210, estado: 'PAID' });
    const otra = factura({ totalFactura: 100 });
    const rect = factura({ totalFactura: -1210, facturaOriginalId: original.id });
    const r = resumir([original, otra, rect], { [original.id]: 1210 });
    expect(r.pendientes).toEqual({ numero: 1, importe: 100 });
    expect(r.cobradas).toEqual({ numero: 1, importe: 1210 });
  });

  it('una rectificativa sin factura original no resta de nadie', () => {
    const otra = factura({ totalFactura: 100 });
    const suelta = factura({ totalFactura: -50 });
    expect(resumir([otra, suelta]).pendientes).toEqual({ numero: 1, importe: 100 });
  });

  it('una rectificativa en positivo se cobra como una factura mas', () => {
    const original = factura({ totalFactura: 100, estado: 'PAID' });
    const masImporte = factura({ totalFactura: 21, facturaOriginalId: original.id });
    expect(resumir([original, masImporte], { [original.id]: 100 }).pendientes).toEqual({ numero: 1, importe: 21 });
  });
});

describe('proximas', () => {
  it('hasta 8, primero las que vencen antes (las vencidas, las primeras)', () => {
    const facturas = Array.from({ length: 10 }, (_, i) =>
      factura({ totalFactura: 10 + i, fechaVencimiento: `2026-${String(12 - i).padStart(2, '0')}-01` }),
    );
    const r = resumir(facturas);
    expect(r.pendientes.numero).toBe(10);
    expect(r.proximas).toHaveLength(8);
    expect(r.proximas.map((f) => f.fechaVencimiento)).toEqual([...r.proximas.map((f) => f.fechaVencimiento)].sort());
    expect(r.proximas[0]).toMatchObject({ fechaVencimiento: '2026-03-01', vencida: true });
  });

  it('documenta el criterio en la respuesta', () => {
    const r = resumir([]);
    expect(r.criterio.pendientes).toMatch(/cualquier año/);
    expect(r.criterio.rectificativas).toMatch(/resta/);
    expect(r).toMatchObject({ anio: 2026, hoy: HOY, proximas: [] });
  });
});
