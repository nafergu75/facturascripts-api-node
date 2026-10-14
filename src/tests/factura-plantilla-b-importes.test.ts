// Plantilla B: importes de NZ013_2026 (cantidad de la unidad del precio × precio,
// el cargo de palets dentro de la base y el IVA por tipo) y totales del pie.
import { calcularImportesFactura, lineasEspejo, type LineaEntrada } from '../domain/importesFactura';
import { negarMedidas, redondear3, resumenCeramica } from '../domain/ceramica';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';

const centimos = (n: number) => Math.round(n * 100);
const suma = (v: number[]) => v.reduce((a, c) => a + centimos(c), 0) / 100;

function lineasMuestra(): LineaEntrada[] {
  return LINEAS_NZ013.map((l) => ({
    descripcion: l.descripcion,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    palets: l.palets,
    cajas: l.cajas,
    metros2: l.metros2,
    piezas: l.piezas,
    formato: l.formato,
    calidad: l.calidad,
    unidadPrecio: l.unidadPrecio,
    textoAdicional: l.textoAdicional,
    ...(l.cargoPalets ? { cargoPalets: true } : {}),
  }));
}

describe('plantilla B: importes de NZ013_2026', () => {
  it('da exactamente la muestra: TOTAL BRUTO 600,74, IVA 126,16 y TOTAL FACTURA 726,90', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    expect(r.doc).toEqual({ baseTotal: TOTALES_NZ013.base, ivaTotal: TOTALES_NZ013.iva, retencionTotal: 0, totalFactura: TOTALES_NZ013.total });
    expect(r.cuenta).toEqual(r.doc);
    // El IMPORTE de cada linea, el de la muestra (el cargo de palets incluido).
    expect(r.lineas.map((l) => l.doc.baseLine)).toEqual(LINEAS_NZ013.map((l) => l.importe));
    expect(suma(r.lineas.map((l) => l.doc.ivaImporte))).toBe(TOTALES_NZ013.iva);
    // Linea a linea sale lo mismo en esta muestra.
    const porLinea = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true });
    expect(porLinea.doc.ivaTotal).toBe(TOTALES_NZ013.iva);
  });

  it('los datos de ceramica pasan a la linea calculada', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    expect(r.lineas[0]).toMatchObject({ palets: 0, cajas: 3, metros2: 5.04, piezas: 18, formato: '23,3x120', calidad: '1', unidadPrecio: 'M2', textoAdicional: 'PORCELANICO RECTIFICADO' });
    expect(r.lineas[2]).toMatchObject({ cargoPalets: true, unidadPrecio: 'UNIDAD' });
  });

  it('resumen del pie: palets 1, cajas 13, m2 12,94 y piezas 38; el cargo de palets aparte (1 × 9,00)', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    const resumen = resumenCeramica(r.lineas.map((l) => ({ ...l, baseLine: l.doc.baseLine })));
    expect(resumen).toEqual({
      palets: TOTALES_NZ013.palets,
      cajas: TOTALES_NZ013.cajas,
      metros2: TOTALES_NZ013.metros2,
      piezas: TOTALES_NZ013.piezas,
      pesoKg: 0,
      cargoPalets: { cantidad: 1, importe: 9 },
    });
  });

  it('rectificativa total: todo en negativo, tambien palets, cajas, m2 y piezas; deja la original a cero', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    const espejo = lineasEspejo(r);
    expect(espejo.doc).toEqual({ baseTotal: -600.74, ivaTotal: -126.16, retencionTotal: 0, totalFactura: -726.9 });
    expect(espejo.lineas[1]).toMatchObject({ cantidad: -20, palets: -1, cajas: -10, metros2: -7.9, piezas: -20, formato: '33X120', unidadPrecio: 'PIEZA' });
    expect(espejo.lineas[0].palets).toBe(0);
    const resumen = resumenCeramica(espejo.lineas.map((l) => ({ ...l, baseLine: l.doc.baseLine })));
    expect(resumen).toMatchObject({ palets: -1, cajas: -13, metros2: -12.94, piezas: -38, cargoPalets: { cantidad: -1, importe: -9 } });
  });

  it('m2, piezas y pesos con 3 decimales como mucho; las medidas cambian de signo sin dejar -0', () => {
    expect(redondear3(1.2345)).toBe(1.235);
    expect(redondear3(-0.0005)).toBe(-0.001);
    expect(redondear3(0.1 + 0.2)).toBe(0.3);
    expect(negarMedidas({ palets: 0, cajas: 3, metros2: 5.04, piezas: null })).toEqual({ palets: 0, cajas: -3, metros2: -5.04, piezas: null });
    expect(Object.is(negarMedidas({ palets: 0 }).palets, -0)).toBe(false);
  });

  it('las piezas de las lineas cobradas por unidad son sus unidades: no suman en el total de piezas (18 de azulejo, no 31)', () => {
    const resumen = resumenCeramica([
      { cantidad: 5.04, cajas: 3, metros2: 5.04, piezas: 18, unidadPrecio: 'M2' },
      { cantidad: 12, piezas: 12, unidadPrecio: 'UNIDAD' },
      { cantidad: 1, piezas: 1, unidadPrecio: 'UNIDAD' },
      { cantidad: 4, piezas: 4, unidadPrecio: 'PIEZA' },
      { cantidad: 1, unidadPrecio: 'UNIDAD', cargoPalets: true, baseLine: 9 },
    ]);
    expect(resumen).toEqual({ palets: 0, cajas: 3, metros2: 5.04, piezas: 22, pesoKg: 0, cargoPalets: { cantidad: 1, importe: 9 } });
  });
});
