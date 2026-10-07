// Divisas (puro): catalogo, convencion del tipo de cambio, calendario TARGET y
// cobro en divisa. Convencion unica: tipoCambio = unidades de la moneda del
// documento por 1 de la moneda de cuenta (1 EUR = 1,1490 USD).
import {
  aCuenta,
  aDoc,
  calcularCobroDivisa,
  comprobarTipoManual,
  desviacion,
  esDiaHabilTarget,
  fechaObservacionEsperada,
  importesDoc,
  inverso,
  MONEDAS_CUENTA_HABILITADAS,
  MONEDAS_FACTURA,
  MONEDAS_FACTURA_ACTIVAS,
  pareceInvertido,
  pascua,
  textoTipo,
  tipoCruzado,
  ultimoDiaHabilTarget,
  validarFormatoTipoCambio,
  validarMoneda,
  validarMonedaCuenta,
  type EntradaCobroDivisa,
} from '../domain/divisas';
import { redondear2, redondear4, redondear8 } from '../utils/money';

describe('catalogo de monedas', () => {
  it('solo estan activas EUR y USD; todas las del catalogo tienen 2 decimales', () => {
    expect(MONEDAS_FACTURA_ACTIVAS).toEqual(['EUR', 'USD']);
    for (const c of MONEDAS_FACTURA_ACTIVAS) expect(MONEDAS_FACTURA[c]).toBeDefined();
    for (const m of Object.values(MONEDAS_FACTURA)) expect(m.decimales).toBe(2);
    expect(MONEDAS_CUENTA_HABILITADAS).toEqual(['EUR', 'USD']);
  });

  it('validarMoneda normaliza y rechaza las que no estan', () => {
    expect(validarMoneda('usd ')).toBe('USD');
    // En el catalogo pero desactivadas: no se puede facturar en ellas.
    expect(() => validarMoneda(' gbp')).toThrow(/GBP no está habilitada/);
    expect(() => validarMoneda('HKD')).toThrow(/Usa: EUR, USD/);
    expect(() => validarMoneda('JPY')).toThrow(/JPY no está disponible/);
    expect(() => validarMoneda('XX')).toThrow(/tres letras/);
    expect(() => validarMoneda('GBP', ['USD'])).toThrow(/GBP no está habilitada/);
  });

  it('la moneda de cuenta: EUR o USD, y EUR obligatoria en Espana', () => {
    expect(validarMonedaCuenta('eur', 'ES')).toBe('EUR');
    expect(validarMonedaCuenta('USD', 'US')).toBe('USD');
    expect(validarMonedaCuenta('USD', 'HK')).toBe('USD');
    expect(() => validarMonedaCuenta('USD', 'ES')).toThrow(/euros/);
    expect(() => validarMonedaCuenta('GBP', 'GB')).toThrow(/habilitada/);
  });
});

