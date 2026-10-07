// PDF de la factura en divisa, por tipo de operacion y de empresas no espanolas:
// textos puros (bloque de divisa, mencion legal, cuenta de cobro) y que el
// documento se dibuja en cada caso. Sin BD.
import {
  elegirCuentaCobro,
  facturaConIva,
  fraseDivisa,
  mencionDocumento,
  renderizarFactura,
  type DatosFacturaPdf,
} from '../services/facturaPdf.service';

type Cliente = DatosFacturaPdf['cliente'];
type Emisor = NonNullable<DatosFacturaPdf['emisor']>;
const cli = (c: Partial<Cliente> & { nombreFiscal: string }): Cliente => ({
  nifCif: null,
  direccion: null,
  cp: null,
  municipio: null,
  provincia: null,
  pais: null,
  ...c,
});
const emi = (e: Partial<Emisor>): Emisor => ({
  denominacion: null,
  nif: null,
  domicilioSocial: null,
  codigoPostal: null,
  municipio: null,
  provincia: null,
  ...e,
});

const base = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf => ({
  id: 'f1',
  numeroCompleto: '2026-A-0043',
  estadoDocumento: 'FINAL',
  tipoFactura: 'F1',
  formaPago: 'TRANSFERENCIA',
  tipoRectificativa: null,
  motivoRectificacion: null,
  esRectificativa: false,
  fechaEmision: '2026-10-06',
  fechaVencimiento: '2026-11-05',
  baseTotal: 1000,
  ivaTotal: 210,
  retencionTotal: 0,
  totalFactura: 1210,
  observaciones: null,
  lineas: [
    {
      descripcion: 'Servicio',
      cantidad: 1,
      precioUnitario: 1000,
      descuentoPorcentaje: 0,
      tipoIva: 21,
      ivaImporte: 210,
      baseLine: 1000,
      tipoRetencion: 0,
    },
  ],
  cliente: cli({ nombreFiscal: 'Cliente, S.L.', nifCif: 'B46123456', pais: 'ES' }),
  emisor: emi({ denominacion: 'Emisor, S.L.', nif: 'B98765432', pais: 'ES' }),
  original: null,
  cuenta: { iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX' },
  moneda: 'EUR',
  monedaCuenta: 'EUR',
  tipoCambio: 1,
  fuenteTipoCambio: 'PAR',
  ...extra,
});

const enUsd = (extra: Partial<DatosFacturaPdf> = {}): DatosFacturaPdf =>
  base({
    moneda: 'USD',
    tipoCambio: 1.149,
    fechaTipoCambio: '2026-09-21',
    fuenteTipoCambio: 'BCE',
    contravalor: { base: 870.32, iva: 182.77, retencion: 0, total: 1053.09, desglose: [{ tipoIva: 21, base: 870.32, cuota: 182.77 }] },
    ...extra,
  });

const sinIva = {
  baseTotal: 8900,
  ivaTotal: 0,
  totalFactura: 8900,
  lineas: [{ descripcion: 'Design', cantidad: 1, precioUnitario: 8900, descuentoPorcentaje: 0, tipoIva: 0, ivaImporte: 0, baseLine: 8900, tipoRetencion: 0 }],
};

describe('fraseDivisa', () => {
  it('en la moneda de la contabilidad no hay bloque', () => {
    expect(fraseDivisa(base(), 'es')).toBe('');
  });

  it('factura emitida en USD: tipo, fuente y cuota en euros (art. 12.1 RD 1619/2012)', () => {
    const t = fraseDivisa(enUsd(), 'es');
    expect(t).toContain('dólares estadounidenses (USD)');
    expect(t).toContain('1 EUR = 1,1490 USD (referencia BCE de 21/09/2026)');
    expect(t).toContain('art. 12.1 del RD 1619/2012');
  });

  it('tipo manual y heredado', () => {
    expect(fraseDivisa(enUsd({ fuenteTipoCambio: 'MANUAL' }), 'es')).toContain('tipo indicado por el emisor');
    const r = enUsd({ fuenteTipoCambio: 'HEREDADO', original: { numeroCompleto: '2026-A-0015', fechaEmision: '2026-09-01' } });
    expect(fraseDivisa(r, 'es')).toContain('el de la factura rectificada 2026-A-0015');
  });

  it('borrador o proforma: contravalor orientativo; sin tipo, se calcula al emitir', () => {
    expect(fraseDivisa(enUsd({ estadoDocumento: 'BORRADOR' }), 'es')).toContain('orientativo');
    expect(fraseDivisa(enUsd({ estadoDocumento: 'PROFORMA', fuenteTipoCambio: 'PENDIENTE', tipoCambio: null }), 'es')).toContain(
      'se calcula al emitir',
    );
  });

  it('sin cuota (exportacion) no habla de la cuota en euros', () => {
    const t = fraseDivisa(enUsd({ ...sinIva, tipoOperacion: 'EXPORTACION' }), 'es');
    expect(t).toContain('1 EUR = 1,1490 USD');
    expect(t).not.toContain('Cuota de IVA');
  });
});

describe('mencionDocumento', () => {
  const fr = cli({ nombreFiscal: 'Boulangerie SARL', nifCif: 'FR40303265045', pais: 'FR' });
  const us = cli({ nombreFiscal: 'Coffee LLC', nifCif: '84-1234567', pais: 'US' });

  it('intracomunitaria: art. 25 en espanol y la frase en ingles para el cliente de fuera', () => {
    const m = mencionDocumento(base({ ...sinIva, tipoOperacion: 'INTRACOMUNITARIA', cliente: fr }));
    expect(m?.es).toContain('art. 25');
    expect(m?.en).toContain('intra-Community');
  });

  it('exportacion, servicios no sujetos, exenta e ISP', () => {
    expect(mencionDocumento(base({ ...sinIva, tipoOperacion: 'EXPORTACION', cliente: us }))?.es).toContain('art. 21');
    expect(mencionDocumento(base({ ...sinIva, tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: us }))?.es).toContain(
      'reglas de localización',
    );
    expect(mencionDocumento(base({ ...sinIva, tipoOperacion: 'SERVICIOS_EXTRANJERO', cliente: fr }))?.en).toContain(
      'Reverse charge',
    );
    const exenta = mencionDocumento(
      base({ ...sinIva, tipoOperacion: 'EXENTA', causaExencion: 'E1', referenciaLegal: 'art. 20.Uno.9.º Ley 37/1992 (enseñanza)' }),
    );
    expect(exenta?.es).toContain('art. 20.Uno.9.º');
    expect(exenta?.en).toBeNull(); // cliente espanol: solo en espanol
    expect(mencionDocumento(base({ ...sinIva, tipoOperacion: 'ISP_NACIONAL' }))?.es).toContain('Inversión del sujeto pasivo');
  });

  it('sin tipo (facturas de siempre), nacional o empresa extranjera: sin mencion', () => {
    expect(mencionDocumento(base())).toBeNull();
    expect(mencionDocumento(base({ tipoOperacion: 'NACIONAL' }))).toBeNull();
    expect(mencionDocumento(base({ ...sinIva, tipoOperacion: 'EMPRESA_EXTRANJERA', conIva: false }))).toBeNull();
  });
});

describe('elegirCuentaCobro', () => {
  const eur = { id: 'a', moneda: 'EUR' };
  const usd = { id: 'b', moneda: 'USD' };
  it('la primera en la moneda de la factura; si no hay, la primera', () => {
    expect(elegirCuentaCobro([eur, usd], 'USD')).toBe(usd);
    expect(elegirCuentaCobro([eur], 'USD')).toBe(eur);
    expect(elegirCuentaCobro([], 'USD')).toBeNull();
  });
});

describe('renderizarFactura', () => {
  const casos: Record<string, DatosFacturaPdf> = {
    'EUR nacional': base({ tipoOperacion: 'NACIONAL' }),
    'EUR sin tipo (anterior)': base(),
    'USD nacional emitida': enUsd({ tipoOperacion: 'NACIONAL' }),
    'USD exportacion': enUsd({
      ...sinIva,
      tipoOperacion: 'EXPORTACION',
      cliente: cli({ nombreFiscal: 'Coffee LLC', nifCif: '84-1234567', pais: 'US', municipio: 'Brooklyn', cp: 'NY 11249' }),
      contravalor: { base: 7745.87, iva: 0, retencion: 0, total: 7745.87, desglose: [{ tipoIva: 0, base: 7745.87, cuota: 0 }] },
    }),
    'USD proforma sin tipo': enUsd({ estadoDocumento: 'PROFORMA', numeroCompleto: 'P-3', fuenteTipoCambio: 'PENDIENTE', contravalor: null }),
    'empresa de EE. UU.': base({
      ...sinIva,
      emisor: emi({ denominacion: 'Albufera Design LLC', nif: '87-6543210', pais: 'US', municipio: 'Miami', codigoPostal: 'FL 33131' }),
      cliente: cli({ nombreFiscal: 'Hudson Bakery Inc.', nifCif: '13-9876543', pais: 'US' }),
      moneda: 'USD',
      monedaCuenta: 'USD',
      tipoOperacion: 'EMPRESA_EXTRANJERA',
      conIva: false,
    }),
    'empresa de Hong Kong, abono': base({
      baseTotal: -360,
      ivaTotal: 0,
      totalFactura: -360,
      lineas: [{ descripcion: 'Credit', cantidad: -2, precioUnitario: 180, descuentoPorcentaje: 0, tipoIva: 0, ivaImporte: 0, baseLine: -360, tipoRetencion: 0 }],
      tipoFactura: 'R1',
      esRectificativa: true,
      tipoRectificativa: 'I',
      emisor: emi({ denominacion: 'Albufera (HK) Ltd', nif: '76543210', pais: 'HK' }),
      moneda: 'USD',
      monedaCuenta: 'USD',
      tipoOperacion: 'EMPRESA_EXTRANJERA',
      conIva: false,
    }),
  };
  it.each(Object.entries(casos))('%s: genera un PDF', async (_n, datos) => {
    const pdf = await renderizarFactura(datos);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('una factura emitida conserva su IVA y su mencion aunque cambie el pais de la empresa', () => {
  it('con un tipo de operacion espanol, con IVA (y mencion) tambien en una empresa ya no espanola', () => {
    // Exportacion emitida cuando la empresa era espanola: sin cuota, pero con su mencion del art. 21.
    expect(facturaConIva('EXPORTACION', false, 0, [0])).toBe(true);
    expect(facturaConIva('INTRACOMUNITARIA', false, 0, [0])).toBe(true);
    const datos = base({
      ...sinIva,
      tipoOperacion: 'EXPORTACION',
      cliente: cli({ nombreFiscal: 'Coffee LLC', nifCif: '84-1234567', pais: 'US' }),
      emisor: emi({ denominacion: 'Exportadora SL', nif: 'B12345678', pais: 'US' }),
      conIva: facturaConIva('EXPORTACION', false, 0, [0]),
    });
    expect(mencionDocumento(datos)?.es).toMatch(/Exportación exenta de IVA \(art\. 21/);
  });
  it('y el PDF se dibuja', async () => {
    const pdf = await renderizarFactura(
      base({ ...sinIva, tipoOperacion: 'EXPORTACION', emisor: emi({ denominacion: 'Exportadora SL', nif: 'B12345678', pais: 'US' }), conIva: true }),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('sin IVA: las de una empresa no establecida en Espana; las anteriores, segun lleven IVA', () => {
    expect(facturaConIva('EMPRESA_EXTRANJERA', false, 0, [0])).toBe(false);
    expect(facturaConIva('EMPRESA_EXTRANJERA', true, 21, [21])).toBe(false);
    expect(facturaConIva(null, true, 0, [0])).toBe(true);
    expect(facturaConIva(null, false, 0, [0])).toBe(false);
    expect(facturaConIva(null, false, 21, [21])).toBe(true);
  });
});
