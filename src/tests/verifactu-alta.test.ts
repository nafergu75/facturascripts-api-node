// Registro de alta de VERI*FACTU (spec verifactu, 3.3, 3.4 y 4): construirAlta
// y validarAlta, sin BD. Un caso por tipo de operacion y uno por cada rechazo.
import { describe, it, expect } from '@jest/globals';
import { construirAlta, problemaDestinatario, validarAlta, type EntradaAlta, type LineaAlta } from '../services/verifactu/alta';
import type { AltaConstruida, DetalleDesglose } from '../services/verifactu/tipos';
import { numeroInstalacionDe, sistemaInformatico } from '../services/verifactu/sistema';
import { PAISES_AEAT, problemaNifIvaAeat } from '../services/verifactu/paises';

const NIF = 'A10952364';
const AHORA = new Date('2027-01-04T10:00:00Z');
const ES = { nombre: 'Cliente Nacional SL', pais: 'ES', nifCif: 'B12345674', cp: '46001' };
const FR = { nombre: 'Client France SARL', pais: 'FR', nifCif: 'FR12345678901', cp: '75001' };
const DE = { nombre: 'Kunde GmbH', pais: 'DE', nifCif: 'DE123456789', cp: '10115' };
const US = { nombre: 'Customer Inc', pais: 'US', nifCif: '12-3456789', cp: '10001' };
const CANARIAS = { nombre: 'Cliente Canario SL', pais: 'ES', nifCif: 'B12345674', cp: '35001' };

const l = (baseLine: number, tipoIva: number, ivaImporte = Math.round(baseLine * tipoIva) / 100, descripcion = 'Servicio'): LineaAlta => ({
  descripcion,
  baseLine,
  ivaImporte,
  tipoIva,
});
const suma = (ls: LineaAlta[], k: 'baseLine' | 'ivaImporte') => Math.round(ls.reduce((s, x) => s + x[k] * 100, 0)) / 100;

function entrada(extra: Partial<EntradaAlta> = {}): EntradaAlta {
  const lineas = extra.lineas ?? [l(100, 21)];
  return {
    facturaId: 'fac-1',
    tipoFactura: 'F1',
    tipoRectificativa: null,
    numeroCompleto: 'A-1',
    fechaEmision: '2027-01-04',
    fechaOperacion: null,
    tipoOperacion: 'NACIONAL',
    causaExencion: null,
    descripcionOperacion: null,
    motivoRectificacion: null,
    baseTotal: suma(lineas, 'baseLine'),
    ivaTotal: suma(lineas, 'ivaImporte'),
    emisor: { nombre: 'IFBIOSOLUCIONES, S.A.' },
    cliente: ES,
    nifObligado: NIF,
    criterioCaja: false,
    rectificadas: [],
    ...extra,
    lineas,
  };
}

const valida = (a: AltaConstruida) => validarAlta(a, { nifObligado: NIF, ahora: AHORA });
/** Espera un 422 con ese codigo. */
function rechaza(f: () => unknown, codigo: string, statusCode = 422) {
  try {
    f();
  } catch (e) {
    expect(e).toMatchObject({ statusCode, details: { codigo } });
    return;
  }
  throw new Error(`Se esperaba el 422 ${codigo}`);
}
const ok = (e: Partial<EntradaAlta> = {}) => {
  const a = construirAlta(entrada(e));
  valida(a);
  return a;
};