describe('tipo de cambio', () => {
  it('se divide para pasar a la moneda de cuenta (ejemplo de referencia)', () => {
    expect(aCuenta(1000, 1.149)).toBe(870.32);
    expect(aCuenta(1149, 1.149)).toBe(1000);
    expect(aCuenta(-1000, 1.149)).toBe(-870.32);
    expect(aDoc(100, 1.149)).toBe(114.9);
    expect(() => aCuenta(1, 0)).toThrow();
  });

  it('inverso y cruzado con 8 decimales', () => {
    expect(inverso(1.149)).toBe(0.87032202);
    // Empresa en USD que factura en HKD: r(HKD)/r(USD), las dos del mismo dia.
    expect(tipoCruzado(8.9415, 1.149)).toBe(redondear8(8.9415 / 1.149));
    // Empresa en USD que factura en EUR: 1 / r(USD).
    expect(tipoCruzado(1, 1.149)).toBe(0.87032202);
  });

  it('texto unico: 1 EUR = 1,1490 USD', () => {
    expect(textoTipo('EUR', 'USD', 1.149)).toBe('1 EUR = 1,1490 USD');
    expect(textoTipo('USD', 'EUR', 0.87032202, 'en')).toBe('1 USD = 0.8703 EUR');
  });

  it('formato del tipo manual', () => {
    expect(validarFormatoTipoCambio('1,1490')).toBe(1.149);
    expect(validarFormatoTipoCambio(1.14903)).toBe(1.14903);
    for (const malo of [0, -1, 'abc', '', 1e7, 1.123456789, Number.NaN, Infinity]) {
      expect(() => validarFormatoTipoCambio(malo)).toThrow();
    }
  });

  it('detecta el tipo invertido y el que se sale de [BCE/2, BCE×2]', () => {
    expect(pareceInvertido(0.87, 1.149)).toBe(true);
    expect(pareceInvertido(1.1, 1.149)).toBe(false);
    // Monedas casi a la par: no se marca como invertido.
    expect(pareceInvertido(1.01, 0.99)).toBe(false);
    expect(() => comprobarTipoManual(0.87, 1.149, 'EUR', 'USD')).toThrow(/invertido/);
    expect(() => comprobarTipoManual(0.5, 1.149, 'EUR', 'USD')).toThrow(/lejos/);
    expect(() => comprobarTipoManual(2.4, 1.149, 'EUR', 'USD')).toThrow(/lejos/);
    expect(comprobarTipoManual(1.15, 1.149, 'EUR', 'USD')).toEqual({});
    expect(comprobarTipoManual(1.17, 1.149, 'EUR', 'USD').aviso).toMatch(/0,5 %/);
    // Sin BCE de esa fecha, no se puede comprobar: se acepta.
    expect(comprobarTipoManual(0.87, null, 'EUR', 'USD')).toEqual({});
    expect(desviacion(1.15, 1.15)).toBe(0);
  });
});

describe('calendario TARGET', () => {
  it('Pascua y festivos', () => {
    expect(pascua(2026)).toBe('2026-04-05');
    expect(pascua(2025)).toBe('2025-04-20');
    expect(esDiaHabilTarget('2026-04-03')).toBe(false); // Viernes Santo
    expect(esDiaHabilTarget('2026-04-06')).toBe(false); // Lunes de Pascua
    expect(esDiaHabilTarget('2026-05-01')).toBe(false);
    expect(esDiaHabilTarget('2026-12-25')).toBe(false);
    expect(esDiaHabilTarget('2026-12-26')).toBe(false);
    expect(esDiaHabilTarget('2026-01-01')).toBe(false);
    expect(esDiaHabilTarget('2026-09-21')).toBe(true);
  });

  it('fin de semana y festivos -> ultimo dia habil anterior', () => {
    expect(ultimoDiaHabilTarget('2026-09-19')).toBe('2026-09-18');
    expect(ultimoDiaHabilTarget('2026-09-20')).toBe('2026-09-18');
    expect(ultimoDiaHabilTarget('2026-04-06')).toBe('2026-04-02');
    expect(ultimoDiaHabilTarget('2026-05-01')).toBe('2026-04-30');
  });

  it('devengo hoy antes de las 16:30 en Madrid: el dia habil anterior', () => {
    // 21/09/2026 (lunes) a las 14:00 de Madrid (12:00 UTC, horario de verano).
    expect(fechaObservacionEsperada('2026-09-21', new Date('2026-09-21T12:00:00Z'))).toBe('2026-09-18');
    // A las 17:00 de Madrid ya esta publicado.
    expect(fechaObservacionEsperada('2026-09-21', new Date('2026-09-21T15:00:00Z'))).toBe('2026-09-21');
    // Devengo futuro: como mucho, el de hoy.
    expect(fechaObservacionEsperada('2026-09-30', new Date('2026-09-21T15:00:00Z'))).toBe('2026-09-21');
    // Devengo pasado en domingo.
    expect(fechaObservacionEsperada('2026-09-20', new Date('2026-10-07T10:00:00Z'))).toBe('2026-09-18');
  });
});

