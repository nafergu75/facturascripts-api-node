// Importes de una factura en su moneda y en la de cuenta (puro).
// - EUR -> EUR: identico al calculo de siempre (copia literal, sin redondear nada).
// - Divisa: la base se convierte por tipo de IVA y la cuota se calcula sobre la
//   base ya convertida (art. 79.Once LIVA); los centimos se reparten por linea.
import {
  calcularImportesFactura,
  calcularLineasDoc,
  convertirLineas,
  lineasEspejo,
  repartirCentimos,
  totalesDeLineas,
  type LineaEntrada,
} from '../domain/importesFactura';
import { desgloseIvaPorTipo } from '../services/accounting-engine.service';
import { redondear2 } from '../utils/money';

/** El calculo de siempre (copia de income-invoices.service antes de las divisas). */
function calcularTotalesAntiguo(lineas: LineaEntrada[]) {
  const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
  let baseTotal = 0;
  let ivaTotal = 0;
  let retencionTotal = 0;
  const lineasConTotales = lineas.map((l) => {
    const tipoIva = l.tipoIva ?? 21;
    const tipoRetencion = l.tipoRetencion ?? 0;
    const descuentoPorcentaje = l.descuentoPorcentaje ?? 0;
    const pvpSinDescuento = round2(l.cantidad * l.precioUnitario);
    const descuentoImporte = round2((pvpSinDescuento * descuentoPorcentaje) / 100);
    const baseLine = round2(pvpSinDescuento - descuentoImporte);
    const ivaImporte = round2((baseLine * tipoIva) / 100);
    const retencionImporte = round2((baseLine * tipoRetencion) / 100);
    baseTotal = round2(baseTotal + baseLine);
    ivaTotal = round2(ivaTotal + ivaImporte);
    retencionTotal = round2(retencionTotal + retencionImporte);
    return { baseLine, ivaImporte, retencionImporte, descuentoImporte };
  });
  return { baseTotal, ivaTotal, retencionTotal, totalFactura: round2(baseTotal + ivaTotal - retencionTotal), lineasConTotales };
}

