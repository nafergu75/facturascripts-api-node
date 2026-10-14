// Plantilla A: importes de NZ004_26 con el IEEPNR dentro de la base y el IVA
// calculado por tipo (sobre la suma de bases), que es como lo hace la muestra.
// Linea a linea saldria 1 centimo menos de IVA.
import { calcularImportesFactura, calcularLineasDoc, cuotaDeBase, lineasEspejo, type LineaEntrada } from '../domain/importesFactura';
import { calcularIeepnr, resumenEnvases } from '../domain/ieepnr';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';

const centimos = (n: number) => Math.round(n * 100);
const suma = (v: number[]) => v.reduce((a, c) => a + centimos(c), 0) / 100;

function lineasMuestra(signo: 1 | -1 = 1): LineaEntrada[] {
  return LINEAS_NZ004.map((l) => ({
    descripcion: l.descripcion,
    cantidad: signo * l.cantidad,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    packs: signo * l.packs,
    kgPlastico: signo * l.kgPlastico,
    ieepnrImporte: calcularIeepnr(signo * l.kgPlastico, 0.45, { simetrico: signo < 0 }),
    textoAdicional: l.textoAdicional,
  }));
}

describe('plantilla A: importes de NZ004_26', () => {
  it('con cuotaPorTipo da exactamente la muestra: base 7.152,63, IVA 1.502,05 y total 8.654,68', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    expect(r.doc).toEqual({ baseTotal: TOTALES_NZ004.base, ivaTotal: TOTALES_NZ004.iva, retencionTotal: 0, totalFactura: TOTALES_NZ004.total });
    expect(r.cuenta).toEqual(r.doc);
    // La cuota de las lineas suma la de la cabecera.
    expect(suma(r.lineas.map((l) => l.doc.ivaImporte))).toBe(TOTALES_NZ004.iva);
  });

  it('articulos 6.974,88 e IEEPNR 177,75: el TOTAL de cada articulo es baseLine - IEEPNR', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    const articulos = r.lineas.map((l) => (centimos(l.doc.baseLine) - centimos(l.ieepnrImporte ?? 0)) / 100);
    expect(articulos).toEqual(LINEAS_NZ004.map((l) => l.totalArticulo));
    expect(suma(articulos)).toBe(TOTALES_NZ004.articulos);
    expect(suma(r.lineas.map((l) => l.ieepnrImporte ?? 0))).toBe(TOTALES_NZ004.ieepnr);
    // Los datos de envase pasan a la linea calculada.
    expect(r.lineas[1]).toMatchObject({ packs: 1092, kgPlastico: 176.17, ieepnrImporte: 79.28, textoAdicional: 'Cod. RPA Azúcar: 6B30250\nUnidad 1,5 L Refrescos SR' });
  });

  it('resumen: kg 394,992, packs 9.826 y uds 46.320', () => {
    const r = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    expect(resumenEnvases(r.lineas.map((l) => ({ cantidad: l.cantidad, packs: l.packs, kgPlastico: l.kgPlastico, ieepnrImporte: l.ieepnrImporte })))).toEqual({
      kgPlastico: TOTALES_NZ004.kgPlastico,
      packs: TOTALES_NZ004.packs,
      uds: TOTALES_NZ004.uds,
      ieepnr: TOTALES_NZ004.ieepnr,
    });
  });

  it('linea a linea (sin cuotaPorTipo) el IVA daria 1.502,04 y el total 8.654,67: por eso la A va por tipo', () => {
    const r = calcularLineasDoc(lineasMuestra());
    expect(r.totales).toEqual({ baseTotal: TOTALES_NZ004.base, ivaTotal: TOTALES_NZ004.ivaPorLinea, retencionTotal: 0, totalFactura: 8654.67 });
  });

  it('el espejo deja a cero base, IVA, total, IEEPNR, kg y packs', () => {
    const original = calcularImportesFactura(lineasMuestra(), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true });
    const espejo = lineasEspejo(original);
    expect(espejo.doc).toEqual({ baseTotal: -7152.63, ivaTotal: -1502.05, retencionTotal: 0, totalFactura: -8654.68 });
    for (const [i, l] of espejo.lineas.entries()) {
      expect(l.packs).toBe(-LINEAS_NZ004[i].packs);
      expect(l.kgPlastico).toBe(-LINEAS_NZ004[i].kgPlastico);
      expect(l.ieepnrImporte).toBe(-LINEAS_NZ004[i].ieepnr);
      expect(centimos(l.doc.baseLine) + centimos(original.lineas[i].doc.baseLine)).toBe(0);
      expect(centimos(l.doc.ivaImporte) + centimos(original.lineas[i].doc.ivaImporte)).toBe(0);
    }
  });

  it('en negativo (rectificativa calculada) da lo mismo con el signo cambiado', () => {
    const r = calcularImportesFactura(lineasMuestra(-1), { tipoCambio: 1, mismaMoneda: true, cuotaPorTipo: true, simetrico: true });
    expect(r.doc).toEqual({ baseTotal: -7152.63, ivaTotal: -1502.05, retencionTotal: 0, totalFactura: -8654.68 });
  });

  it('cuotaPorTipo con varios tipos: cada tipo sobre la suma de sus bases; la cuota fija no se toca', () => {
    const lineas: LineaEntrada[] = [
      { descripcion: 'a', cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
      { descripcion: 'b', cantidad: 1, precioUnitario: 0.07, tipoIva: 21 },
      { descripcion: 'c', cantidad: 1, precioUnitario: 0.05, tipoIva: 10 },
      { descripcion: 'd', cantidad: 1, precioUnitario: 0.05, tipoIva: 10 },
      { descripcion: 'e', cantidad: 1, precioUnitario: 10, tipoIva: 21, cuotaFija: 2.2 },
    ];
    // Por linea: 0,01 + 0,01 (21 %) y 0,01 + 0,01 (10 %). Por tipo: 0,14 × 21 % = 0,03 y 0,10 × 10 % = 0,01.
    const porLinea = calcularLineasDoc(lineas);
    expect(porLinea.lineas.map((l) => l.importes.ivaImporte)).toEqual([0.01, 0.01, 0.01, 0.01, 2.2]);
    const porTipo = calcularLineasDoc(lineas, { cuotaPorTipo: true });
    expect(porTipo.lineas.map((l) => l.importes.ivaImporte)).toEqual([0.02, 0.01, 0, 0.01, 2.2]);
    expect(porTipo.totales.ivaTotal).toBe(2.24);
    expect(porTipo.totales.totalFactura).toBe(12.48);
  });

  it('la cuota por tipo se calcula en enteros: 1.430,50 × 21 % = 300,405 da 300,41 (en coma flotante salia 300,40)', () => {
    const r = calcularLineasDoc(
      [
        { descripcion: 'a', cantidad: 1, precioUnitario: 1250, tipoIva: 21 },
        { descripcion: 'b', cantidad: 1, precioUnitario: 180.5, tipoIva: 21 },
      ],
      { cuotaPorTipo: true },
    );
    expect([r.totales.ivaTotal, r.totales.totalFactura]).toEqual([300.41, 1730.91]);
    expect(cuotaDeBase(1430.5, 21)).toBe(300.41);
    expect(cuotaDeBase(-1430.5, 21, true)).toBe(-300.41);
    expect(cuotaDeBase(-1430.5, 21)).toBe(-300.4);
    expect(cuotaDeBase(7152.63, 21)).toBe(1502.05);
    expect(cuotaDeBase(100, 5.5)).toBe(5.5);
  });

  it('sin IEEPNR ni cuotaPorTipo, la linea es la de siempre (sin claves nuevas)', () => {
    const r = calcularLineasDoc([{ descripcion: 'x', cantidad: 3, precioUnitario: 1.11, tipoIva: 21 }]);
    expect(Object.keys(r.lineas[0]).sort()).toEqual(['cantidad', 'descripcion', 'descuentoPorcentaje', 'importes', 'productoServicioId', 'tipoIva', 'tipoRetencion']);
    expect(r.totales).toEqual({ baseTotal: 3.33, ivaTotal: 0.7, retencionTotal: 0, totalFactura: 4.03 });
  });
});