describe('importesDoc', () => {
  const cuenta = { baseTotal: 870.32, ivaTotal: 182.77, retencionTotal: 0, totalFactura: 1053.09 };
  it('las *Doc a null valen lo de la moneda de cuenta (facturas anteriores)', () => {
    expect(importesDoc({ ...cuenta, tipoCambio: 1 })).toEqual(cuenta);
  });
  it('en divisa usa las *Doc', () => {
    const doc = importesDoc({ ...cuenta, tipoCambio: 1.149, baseTotalDoc: 1000, ivaTotalDoc: 210, retencionTotalDoc: 0, totalFacturaDoc: 1210 });
    expect(doc.totalFactura).toBe(1210);
  });
  it('en divisa sin *Doc es un dato corrupto: error interno (nunca euros como si fueran dolares)', () => {
    expect(() => importesDoc({ ...cuenta, tipoCambio: 1.149 })).toThrow(/divisa/);
  });
});

describe('redondeo simetrico', () => {
  it('mitad lejos de cero, tambien en negativos', () => {
    expect(redondear2(1.005)).toBe(1.01);
    expect(redondear2(-1.005)).toBe(-1.01);
    expect(redondear2(2.675)).toBe(2.68);
    expect(redondear2(-2.675)).toBe(-2.68);
    expect(redondear2(-0.004)).toBe(0);
    expect(Object.is(redondear2(-0.004), -0)).toBe(false);
    expect(redondear4(0.12345)).toBe(0.1235);
    expect(redondear8(1 / 1.149)).toBe(0.87032202);
  });
});