describe('construirAlta: un caso por tipo de operación', () => {
  it('NACIONAL al 21 y al 10 en dos líneas: dos líneas de desglose S1 con su tipo', () => {
    const a = ok({ lineas: [l(1000, 21), l(200, 10)] });
    expect(a).toMatchObject({ idEmisor: NIF, numSerie: 'A-1', fechaExpedicion: '04-01-2027', tipoFactura: 'F1', cuotaTotal: '230.00', importeTotal: '1430.00' });
    expect(a.cuerpo.desglose).toEqual([
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '1000.00', cuotaRepercutida: '210.00' },
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '10.00', baseImponible: '200.00', cuotaRepercutida: '20.00' },
    ]);
    expect(a.cuerpo.destinatarios).toEqual([{ nombre: 'Cliente Nacional SL', nif: 'B12345674' }]);
    expect(a.cuerpo.refExterna).toBe('fac-1');
    expect(a.cuerpo.nombreEmisor).toBe('IFBIOSOLUCIONES, S.A.');
    expect(a.cuerpo.tipoRectificativa).toBeUndefined();
  });

  it('dos líneas con el mismo tipo se agrupan en una', () => {
    const a = ok({ lineas: [l(100, 21), l(50.5, 21)] });
    expect(a.cuerpo.desglose).toHaveLength(1);
    expect(a.cuerpo.desglose[0]).toMatchObject({ baseImponible: '150.50', cuotaRepercutida: '31.61' });
  });

  it('el suplido (línea al 0 % en una nacional) queda fuera del desglose y del ImporteTotal', () => {
    const a = ok({ lineas: [l(100, 21), l(50, 0, 0, 'Tasas pagadas por cuenta del cliente')] });
    expect(a.cuerpo.desglose).toHaveLength(1);
    expect(a.importeTotal).toBe('121.00');
    expect(a.cuotaTotal).toBe('21.00');
  });

  it('el IRPF no entra en el ImporteTotal (es la suma de base y cuota)', () => {
    // Total a pagar 1.060 (1.000 + 210 - 150 de retención), ImporteTotal 1.210.
    const a = ok({ lineas: [l(1000, 21)] });
    expect(a.importeTotal).toBe('1210.00');
  });

  it('INTRACOMUNITARIA: E5 con la clave 01 y el cliente en IDOtro 02', () => {
    const a = ok({ tipoOperacion: 'INTRACOMUNITARIA', cliente: FR, lineas: [l(500, 0, 0)] });
    expect(a.cuerpo.desglose).toEqual([{ impuesto: '01', claveRegimen: '01', operacionExenta: 'E5', baseImponible: '500.00' }]);
    expect(a.cuerpo.destinatarios).toEqual([{ nombre: FR.nombre, idOtro: { idType: '02', id: 'FR12345678901' } }]);
    expect(Object.keys((a.cuerpo.destinatarios?.[0] as { idOtro: object }).idOtro)).toEqual(['idType', 'id']);
    expect(a.importeTotal).toBe('500.00');
    expect(a.cuotaTotal).toBe('0.00');
  });

  it('EXPORTACION: 02/E2 y el cliente con IDOtro 04', () => {
    const a = ok({ tipoOperacion: 'EXPORTACION', cliente: US, lineas: [l(800, 0, 0)] });
    expect(a.cuerpo.desglose[0]).toEqual({ impuesto: '01', claveRegimen: '02', operacionExenta: 'E2', baseImponible: '800.00' });
    expect(a.cuerpo.destinatarios?.[0]).toEqual({ nombre: US.nombre, idOtro: { codigoPais: 'US', idType: '04', id: '123456789' } });
  });

  it('servicios a la UE: 01/N2 con IDOtro 02; a EE. UU.: 01/N2 con IDOtro 04', () => {
    const ue = ok({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: DE, lineas: [l(300, 0, 0)] });
    expect(ue.cuerpo.desglose[0]).toEqual({ impuesto: '01', claveRegimen: '01', calificacionOperacion: 'N2', baseImponible: '300.00' });
    expect(ue.cuerpo.destinatarios?.[0]).toMatchObject({ idOtro: { idType: '02', id: 'DE123456789' } });
    const usa = ok({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: US, lineas: [l(300, 0, 0)] });
    expect(usa.cuerpo.desglose[0]).toMatchObject({ claveRegimen: '01', calificacionOperacion: 'N2' });
    expect(usa.cuerpo.destinatarios?.[0]).toMatchObject({ idOtro: { codigoPais: 'US', idType: '04' } });
  });

  it('servicios a Canarias: 08/N2 y el cliente con su NIF', () => {
    const a = ok({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: CANARIAS, lineas: [l(300, 0, 0)] });
    expect(a.cuerpo.desglose[0]).toEqual({ impuesto: '01', claveRegimen: '08', calificacionOperacion: 'N2', baseImponible: '300.00' });
    expect(a.cuerpo.destinatarios).toEqual([{ nombre: CANARIAS.nombre, nif: 'B12345674' }]);
  });

  it('EXENTA: E1, E4 y E6 con la clave 01; E3 con la 02', () => {
    for (const causa of ['E1', 'E4', 'E6']) {
      const a = ok({ tipoOperacion: 'EXENTA', causaExencion: causa, lineas: [l(100, 0, 0)] });
      expect(a.cuerpo.desglose[0]).toEqual({ impuesto: '01', claveRegimen: '01', operacionExenta: causa, baseImponible: '100.00' });
    }
    const e3 = ok({ tipoOperacion: 'EXENTA', causaExencion: 'E3', lineas: [l(100, 0, 0)] });
    expect(e3.cuerpo.desglose[0]).toMatchObject({ claveRegimen: '02', operacionExenta: 'E3' });
  });

  it('ISP: S2 con tipo y cuota a «0.00»', () => {
    const a = ok({ tipoOperacion: 'ISP_NACIONAL', lineas: [l(1000, 0, 0)] });
    expect(a.cuerpo.desglose[0]).toEqual({
      impuesto: '01',
      claveRegimen: '01',
      calificacionOperacion: 'S2',
      tipoImpositivo: '0.00',
      baseImponible: '1000.00',
      cuotaRepercutida: '0.00',
    });
    expect(a.cuotaTotal).toBe('0.00');
  });

  it('criterio de caja: clave 07', () => {
    const a = ok({ criterioCaja: true });
    expect(a.cuerpo.desglose[0]).toMatchObject({ claveRegimen: '07', calificacionOperacion: 'S1' });
  });

  it('F2: sin destinatarios aunque la factura tenga cliente', () => {
    const a = ok({ tipoFactura: 'F2', lineas: [l(50, 21)] });
    expect(a.cuerpo.destinatarios).toBeUndefined();
    expect(a.tipoFactura).toBe('F2');
  });

  it('R1 por diferencias: importes en negativo, TipoRectificativa I y FacturasRectificadas', () => {
    const a = ok({
      tipoFactura: 'R1',
      tipoRectificativa: 'I',
      numeroCompleto: 'R-1',
      motivoRectificacion: 'Devolución de la mitad',
      lineas: [l(-100, 21, -21)],
      rectificadas: [{ tipo: 'APP', numeroCompleto: 'A-1', fechaEmision: '2027-01-02', fechaOperacion: null, tipoOperacion: 'NACIONAL', lineas: [l(200, 21)], desgloseRegistro: null }],
    });
    expect(a.importeTotal).toBe('-121.00');
    expect(a.cuotaTotal).toBe('-21.00');
    expect(a.cuerpo.tipoRectificativa).toBe('I');
    expect(a.cuerpo.importeRectificacion).toBeUndefined();
    expect(a.cuerpo.facturasRectificadas).toEqual([{ idEmisor: NIF, numSerie: 'A-1', fecha: '02-01-2027' }]);
    expect(a.cuerpo.descripcionOperacion).toBe('Rectificación: Devolución de la mitad');
    expect(a.cuerpo.destinatarios).toHaveLength(1);
  });

  it('R1 por sustitución: ImporteRectificacion con la base y la cuota de la ORIGINAL', () => {
    const desgloseRegistro: DetalleDesglose[] = [
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '1000.00', cuotaRepercutida: '210.00' },
    ];
    const base = {
      tipoFactura: 'R1',
      tipoRectificativa: 'S',
      numeroCompleto: 'R-2',
      motivoRectificacion: 'Precio mal',
      lineas: [l(800, 21)],
    };
    // Con registro de alta: la suma de su desglose.
    const conRegistro = ok({
      ...base,
      rectificadas: [{ tipo: 'APP', numeroCompleto: 'A-2', fechaEmision: '2027-01-02', fechaOperacion: null, tipoOperacion: 'NACIONAL', lineas: [l(999, 21)], desgloseRegistro }],
    });
    expect(conRegistro.cuerpo.importeRectificacion).toEqual({ base: '1000.00', cuota: '210.00' });
    expect(conRegistro.importeTotal).toBe('968.00');
    // Sin registro (anterior a la activación): con la misma regla, sin suplidos.
    const sinRegistro = ok({
      ...base,
      rectificadas: [{ tipo: 'APP', numeroCompleto: 'A-2', fechaEmision: '2027-01-02', fechaOperacion: null, tipoOperacion: 'NACIONAL', lineas: [l(1000, 21), l(30, 0, 0)], desgloseRegistro: null }],
    });
    expect(sinRegistro.cuerpo.importeRectificacion).toEqual({ base: '1000.00', cuota: '210.00' });
  });

  it('R5 sobre una F2: sin destinatarios', () => {
    const a = ok({
      tipoFactura: 'R5',
      tipoRectificativa: 'I',
      numeroCompleto: 'RT-1',
      lineas: [l(-10, 21, -2.1)],
      rectificadas: [{ tipo: 'APP', numeroCompleto: 'A-3', fechaEmision: '2027-01-02', fechaOperacion: null, tipoOperacion: 'NACIONAL', lineas: [l(10, 21)], desgloseRegistro: null }],
    });
    expect(a.cuerpo.destinatarios).toBeUndefined();
    expect(a.cuerpo.tipoRectificativa).toBe('I');
  });

  it('originales de fuera se citan; las de periodo y las de número inválido no (con aviso)', () => {
    const a = ok({
      tipoFactura: 'R1',
      tipoRectificativa: 'I',
      numeroCompleto: 'R-3',
      lineas: [l(-10, 21)],
      rectificadas: [
        { tipo: 'FUERA', numero: 'F2026/0012', fecha: '2026-11-30' },
        { tipo: 'PERIODO', periodoHasta: '2026-12-31' },
        { tipo: 'FUERA', numero: 'F<12>', fecha: '2026-11-30' },
      ],
    });
    expect(a.cuerpo.facturasRectificadas).toEqual([{ idEmisor: NIF, numSerie: 'F2026/0012', fecha: '30-11-2026' }]);
    expect(a.cuerpo.avisos?.[0]).toMatch(/F<12>/);
  });

  it('Macrodato «S» desde 100.000.000 €', () => {
    const a = ok({ lineas: [l(100_000_000, 21)] });
    expect(a.cuerpo.macrodato).toBe('S');
    expect(ok().cuerpo.macrodato).toBeUndefined();
  });

  it('FechaOperacion solo si es distinta de la de expedición', () => {
    expect(ok({ fechaOperacion: '2026-12-20' }).cuerpo.fechaOperacion).toBe('20-12-2026');
    expect(ok({ fechaOperacion: '2027-01-04' }).cuerpo.fechaOperacion).toBeUndefined();
  });

  it('rectificativa: FechaOperacion de la original (la más reciente si son varias), no la suya', () => {
    const app = (numero: string, fechaEmision: string, fechaOperacion: string | null = null): EntradaAlta['rectificadas'][number] => ({
      tipo: 'APP',
      numeroCompleto: numero,
      fechaEmision,
      fechaOperacion,
      tipoOperacion: 'NACIONAL',
      lineas: [l(100, 21)],
      desgloseRegistro: null,
    });
    const r = (rectificadas: EntradaAlta['rectificadas'], extra: Partial<EntradaAlta> = {}) =>
      ok({ tipoFactura: 'R1', tipoRectificativa: 'I', numeroCompleto: 'R-9', lineas: [l(-10, 21)], rectificadas, ...extra });
    // Original de la app: su fecha de operacion o, si no la tiene, la de expedicion.
    expect(r([app('A-1', '2026-12-10')]).cuerpo.fechaOperacion).toBe('10-12-2026');
    expect(r([app('A-1', '2026-12-10', '2026-11-30')]).cuerpo.fechaOperacion).toBe('30-11-2026');
    // Varias: la mas reciente; de fuera, su fecha; de un periodo, su ultimo dia.
    expect(r([app('A-1', '2026-10-01'), { tipo: 'FUERA', numero: 'F-7', fecha: '2026-12-15' }, app('A-2', '2026-11-03')]).cuerpo.fechaOperacion).toBe('15-12-2026');
    expect(r([{ tipo: 'PERIODO', periodoHasta: '2026-12-31' }]).cuerpo.fechaOperacion).toBe('31-12-2026');
    // La fecha de operacion propia de la rectificativa (devengo para el 303) no cuenta.
    expect(r([app('A-1', '2026-12-10')], { fechaOperacion: '2027-01-02' }).cuerpo.fechaOperacion).toBe('10-12-2026');
    // Original del mismo dia que la rectificativa: no se informa.
    expect(r([app('A-1', '2027-01-04')]).cuerpo.fechaOperacion).toBeUndefined();
  });

  it('DescripcionOperacion: la de la factura; si no, las líneas unidas, recortadas a 500', () => {
    expect(ok({ descripcionOperacion: '  Consultoría de enero ' }).cuerpo.descripcionOperacion).toBe('Consultoría de enero');
    expect(ok({ lineas: [l(10, 21, 2.1, 'Uno'), l(20, 21, 4.2, 'Dos')] }).cuerpo.descripcionOperacion).toBe('Uno; Dos');
    const larga = ok({ lineas: [l(10, 21, 2.1, 'x'.repeat(300)), l(20, 21, 4.2, 'y'.repeat(300))] }).cuerpo.descripcionOperacion;
    expect(larga).toHaveLength(500);
  });

  it('los importes salen de las líneas en la moneda de cuenta (una factura en USD lleva sus euros)', () => {
    // Las líneas ya vienen en EUR (columnas de cuenta): 1.149 USD a 1,149 = 1.000 EUR.
    const a = ok({ lineas: [l(1000, 21)] });
    expect(a.importeTotal).toBe('1210.00');
  });
});