/** Generador pseudoaleatorio reproducible (mulberry32). */
function aleatorio(semilla: number) {
  let a = semilla;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function facturaAleatoria(r: () => number): LineaEntrada[] {
  const n = 1 + Math.floor(r() * 6);
  return Array.from({ length: n }, (_, i) => ({
    descripcion: `L${i}`,
    cantidad: [1, 2, 3, 0.5, 1.25, 7, -1][Math.floor(r() * 7)],
    precioUnitario: Math.round(r() * 1_000_000) / 10_000,
    descuentoPorcentaje: [0, 0, 5, 10, 12.5, 33][Math.floor(r() * 6)],
    tipoIva: [0, 4, 5, 10, 21][Math.floor(r() * 5)],
    tipoRetencion: [0, 0, 7, 15, 19][Math.floor(r() * 5)],
  }));
}

const linea = (precio: number, iva = 21, extra: Partial<LineaEntrada> = {}): LineaEntrada => ({
  descripcion: 'x',
  cantidad: 1,
  precioUnitario: precio,
  tipoIva: iva,
  ...extra,
});

describe('EUR -> EUR: igual que siempre', () => {
  it('1.000 facturas aleatorias dan lo mismo que el calculo antiguo, y la cuenta es copia del documento', () => {
    const r = aleatorio(20261008);
    for (let k = 0; k < 1000; k++) {
      const lineas = facturaAleatoria(r);
      const antiguo = calcularTotalesAntiguo(lineas);
      const nuevo = calcularImportesFactura(lineas, { tipoCambio: 1, mismaMoneda: true });
      expect(nuevo.doc).toEqual({
        baseTotal: antiguo.baseTotal,
        ivaTotal: antiguo.ivaTotal,
        retencionTotal: antiguo.retencionTotal,
        totalFactura: antiguo.totalFactura,
      });
      expect(nuevo.cuenta).toEqual(nuevo.doc);
      nuevo.lineas.forEach((l, i) => {
        expect(l.doc).toEqual({ ...antiguo.lineasConTotales[i], precioUnitario: lineas[i].precioUnitario });
        expect(l.cuenta).toEqual(l.doc);
      });
    }
  });
});

describe('conversion a la moneda de cuenta', () => {
  it('1.000 USD al 21 % a 1,1490: base 870,32, IVA 182,77, total 1.053,09', () => {
    const r = calcularImportesFactura([linea(1000)], { tipoCambio: 1.149, mismaMoneda: false });
    expect(r.doc).toEqual({ baseTotal: 1000, ivaTotal: 210, retencionTotal: 0, totalFactura: 1210 });
    expect(r.cuenta).toEqual({ baseTotal: 870.32, ivaTotal: 182.77, retencionTotal: 0, totalFactura: 1053.09 });
  });

  it('dos tipos de IVA: se convierte la base de cada tipo (no el total)', () => {
    const r = calcularImportesFactura([linea(999.99, 21), linea(100, 10)], { tipoCambio: 1.149, mismaMoneda: false });
    const por = Object.fromEntries(desgloseIvaPorTipo(r.lineas.map((l) => ({ tipoIva: l.tipoIva, ...l.cuenta }))).map((d) => [d.tipoIva, d]));
    expect(por[21]).toMatchObject({ base: 870.31, cuota: 182.77 });
    expect(por[10]).toMatchObject({ base: 87.03, cuota: 8.7 });
    expect(r.cuenta.baseTotal).toBe(957.34);
    expect(r.cuenta.ivaTotal).toBe(191.47);
    expect(r.cuenta.totalFactura).toBe(1148.81);
    // Dividir el total daria un centimo mas: es la diferencia esperada.
    expect(redondear2(1319.99 / 1.149)).toBe(1148.82);
  });

  it('reparto de centimos: 33,33 / 33,33 / 33,34 USD al 21 %', () => {
    const r = calcularImportesFactura([linea(33.33), linea(33.33), linea(33.34)], { tipoCambio: 1.149, mismaMoneda: false });
    expect(r.lineas.map((l) => l.cuenta.baseLine)).toEqual([29.01, 29.01, 29.01]);
    expect(r.cuenta.baseTotal).toBe(87.03);
    expect(r.lineas.map((l) => l.cuenta.ivaImporte)).toEqual([6.1, 6.09, 6.09]);
    expect(r.cuenta.ivaTotal).toBe(18.28);
  });

  it('retencion: por tipo de retencion sobre las bases convertidas', () => {
    const r = calcularImportesFactura([linea(1000, 21, { tipoRetencion: 15 }), linea(500, 21, { tipoRetencion: 15 })], {
      tipoCambio: 1.149,
      mismaMoneda: false,
    });
    expect(r.cuenta.baseTotal).toBe(1305.48);
    expect(r.cuenta.retencionTotal).toBe(redondear2(1305.48 * 0.15));
    expect(r.cuenta.totalFactura).toBe(redondear2(r.cuenta.baseTotal + r.cuenta.ivaTotal - r.cuenta.retencionTotal));
  });

  it('precio y descuento en cuenta: solo informativos', () => {
    const r = calcularImportesFactura([linea(114.9, 21, { cantidad: 2, descuentoPorcentaje: 10 })], { tipoCambio: 1.149, mismaMoneda: false });
    expect(r.lineas[0].cuenta.precioUnitario).toBe(100);
    expect(r.lineas[0].cuenta.descuentoImporte).toBe(redondear2(22.98 / 1.149));
  });

  it('tipo PENDIENTE (borrador sin tipo): la moneda de cuenta queda a cero', () => {
    const r = calcularImportesFactura([linea(1000)], { tipoCambio: null, mismaMoneda: false });
    expect(r.doc.totalFactura).toBe(1210);
    expect(r.cuenta).toEqual({ baseTotal: 0, ivaTotal: 0, retencionTotal: 0, totalFactura: 0 });
  });

  it('invariantes con facturas aleatorias en divisa: cabecera = suma de lineas, total = base + IVA - retencion, libro de IVA = cabecera', () => {
    const rnd = aleatorio(7);
    for (let k = 0; k < 500; k++) {
      const tc = [1.149, 0.8573, 8.9415, 1.0712, 25.31][k % 5];
      const r = calcularImportesFactura(facturaAleatoria(rnd), { tipoCambio: tc, mismaMoneda: false });
      const suma = totalesDeLineas(r.lineas.map((l) => l.cuenta));
      expect(r.cuenta).toEqual(suma);
      expect(r.cuenta.totalFactura).toBe(redondear2(r.cuenta.baseTotal + r.cuenta.ivaTotal - r.cuenta.retencionTotal));
      const libro = desgloseIvaPorTipo(r.lineas.map((l) => ({ tipoIva: l.tipoIva, ...l.cuenta })));
      expect(redondear2(libro.reduce((s, d) => s + d.base, 0))).toBe(r.cuenta.baseTotal);
      expect(redondear2(libro.reduce((s, d) => s + d.cuota, 0))).toBe(r.cuenta.ivaTotal);
      // La cuota de cada tipo es la de su base convertida.
      for (const d of libro) expect(d.cuota).toBe(redondear2((d.base * d.tipoIva) / 100));
    }
  });
});

describe('repartirCentimos', () => {
  it('ajusta al objetivo y desempata por el menor indice', () => {
    expect(repartirCentimos(0.03, [0.01, 0.01, 0.01])).toEqual([0.01, 0.01, 0.01]);
    expect(repartirCentimos(0.04, [0.0133, 0.0133, 0.0133])).toEqual([0.02, 0.01, 0.01]);
    expect(repartirCentimos(0.02, [0.0133, 0.0133, 0.0133])).toEqual([0, 0.01, 0.01]);
    expect(repartirCentimos(5, [])).toEqual([]);
  });

  it('admite signos mezclados y la suma siempre es el objetivo', () => {
    const r = repartirCentimos(-1.01, [-0.505, -0.505, 0.001]);
    expect(redondear2(r.reduce((s, x) => s + x, 0))).toBe(-1.01);
    expect(r.every((x) => !Object.is(x, -0))).toBe(true);
  });

  it('convertirLineas exige un tipo positivo', () => {
    expect(() => convertirLineas(calcularLineasDoc([linea(1)]).lineas, 0)).toThrow();
  });
});

describe('rectificativa total: lineas espejo', () => {
  it('original + rectificativa = 0 exacto en las dos monedas, tambien con precio 0,125', () => {
    for (const lineas of [[linea(1000), linea(999.99, 10)], [linea(0.125, 21, { cantidad: 3 }), linea(0.125, 4, { cantidad: 1 })]]) {
      for (const [tipoCambio, mismaMoneda] of [
        [1, true],
        [1.149, false],
      ] as const) {
        const original = calcularImportesFactura(lineas, { tipoCambio, mismaMoneda });
        const espejo = lineasEspejo(original);
        for (const lado of ['doc', 'cuenta'] as const) {
          for (const k of ['baseTotal', 'ivaTotal', 'retencionTotal', 'totalFactura'] as const) {
            expect(redondear2(original[lado][k] + espejo[lado][k])).toBe(0);
          }
          original.lineas.forEach((l, i) => {
            expect(redondear2(l[lado].baseLine + espejo.lineas[i][lado].baseLine)).toBe(0);
            expect(redondear2(l[lado].ivaImporte + espejo.lineas[i][lado].ivaImporte)).toBe(0);
            expect(espejo.lineas[i][lado].precioUnitario).toBe(l[lado].precioUnitario);
          });
        }
        expect(espejo.lineas.map((l) => l.cantidad)).toEqual(lineas.map((l) => -l.cantidad));
      }
    }
  });
});
