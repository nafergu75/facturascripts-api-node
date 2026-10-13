/**
 * Bloque «Rectificación» del PDF de una rectificativa de venta (art. 15.4 y
 * 15.5 RD 1619/2012): las facturas que corrige con su número y su fecha (de la
 * app o de fuera), el periodo de un rappel, la forma, el tipo (R1-R5) y la
 * causa con su explicación, en español y en inglés. Y que el PDF se dibuja.
 * Sin BD.
 */
import { describe, it, expect } from '@jest/globals';
import { renderizarFactura, textoRectificacionPdf, type DatosFacturaPdf } from '../services/facturaPdf.service';

const base = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  id: 'r1',
  numeroCompleto: 'R-12',
  estadoDocumento: 'FINAL',
  tipoFactura: 'R1',
  formaPago: 'TRANSFERENCIA',
  tipoRectificativa: 'I',
  motivoRectificacion: 'El cliente devolvió dos cajas',
  esRectificativa: true,
  fechaEmision: '2027-03-10',
  fechaVencimiento: '2027-04-09',
  baseTotal: -150,
  ivaTotal: -31.5,
  retencionTotal: 0,
  totalFactura: -181.5,
  observaciones: null,
  lineas: [{ descripcion: 'Devolución', cantidad: -1, precioUnitario: 150, descuentoPorcentaje: 0, tipoIva: 21, ivaImporte: -31.5, baseLine: -150, tipoRetencion: 0 }],
  cliente: { nombreFiscal: 'Cliente, S.L.', nifCif: 'B46123456', direccion: null, cp: null, municipio: null, provincia: null, pais: 'ES' },
  emisor: { denominacion: 'Emisor, S.L.', nif: 'B98765432', domicilioSocial: null, codigoPostal: null, municipio: null, provincia: null, pais: 'ES' },
  original: null,
  cuenta: null,
  moneda: 'EUR',
  monedaCuenta: 'EUR',
  tipoCambio: 1,
  fuenteTipoCambio: 'PAR',
  ...extra,
});

describe('PDF de una rectificativa de venta', () => {
  it('varias facturas: todas con su número y su fecha, la forma, el tipo y la causa con la explicación', () => {
    const f = base({
      causaRectificacion: 'DEVOLUCION',
      rectificadas: [
        { numero: 'A-3', fecha: '2027-02-03' },
        { numero: 'B-7', fecha: '2027-02-20' },
      ],
    });
    expect(textoRectificacionPdf(f, 'es')).toEqual([
      'Rectifica las facturas A-3, de 03/02/2027 y B-7, de 20/02/2027, por diferencias (R1).',
      'Motivo: Devolución de mercancías o envases. El cliente devolvió dos cajas',
    ]);
  });

  it('un rappel: el periodo en vez de facturas', () => {
    const f = base({ causaRectificacion: 'RAPPEL', motivoRectificacion: 'Rappel del primer trimestre', rectificadas: [], periodoRectificado: { desde: '2027-01-01', hasta: '2027-03-31' } });
    expect(textoRectificacionPdf(f, 'es')).toEqual([
      'Rectifica las ventas del 01/01/2027 al 31/03/2027, por diferencias (R1).',
      'Motivo: Rappel por volumen. Rappel del primer trimestre',
    ]);
  });

  it('una factura de fuera de la app, por sustitución; y la de un ticket (R5)', () => {
    expect(textoRectificacionPdf(base({ tipoFactura: 'R4', tipoRectificativa: 'S', causaRectificacion: 'ERROR', motivoRectificacion: '', rectificadas: [{ numero: 'F-2026/118', fecha: '2026-11-30' }] }), 'es')).toEqual([
      'Rectifica la factura F-2026/118, de 30/11/2026, por sustitución (R4).',
      'Motivo: Error en datos o importes.',
    ]);
    expect(textoRectificacionPdf(base({ tipoFactura: 'R5', causaRectificacion: 'DEVOLUCION', rectificadas: [{ numero: 'T-9', fecha: '2027-03-01' }] }), 'es')[0]).toBe(
      'Rectifica la factura T-9, de 01/03/2027, por diferencias (R5).',
    );
  });

  it('las de antes (sin enlaces ni causa) salen como siempre', () => {
    const f = base({ original: { numeroCompleto: 'A-1', fechaEmision: '2026-10-01' }, motivoRectificacion: 'Anulación' });
    expect(textoRectificacionPdf(f, 'es')).toEqual(['Rectifica la factura A-1, de 01/10/2026, por diferencias (R1).', 'Motivo: Anulación']);
  });

  it('en inglés (empresa de fuera de España)', () => {
    const f = base({
      causaRectificacion: 'DESCUENTO',
      motivoRectificacion: 'Agreed discount',
      emisor: { denominacion: 'Emisor LLC', nif: '12-3456789', domicilioSocial: null, codigoPostal: null, municipio: null, provincia: null, pais: 'US' },
      rectificadas: [
        { numero: 'A-3', fecha: '2027-02-03' },
        { numero: 'A-4', fecha: '2027-02-04' },
      ],
    });
    const t = textoRectificacionPdf(f, 'en');
    expect(t[0]).toMatch(/^Corrects invoices A-3, dated .* and A-4, dated .*\.$/);
    expect(t[1]).toBe('Reason: Discount or bonus after the invoice. Agreed discount');
  });

  it('el PDF se dibuja con muchas facturas rectificadas', async () => {
    const rectificadas = Array.from({ length: 30 }, (_, i) => ({ numero: `A-${100 + i}`, fecha: '2027-02-03' }));
    const pdf = await renderizarFactura(base({ causaRectificacion: 'DESCUENTO', rectificadas }));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