describe('calcularCobroDivisa', () => {
  // Factura de 1.000 USD a 1,10: 909,09 EUR.
  const factura: Omit<EntradaCobroDivisa, 'importeDoc'> = {
    tipo: 'INGRESO',
    moneda: 'USD',
    monedaCuenta: 'EUR',
    monedaTesoreria: 'EUR',
    totalCuenta: 909.09,
    totalDoc: 1000,
    cobradoCuenta: 0,
    cobradoDoc: 0,
  };
  const apunte = (r: ReturnType<typeof calcularCobroDivisa>, cuenta: string) => r.apuntes.find((a) => a.cuenta === cuenta);

  it('cobro total a 1,05: diferencia positiva a la 768', () => {
    const r = calcularCobroDivisa({ ...factura, importeDoc: 1000, tipoCambio: 1.05, fuenteTipoCambio: 'BCE' });
    expect(r.importeTesoreria).toBe(952.38);
    expect(r.importe).toBe(909.09);
    expect(r.diferenciaCambio).toBe(43.29);
    expect(r.esUltimo).toBe(true);
    expect(apunte(r, 'TESORERIA')).toMatchObject({ debe: 952.38 });
    expect(apunte(r, 'TERCERO')).toMatchObject({ haber: 909.09 });
    expect(apunte(r, 'DIF_POSITIVA')).toMatchObject({ haber: 43.29 });
  });

  it('dos cobros parciales: 768 y luego 668; la 430 queda a cero', () => {
    const r1 = calcularCobroDivisa({ ...factura, importeDoc: 400, tipoCambio: 1.05 });
    expect([r1.importeTesoreria, r1.importe, r1.diferenciaCambio]).toEqual([380.95, 363.64, 17.31]);
    const r2 = calcularCobroDivisa({
      ...factura,
      cobradoCuenta: r1.importe,
      cobradoDoc: 400,
      importeDoc: 600,
      tipoCambio: 1.12,
    });
    expect([r2.importeTesoreria, r2.importe, r2.diferenciaCambio]).toEqual([535.71, 545.45, -9.74]);
    expect(apunte(r2, 'DIF_NEGATIVA')).toMatchObject({ debe: 9.74 });
    expect(redondear2(909.09 - r1.importe - r2.importe)).toBe(0);
    expect(r2.pendienteDocTras).toBe(0);
  });

  it('con lo recibido en el banco y comision', () => {
    const r = calcularCobroDivisa({ ...factura, importeDoc: 1000, importeRecibido: 945, comisionBancaria: 7.38 });
    expect(r.fuenteTipoCambio).toBe('BANCO');
    expect(apunte(r, 'TESORERIA')).toMatchObject({ debe: 945 });
    expect(apunte(r, 'COMISION')).toMatchObject({ debe: 7.38 });
    expect(apunte(r, 'TERCERO')).toMatchObject({ haber: 909.09 });
    expect(apunte(r, 'DIF_POSITIVA')).toMatchObject({ haber: 43.29 });
    expect(r.tipoCambio).toBe(redondear8(1000 / 952.38));
  });

  it('cada cobro cuadra: debe = haber', () => {
    for (const r of [
      calcularCobroDivisa({ ...factura, importeDoc: 1000, tipoCambio: 1.05 }),
      calcularCobroDivisa({ ...factura, importeDoc: 1000, tipoCambio: 1.2 }),
      calcularCobroDivisa({ ...factura, importeDoc: 1000, importeRecibido: 945, comisionBancaria: 7.38 }),
      calcularCobroDivisa({ ...factura, tipo: 'GASTO', importeDoc: 1000, tipoCambio: 1.05 }),
      calcularCobroDivisa({ ...factura, tipo: 'GASTO', importeDoc: 1000, tipoCambio: 1.2, comisionBancaria: 3 }),
    ]) {
      const debe = redondear2(r.apuntes.reduce((s, a) => s + a.debe, 0));
      const haber = redondear2(r.apuntes.reduce((s, a) => s + a.haber, 0));
      expect(debe).toBe(haber);
    }
  });

  it('en la moneda de cuenta salen los dos apuntes de siempre y no admite tipo ni comision', () => {
    const eur = { ...factura, moneda: 'EUR', totalDoc: 909.09 };
    const r = calcularCobroDivisa({ ...eur, importeDoc: 500 });
    expect(r.apuntes).toEqual([
      { cuenta: 'TESORERIA', debe: 500, haber: 0 },
      { cuenta: 'TERCERO', debe: 0, haber: 500 },
    ]);
    expect(r.fuenteTipoCambio).toBe('PAR');
    expect(() => calcularCobroDivisa({ ...eur, importeDoc: 500, comisionBancaria: 2 })).toThrow(/divisa/);
    expect(() => calcularCobroDivisa({ ...eur, importeDoc: 500, tipoCambio: 1.1 })).toThrow(/divisa/);
  });

  it('pago (GASTO) en espejo: perdida a la 668, ganancia a la 768', () => {
    const perdida = calcularCobroDivisa({ ...factura, tipo: 'GASTO', importeDoc: 1000, tipoCambio: 1.05 });
    expect(apunte(perdida, 'TERCERO')).toMatchObject({ debe: 909.09 });
    expect(apunte(perdida, 'TESORERIA')).toMatchObject({ haber: 952.38 });
    expect(apunte(perdida, 'DIF_NEGATIVA')).toMatchObject({ debe: 43.29 });
    const ganancia = calcularCobroDivisa({ ...factura, tipo: 'GASTO', importeDoc: 1000, tipoCambio: 1.2 });
    expect(apunte(ganancia, 'DIF_POSITIVA')).toMatchObject({ haber: redondear2(909.09 - 833.33) });
  });

  it('no deja cobrar mas de lo pendiente, con el mensaje en la moneda de la factura', () => {
    expect(() => calcularCobroDivisa({ ...factura, importeDoc: 1000.01, tipoCambio: 1.05 })).toThrow(/1\.000,01 USD/);
    expect(() => calcularCobroDivisa({ ...factura, importeDoc: 10 })).toThrow(/tipo de cambio/);
    expect(() =>
      calcularCobroDivisa({ ...factura, monedaTesoreria: 'GBP', importeDoc: 10, tipoCambio: 1.05 }),
    ).toThrow(/no está admitido/);
  });
});