describe('construirAlta: errores internos y de importes', () => {
  it('si el desglose no cuadra con los totales de la factura, 500 y nada', () => {
    rechaza(() => construirAlta(entrada({ baseTotal: 99 })), 'VERIFACTU_DESCUADRE', 500);
    rechaza(() => construirAlta(entrada({ ivaTotal: 20 })), 'VERIFACTU_DESCUADRE', 500);
  });

  it('un importe de más de 12 cifras: 422', () => {
    rechaza(() => construirAlta(entrada({ lineas: [l(1_000_000_000_000, 21)] })), 'VERIFACTU_IMPORTE_GRANDE');
  });

  it('IVA en una operación que no lo lleva: 422', () => {
    rechaza(() => construirAlta(entrada({ tipoOperacion: 'EXPORTACION', cliente: US, lineas: [l(100, 21)] })), 'VERIFACTU_IVA_EN_OPERACION_SIN_IVA');
  });

  it('EMPRESA_EXTRANJERA no genera registro', () => {
    expect(() => construirAlta(entrada({ tipoOperacion: 'EMPRESA_EXTRANJERA', lineas: [l(100, 0, 0)] }))).toThrow(/no genera registro/);
  });
});

describe('validarAlta: lo que la AEAT rechazaría', () => {
  const alta = (e: Partial<EntradaAlta> = {}) => construirAlta(entrada(e));

  it('NIF del emisor sin 9 caracteres, no válido o distinto del congelado', () => {
    rechaza(() => valida(alta({ nifObligado: 'A1095236' })), 'VERIFACTU_NIF_EMISOR');
    rechaza(() => valida(alta({ nifObligado: 'A10952365' })), 'VERIFACTU_NIF_EMISOR');
    rechaza(() => validarAlta(alta(), { nifObligado: 'B12345674', ahora: AHORA }), 'VERIFACTU_NIF_EMISOR');
  });

  it('nombre del emisor vacío o de más de 120', () => {
    rechaza(() => valida(alta({ emisor: { nombre: ' ' } })), 'VERIFACTU_NOMBRE_EMISOR');
    rechaza(() => valida(alta({ emisor: { nombre: 'x'.repeat(121) } })), 'VERIFACTU_NOMBRE_EMISOR');
  });

  it('NumSerieFactura: 1-60 caracteres ASCII imprimibles, sin " \' < > = &', () => {
    for (const n of ['A&1', 'A"1', "A'1", 'A`1', 'A<1', 'A>1', 'A=1', 'Ñ-1', 'x'.repeat(61), ' ']) {
      rechaza(() => valida(alta({ numeroCompleto: n })), 'VERIFACTU_NUMERO_SERIE');
    }
    valida(alta({ numeroCompleto: '2027/A-001 (bis)' }));
  });

  it('fecha de expedición posterior a hoy o anterior al 28-10-2024', () => {
    rechaza(() => valida(alta({ fechaEmision: '2027-01-05' })), 'VERIFACTU_FECHA_EXPEDICION');
    rechaza(() => valida(alta({ fechaEmision: '2024-10-27' })), 'VERIFACTU_FECHA_EXPEDICION');
    valida(alta({ fechaEmision: '2024-10-28' }));
  });

  it('FechaOperacion posterior a la de expedición o de hace más de 20 años', () => {
    rechaza(() => valida(alta({ fechaOperacion: '2027-01-05', fechaEmision: '2027-01-04' })), 'VERIFACTU_FECHA_OPERACION');
    rechaza(() => valida(alta({ fechaOperacion: '2006-12-31' })), 'VERIFACTU_FECHA_OPERACION');
  });

  it('TipoRectificativa si y solo si R1-R5; ImporteRectificacion si y solo si S', () => {
    rechaza(() => valida(alta({ tipoFactura: 'R1', tipoRectificativa: null, lineas: [l(-10, 21)] })), 'VERIFACTU_TIPO_RECTIFICATIVA');
    const f1 = alta();
    f1.cuerpo.tipoRectificativa = 'I';
    rechaza(() => valida(f1), 'VERIFACTU_TIPO_RECTIFICATIVA');
    const i = alta({ tipoFactura: 'R1', tipoRectificativa: 'I', lineas: [l(-10, 21)] });
    i.cuerpo.importeRectificacion = { base: '1.00', cuota: '0.21' };
    rechaza(() => valida(i), 'VERIFACTU_IMPORTE_RECTIFICACION');
    const s = alta({
      tipoFactura: 'R1',
      tipoRectificativa: 'S',
      lineas: [l(10, 21)],
      rectificadas: [{ tipo: 'APP', numeroCompleto: 'A-1', fechaEmision: '2027-01-02', fechaOperacion: null, tipoOperacion: 'NACIONAL', lineas: [l(20, 21)], desgloseRegistro: null }],
    });
    delete s.cuerpo.importeRectificacion;
    rechaza(() => valida(s), 'VERIFACTU_IMPORTE_RECTIFICACION');
  });

  it('cliente español sin NIF válido en F1 y R1-R4: 422 VERIFACTU_CLIENTE_SIN_NIF con la salida de la simplificada en F1', () => {
    const sinNif = { ...ES, nifCif: 'B12345678' };
    try {
      valida(alta({ cliente: sinNif }));
      throw new Error('no rechazó');
    } catch (e) {
      expect(e).toMatchObject({ statusCode: 422, details: { codigo: 'VERIFACTU_CLIENTE_SIN_NIF' } });
      expect((e as Error).message).toMatch(/simplificada/);
      // El limite general de la simplificada es de 400 € (art. 4.1.a RD 1619/2012); 3.000 € solo en las actividades del art. 4.2.
      expect((e as Error).message).toMatch(/en general hasta 400 €/);
    }
    rechaza(() => valida(alta({ tipoFactura: 'R4', tipoRectificativa: 'I', cliente: sinNif, lineas: [l(-10, 21)] })), 'VERIFACTU_CLIENTE_SIN_NIF');
    // En una F2 no hace falta.
    valida(alta({ tipoFactura: 'F2', cliente: sinNif }));
  });

  it('destinatarios prohibidos en F2 y R5', () => {
    const f2 = alta({ tipoFactura: 'F2' });
    f2.cuerpo.destinatarios = [{ nombre: 'X', nif: 'B12345674' }];
    rechaza(() => valida(f2), 'VERIFACTU_DESTINATARIO_PROHIBIDO');
  });

  it('extranjero sin identificación o con más de 20 caracteres', () => {
    rechaza(() => valida(alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: { ...US, nifCif: '' }, lineas: [l(10, 0, 0)] })), 'VERIFACTU_CLIENTE_SIN_IDENTIFICACION');
    rechaza(() => valida(alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: { ...US, nifCif: '1'.repeat(21) }, lineas: [l(10, 0, 0)] })), 'VERIFACTU_ID_DESTINATARIO_LARGO');
  });

  it('cliente con el mismo NIF que la empresa (error 1193)', () => {
    rechaza(() => valida(alta({ cliente: { ...ES, nifCif: NIF } })), 'VERIFACTU_CLIENTE_ES_EMISOR');
  });

  it('IDOtro: 02 sin CodigoPais y con la estructura de su Estado; 04 con un país de la lista del XSD; R2 sin 04', () => {
    rechaza(() => valida(alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: { ...DE, nifCif: 'DE12345678' }, lineas: [l(10, 0, 0)] })), 'VERIFACTU_NIF_IVA');
    rechaza(() => valida(alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: { ...US, pais: 'XK' }, lineas: [l(10, 0, 0)] })), 'VERIFACTU_PAIS_CLIENTE');
    rechaza(() => valida(alta({ tipoFactura: 'R2', tipoRectificativa: 'I', tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: US, lineas: [l(-10, 0, 0)] })), 'VERIFACTU_R2_DESTINATARIO');
    valida(alta({ tipoFactura: 'R2', tipoRectificativa: 'I', tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: DE, lineas: [l(-10, 0, 0)] }));
    // Defensa: un IDOtro 02 con CodigoPais no pasa (error 1122 con EL o XI).
    const a = alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: DE, lineas: [l(10, 0, 0)] });
    (a.cuerpo.destinatarios![0] as { idOtro: { codigoPais?: string } }).idOtro.codigoPais = 'DE';
    rechaza(() => valida(a), 'VERIFACTU_NIF_IVA');
    // Grecia (EL) e Irlanda del Norte (XI) con su estructura: pasan, sin CodigoPais.
    const gr = ok({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: { nombre: 'Etaireia AE', pais: 'GR', nifCif: 'EL123456789', cp: '10431' }, lineas: [l(10, 0, 0)] });
    expect(gr.cuerpo.destinatarios?.[0]).toEqual({ nombre: 'Etaireia AE', idOtro: { idType: '02', id: 'EL123456789' } });
    const xi = ok({ tipoOperacion: 'INTRACOMUNITARIA', cliente: { nombre: 'Belfast Ltd', pais: 'GB', nifCif: 'XI123456789', cp: 'BT1' }, lineas: [l(10, 0, 0)] });
    expect(xi.cuerpo.destinatarios?.[0]).toEqual({ nombre: 'Belfast Ltd', idOtro: { idType: '02', id: 'XI123456789' } });
  });

  it('E5 sin IDOtro (intracomunitaria a un cliente con NIF español)', () => {
    rechaza(() => valida(alta({ tipoOperacion: 'INTRACOMUNITARIA', cliente: ES, lineas: [l(10, 0, 0)] })), 'VERIFACTU_E5_SIN_IDOTRO');
  });

  it('una rectificativa de una factura al 5 % (sept. 2024) o al 7,5 % (4T 2024) lleva ese tipo: la fecha que cuenta es la de la original', () => {
    const original = (fechaEmision: string, tipo: number) => ({
      tipo: 'APP' as const,
      numeroCompleto: 'A-1',
      fechaEmision,
      fechaOperacion: null,
      tipoOperacion: 'NACIONAL' as const,
      lineas: [l(100, tipo)],
      desgloseRegistro: null,
    });
    const rect = (fechaEmision: string, tipo: number) =>
      alta({ tipoFactura: 'R1', tipoRectificativa: 'I', numeroCompleto: 'R-1', lineas: [l(-50, tipo)], rectificadas: [original(fechaEmision, tipo)] });
    const r5 = rect('2024-09-30', 5);
    expect(r5.cuerpo.fechaOperacion).toBe('30-09-2024');
    valida(r5);
    valida(rect('2024-11-15', 7.5));
    // Con la original fuera de la ventana, la AEAT no lo admite.
    rechaza(() => valida(rect('2024-10-15', 5)), 'VERIFACTU_TIPO_IMPOSITIVO');
  });

  it('S1 con un tipo que la AEAT no admite; el 5 % solo en su ventana de 2022-2024', () => {
    rechaza(() => valida(alta({ lineas: [l(100, 5)] })), 'VERIFACTU_TIPO_IMPOSITIVO');
    rechaza(() => valida(alta({ lineas: [l(100, 12)] })), 'VERIFACTU_TIPO_IMPOSITIVO');
    valida(alta({ lineas: [l(100, 5)], fechaOperacion: '2024-09-15', fechaEmision: '2024-11-04' }));
    valida(alta({ lineas: [l(100, 4)] }));
  });

  it('S1: cuota fuera de base × tipo ± 10 € o con distinto signo (salvo I, R2 y R3)', () => {
    rechaza(() => valida(alta({ lineas: [l(1000, 21, 230)] })), 'VERIFACTU_CUOTA');
    rechaza(() => valida(alta({ lineas: [l(1000, 21, -210)] })), 'VERIFACTU_CUOTA');
    valida(alta({ lineas: [l(1000, 21, 215)] }));
    // Por diferencias no se comprueba.
    valida(alta({ tipoFactura: 'R1', tipoRectificativa: 'I', lineas: [l(-1000, 21, 50)] }));
  });

  it('S2 con tipo o cuota distintos de 0, o en una F2', () => {
    const a = alta({ tipoOperacion: 'ISP_NACIONAL', lineas: [l(100, 0, 0)] });
    a.cuerpo.desglose[0].cuotaRepercutida = '1.00';
    rechaza(() => valida(a), 'VERIFACTU_S2');
    rechaza(() => valida(alta({ tipoOperacion: 'ISP_NACIONAL', tipoFactura: 'F2', lineas: [l(100, 0, 0)] })), 'VERIFACTU_S2');
  });

  it('tipo o cuota en N2 o en una exenta', () => {
    const a = alta({ tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: US, lineas: [l(100, 0, 0)] });
    a.cuerpo.desglose[0].tipoImpositivo = '21.00';
    rechaza(() => valida(a), 'VERIFACTU_DESGLOSE');
  });

  it('claves de régimen: 01 con E2/E3, 02 sin exención, 07 con N2, 08 sin N2', () => {
    const con = (cambio: Partial<DetalleDesglose>, e: Partial<EntradaAlta>) => {
      const a = alta(e);
      Object.assign(a.cuerpo.desglose[0], cambio);
      return a;
    };
    const exenta = { tipoOperacion: 'EXENTA' as const, causaExencion: 'E3', lineas: [l(100, 0, 0)] };
    rechaza(() => valida(con({ claveRegimen: '01' }, exenta)), 'VERIFACTU_CLAVE_REGIMEN');
    rechaza(() => valida(con({ claveRegimen: '02' }, {})), 'VERIFACTU_CLAVE_REGIMEN');
    const n2 = { tipoOperacion: 'SERVICIOS_EXTRANJERO' as const, cliente: US, lineas: [l(100, 0, 0)] };
    rechaza(() => valida(con({ claveRegimen: '07' }, n2)), 'VERIFACTU_CLAVE_REGIMEN');
    rechaza(() => valida(con({ claveRegimen: '08' }, {})), 'VERIFACTU_CLAVE_REGIMEN');
  });

  it('F2 de más de 3.010 €', () => {
    rechaza(() => valida(alta({ tipoFactura: 'F2', lineas: [l(2500, 21)] })), 'VERIFACTU_F2_LIMITE');
    valida(alta({ tipoFactura: 'F2', lineas: [l(2487, 21)] }));
  });

  it('desglose vacío (solo suplidos) o de más de 12 líneas', () => {
    rechaza(() => valida(alta({ lineas: [l(50, 0, 0)] })), 'VERIFACTU_DESGLOSE_VACIO');
    const a = alta();
    a.cuerpo.desglose = Array.from({ length: 13 }, () => ({ ...a.cuerpo.desglose[0] }));
    a.control.tipos = Array.from({ length: 13 }, () => 21);
    rechaza(() => valida(a), 'VERIFACTU_DESGLOSE_LARGO');
  });

  it('DescripcionOperacion fuera de 1-500', () => {
    const a = alta();
    a.cuerpo.descripcionOperacion = 'x'.repeat(501);
    rechaza(() => valida(a), 'VERIFACTU_DESCRIPCION');
    a.cuerpo.descripcionOperacion = ' ';
    rechaza(() => valida(a), 'VERIFACTU_DESCRIPCION');
  });
});

describe('problemaDestinatario (comprobación previa)', () => {
  it('F2/R5 nunca; ES sin NIF válido; extranjero sin identificación', () => {
    expect(problemaDestinatario('F2', { pais: 'ES', nifCif: '' })).toBeNull();
    expect(problemaDestinatario('R5', { pais: 'ES', nifCif: '' })).toBeNull();
    expect(problemaDestinatario('F1', ES)).toBeNull();
    expect(problemaDestinatario('F1', { pais: 'ES', nifCif: 'ESB12345674' })).toBeNull();
    expect(problemaDestinatario('F1', { pais: 'ES', nifCif: '12345' })).toMatchObject({ codigo: 'VERIFACTU_CLIENTE_SIN_NIF' });
    expect(problemaDestinatario('R1', { pais: 'ES', nifCif: '' })).toMatchObject({ codigo: 'VERIFACTU_CLIENTE_SIN_NIF', mensaje: expect.stringMatching(/rectificativa/) });
    expect(problemaDestinatario('F1', { pais: 'US', nifCif: '' })).toMatchObject({ codigo: 'VERIFACTU_CLIENTE_SIN_IDENTIFICACION' });
    expect(problemaDestinatario('F1', FR)).toBeNull();
  });

  it('NIF-IVA con la estructura de su Estado, país de la lista del XSD y R2 sin IDType 04', () => {
    expect(problemaDestinatario('F1', { pais: 'DE', nifCif: 'DE12345678' })).toMatchObject({ codigo: 'VERIFACTU_NIF_IVA', mensaje: expect.stringMatching(/DE seguido de 9 cifras/) });
    expect(problemaDestinatario('F1', { pais: 'FR', nifCif: 'FR1234567890' })).toMatchObject({ codigo: 'VERIFACTU_NIF_IVA' });
    expect(problemaDestinatario('F1', { pais: 'GR', nifCif: 'EL123456789' })).toBeNull();
    expect(problemaDestinatario('F1', { pais: 'XK', nifCif: '810123456' })).toMatchObject({ codigo: 'VERIFACTU_PAIS_CLIENTE' });
    expect(problemaDestinatario('F1', { pais: 'XI', nifCif: '123' })).toMatchObject({ codigo: 'VERIFACTU_PAIS_CLIENTE' });
    expect(problemaDestinatario('F1', { pais: 'US', nifCif: '12-3456789' })).toBeNull();
    expect(problemaDestinatario('R2', { pais: 'US', nifCif: '12-3456789' })).toMatchObject({ codigo: 'VERIFACTU_R2_DESTINATARIO' });
    expect(problemaDestinatario('R2', FR)).toBeNull();
    expect(problemaDestinatario('R2', ES)).toBeNull();
  });
});

describe('paises y NIF-IVA de la AEAT', () => {
  it('la lista es la de CountryType2 del XSD (246 códigos): sin XI, EL ni XK', () => {
    expect(PAISES_AEAT.size).toBe(246);
    for (const p of ['ES', 'FR', 'GR', 'GB', 'US', 'XG', 'QU']) expect(PAISES_AEAT.has(p)).toBe(true);
    for (const p of ['XI', 'EL', 'XK', 'UK']) expect(PAISES_AEAT.has(p)).toBe(false);
  });

  it('estructura del NIF-IVA por Estado (nota (1) de las Validaciones v1.2.2)', () => {
    for (const ok of ['DE123456789', 'ATU12345678', 'BE0123456789', 'CZ12345678', 'CZ1234567890', 'FR1A345678901', 'IE1234567T', 'NL123456789B01', 'LT123456789012', 'RO12', 'XI12345', 'XI123456789012']) {
      expect([ok, problemaNifIvaAeat(ok)]).toEqual([ok, null]);
    }
    for (const mal of ['DE12345678', 'BE123456789', 'FR123', 'RO0123', 'RO12345678901', 'XI1234', 'ES12345678Z', 'GB123456789']) {
      expect(problemaNifIvaAeat(mal)).not.toBeNull();
    }
  });
});

describe('Sistema informático', () => {
  it('constantes, número de instalación por empresa e IndicadorMultiplesOT', () => {
    expect(numeroInstalacionDe('cm1abc')).toBe('CONTA-cm1abc');
    const s = sistemaInformatico({ numeroInstalacion: 'CONTA-cm1abc', multiplesOT: true });
    expect(s).toMatchObject({
      nombreSistemaInformatico: 'Conta API',
      idSistemaInformatico: 'CA',
      version: '0.1.0',
      nif: 'A10952364',
      tipoUsoPosibleSoloVerifactu: 'S',
      tipoUsoPosibleMultiOT: 'S',
      indicadorMultiplesOT: 'S',
    });
    expect(s.idSistemaInformatico).toMatch(/^[A-Z0-9]{2}$/);
    expect(sistemaInformatico({ numeroInstalacion: 'x', multiplesOT: false }).indicadorMultiplesOT).toBe('N');
    expect(() => numeroInstalacionDe('x'.repeat(95))).toThrow();
  });
});
