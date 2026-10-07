// Tipo de operacion de IVA (puro): la tabla unica de reglas, paises, la
// clasificacion de las facturas anteriores, la sugerencia y la revision.
import {
  desgloseVerifactu,
  destinatarioVerifactu,
  esPaisUe,
  fueraDelTai,
  inferirTipoOperacion,
  normalizarPais,
  operacionEfectiva,
  paisDelCliente,
  prefijoNifIvaUe,
  REGLA_OPERACION,
  resolverFiscalidadPura,
  revisarFiscalidad,
  sugerirTipoOperacion,
  tieneNifIvaUe,
  tipoOperacionLegacy,
  TIPOS_OPERACION_VENTA,
  TIPOS_SELECCIONABLES,
  validarFormatoNifIvaUe,
  type EntradaFiscal,
  type ModoFiscal,
} from '../domain/tipo-operacion.model';
import { clasificarOperacion } from '../services/impuestosCalculo.service';
import { esPaisEspana, formatearFecha, formatearImporte, formatoPorPais, idiomaPorPais } from '../domain/perfil-empresa.model';

const ES = { pais: 'ES', nifCif: 'B12345678', cp: '46001' };
const FR = { pais: 'FR', nifCif: 'FR12345678901', cp: '75001' };
const FR_SIN_PREFIJO = { pais: 'FR', nifCif: '12345678901', cp: '75001' };
const DE = { pais: 'DE', nifCif: 'DE123456789' };
const US = { pais: 'US', nifCif: '12-3456789' };
const CANARIAS = { pais: 'ES', nifCif: 'B35000000', cp: '35001' };

describe('tabla de reglas', () => {
  it('siete tipos; EMPRESA_EXTRANJERA no se puede elegir', () => {
    expect(TIPOS_OPERACION_VENTA).toHaveLength(7);
    expect(TIPOS_SELECCIONABLES).not.toContain('EMPRESA_EXTRANJERA');
    expect(TIPOS_SELECCIONABLES).toHaveLength(6);
  });

  it('cuota, retencion, casilla del 303, clave del 349 y Verifactu de cada tipo', () => {
    const ctx = (cliente: object, extra: object = {}) => ({ cliente, ...extra });
    const R = REGLA_OPERACION;
    expect(R.NACIONAL.llevaCuota).toBe(true);
    expect(R.NACIONAL.casilla303(ctx(ES, { tipoIva: 21 }))).toBe('07');
    expect(R.NACIONAL.casilla303(ctx(ES, { tipoIva: 10 }))).toBe('04');
    expect(R.NACIONAL.casilla303(ctx(ES, { tipoIva: 4 }))).toBe('01');
    expect(R.NACIONAL.casilla303(ctx(ES, { tipoIva: 5 }))).toBeNull();
    expect(R.NACIONAL.verifactu(ctx(ES))).toMatchObject({ calificacion: 'S1', claveRegimen: '01' });

    expect(R.INTRACOMUNITARIA.llevaCuota).toBe(false);
    expect(R.INTRACOMUNITARIA.admiteRetencion).toBe(false);
    expect(R.INTRACOMUNITARIA.casilla303(ctx(FR))).toBe('59');
    expect(R.INTRACOMUNITARIA.clave349(ctx(FR))).toBe('E');
    expect(R.INTRACOMUNITARIA.causaLibro(ctx(FR))).toBe('E5');

    expect(R.EXPORTACION.casilla303(ctx(US))).toBe('60');
    expect(R.EXPORTACION.clave349(ctx(US))).toBeNull();

    expect(R.SERVICIOS_EXTRANJERO.casilla303(ctx(DE))).toBe('59');
    expect(R.SERVICIOS_EXTRANJERO.clave349(ctx(DE))).toBe('S');
    expect(R.SERVICIOS_EXTRANJERO.casilla303(ctx(US))).toBe('120');
    expect(R.SERVICIOS_EXTRANJERO.clave349(ctx(US))).toBeNull();
    expect(R.SERVICIOS_EXTRANJERO.verifactu(ctx(US))).toMatchObject({ calificacion: 'N2' });

    expect(R.EXENTA.casilla303(ctx(ES, { causaExencion: 'E1' }))).toBeNull();
    expect(R.EXENTA.casilla303(ctx(ES, { causaExencion: 'E3' }))).toBe('60');
    expect(R.EXENTA.admiteRetencion).toBe(true);

    expect(R.ISP_NACIONAL.casilla303(ctx(ES))).toBe('122');
    expect(R.ISP_NACIONAL.verifactu(ctx(ES))).toMatchObject({ calificacion: 'S2', tipoYCuotaCero: true });

    expect(R.EMPRESA_EXTRANJERA.enLibroIva).toBe(false);
    expect(R.EMPRESA_EXTRANJERA.enModelos).toBe(false);
    expect(R.EMPRESA_EXTRANJERA.verifactu(ctx(US))).toBeNull();
    expect(R.EMPRESA_EXTRANJERA.mencion(ctx(US))).toBeNull();
  });

  it('menciones del PDF en espanol e ingles', () => {
    const m = (t: keyof typeof REGLA_OPERACION, cliente: object, extra: object = {}) => REGLA_OPERACION[t].mencion({ cliente, ...extra });
    expect(m('NACIONAL', ES)).toBeNull();
    expect(m('INTRACOMUNITARIA', FR)?.es).toMatch(/art\. 25\.Uno Ley 37\/1992/);
    expect(m('INTRACOMUNITARIA', FR)?.en).toMatch(/Art\. 138/);
    expect(m('EXPORTACION', US)?.es).toMatch(/art\. 21 Ley 37\/1992/);
    expect(m('SERVICIOS_EXTRANJERO', DE)?.en).toMatch(/Reverse charge/);
    expect(m('SERVICIOS_EXTRANJERO', US)?.es).toMatch(/reglas de localización/);
    expect(m('EXENTA', ES, { referenciaLegal: 'art. 20.Uno.9.º Ley 37/1992' })?.es).toBe(
      'Operación exenta de IVA – art. 20.Uno.9.º Ley 37/1992',
    );
    expect(m('ISP_NACIONAL', ES, { referenciaLegal: 'f)' })?.es).toBe('Inversión del sujeto pasivo (art. 84.Uno.2.º f) Ley 37/1992)');
    expect(m('ISP_NACIONAL', ES)?.es).toBe('Inversión del sujeto pasivo (art. 84.Uno.2.º Ley 37/1992)');
  });

  it('Verifactu: E5 con IDType 02, E2 con clave 02, S2 con 0/0', () => {
    expect(desgloseVerifactu('INTRACOMUNITARIA', { cliente: FR })).toMatchObject({ operacionExenta: 'E5', claveRegimen: '01' });
    expect(destinatarioVerifactu(FR)).toEqual({ idOtro: { codigoPais: 'FR', idType: '02', id: 'FR12345678901' } });
    expect(desgloseVerifactu('EXPORTACION', { cliente: US })).toMatchObject({ operacionExenta: 'E2', claveRegimen: '02' });
    expect(destinatarioVerifactu(US)).toEqual({ idOtro: { codigoPais: 'US', idType: '04', id: '123456789' } });
    expect(destinatarioVerifactu(ES)).toEqual({ nif: 'B12345678' });
    expect(desgloseVerifactu('EXENTA', { cliente: ES, causaExencion: 'E4' })).toMatchObject({ operacionExenta: 'E4' });
  });
});

describe('paises y NIF-IVA', () => {
  it('esPaisUe admite ISO-2, ISO-3 y EL (Espana es UE)', () => {
    expect(esPaisUe('FR')).toBe(true);
    expect(esPaisUe('FRA')).toBe(true);
    expect(esPaisUe('GR')).toBe(true);
    expect(esPaisUe('EL')).toBe(true);
    expect(esPaisUe('US')).toBe(false);
    expect(esPaisUe('ES')).toBe(true);
    expect(normalizarPais(' usa ')).toBe('US');
    expect(normalizarPais('UK')).toBe('GB');
  });

  it('prefijo del NIF-IVA y formato', () => {
    expect(prefijoNifIvaUe('EL123456789')).toEqual({ prefijo: 'EL', pais: 'GR' });
    expect(prefijoNifIvaUe('fr 12-345.678.901')).toEqual({ prefijo: 'FR', pais: 'FR' });
    expect(prefijoNifIvaUe('B12345678')).toBeNull();
    expect(validarFormatoNifIvaUe('DE123456789', 'DE')).toBe(true);
    expect(validarFormatoNifIvaUe('DE123456789', 'FR')).toBe(false);
    expect(validarFormatoNifIvaUe('GR123456789', 'GR')).toBe(false); // Grecia es EL
    expect(validarFormatoNifIvaUe('EL123456789', 'GR')).toBe(true);
    expect(tieneNifIvaUe(FR)).toBe(true);
    expect(tieneNifIvaUe(FR_SIN_PREFIJO)).toBe(false);
  });

  it('pais del cliente: el del prefijo si la ficha dice ES o nada', () => {
    expect(paisDelCliente({ pais: 'ES', nifCif: 'FR12345678901' })).toBe('FR');
    expect(paisDelCliente({ pais: '', nifCif: 'EL123456789' })).toBe('GR');
    expect(paisDelCliente({ pais: 'ES', nifCif: 'B12345678' })).toBe('ES');
    expect(paisDelCliente({ pais: 'USA', nifCif: 'X' })).toBe('US');
  });

  it('Canarias, Ceuta y Melilla estan fuera del TAI', () => {
    expect(fueraDelTai('ES', '35001')).toBe(true);
    expect(fueraDelTai('ES', '38200')).toBe(true);
    expect(fueraDelTai('ES', '51001')).toBe(true);
    expect(fueraDelTai('ES', '52001')).toBe(true);
    expect(fueraDelTai('ES', '46001')).toBe(false);
    expect(fueraDelTai('FR', '35001')).toBe(false);
  });
});

describe('facturas anteriores (tipoOperacion null): la clasificacion de siempre', () => {
  it('coincide con clasificarOperacion para cualquier pais y NIF', () => {
    const casos: Array<[string | undefined, string | undefined]> = [
      ['ES', 'B12345678'],
      ['ESP', 'B1'],
      ['FRA', 'FR1'],
      ['FR', 'FR12345678901'], // ISO-2: la tabla de siempre lo da como exportacion
      ['USA', '1'],
      ['US', '1'],
      ['', 'DE123'],
      ['', 'B12345678'],
      [undefined, 'EL123'],
      [undefined, undefined],
    ];
    const mapa = { interior: 'NACIONAL', intracomunitaria: 'INTRACOMUNITARIA', exportacion: 'EXPORTACION' } as const;
    for (const [pais, nif] of casos) {
      expect(tipoOperacionLegacy(pais, nif)).toBe(mapa[clasificarOperacion(pais, nif)]);
    }
  });

  it('operacionEfectiva: el tipo guardado manda; sin el, el de siempre', () => {
    expect(operacionEfectiva({ tipoOperacion: 'EXENTA' }, ES)).toBe('EXENTA');
    expect(operacionEfectiva({ tipoOperacion: null }, ES)).toBe('NACIONAL');
    expect(operacionEfectiva({ tipoOperacion: null }, { pais: 'FRA', nifCif: 'FR1' })).toBe('INTRACOMUNITARIA');
    expect(operacionEfectiva({ tipoOperacion: null }, { pais: 'USA', nifCif: '1' })).toBe('EXPORTACION');
    expect(operacionEfectiva({ tipoOperacion: 'RARO' }, ES)).toBe('NACIONAL');
  });
});

describe('inferencia y sugerencia', () => {
  it('inferirTipoOperacion para facturas nuevas sin tipo', () => {
    expect(inferirTipoOperacion(ES, [{ tipoIva: 21 }, { tipoIva: 10 }])).toBe('NACIONAL');
    expect(inferirTipoOperacion(US, [{ tipoIva: 21 }])).toBe('NACIONAL');
    expect(inferirTipoOperacion(FR, [{ tipoIva: 0 }])).toBe('INTRACOMUNITARIA');
    expect(inferirTipoOperacion(US, [{ tipoIva: 0 }])).toBe('EXPORTACION');
    expect(inferirTipoOperacion(ES, [{ tipoIva: 0 }])).toBeNull();
    expect(inferirTipoOperacion(FR_SIN_PREFIJO, [{ tipoIva: 0 }])).toBeNull();
    expect(inferirTipoOperacion(ES, [{ tipoIva: 21 }, { tipoIva: 0 }])).toBeNull();
  });

  it('sugerirTipoOperacion segun el cliente y el tipo de producto', () => {
    expect(sugerirTipoOperacion(ES).tipoOperacion).toBe('NACIONAL');
    expect(sugerirTipoOperacion(FR, ['PRODUCTO']).tipoOperacion).toBe('INTRACOMUNITARIA');
    expect(sugerirTipoOperacion(FR, ['SERVICIO']).tipoOperacion).toBe('SERVICIOS_EXTRANJERO');
    expect(sugerirTipoOperacion(FR_SIN_PREFIJO).tipoOperacion).toBe('NACIONAL');
    expect(sugerirTipoOperacion(FR_SIN_PREFIJO).avisos).toContain('CLIENTE_EXTRANJERO_CON_IVA');
    expect(sugerirTipoOperacion(US, ['PRODUCTO']).tipoOperacion).toBe('EXPORTACION');
    expect(sugerirTipoOperacion(US).tipoOperacion).toBe('SERVICIOS_EXTRANJERO');
    expect(sugerirTipoOperacion(CANARIAS, ['PRODUCTO'])).toEqual({ tipoOperacion: 'EXPORTACION', avisos: ['CLIENTE_FUERA_TAI'] });
    expect(sugerirTipoOperacion(FR, ['PRODUCTO', 'SERVICIO']).avisos).toContain('TIPO_PRODUCTO');
  });
});

describe('revisarFiscalidad', () => {
  const base = (e: Partial<EntradaFiscal>): EntradaFiscal => ({
    empresaEspanola: true,
    tipoOperacion: 'NACIONAL',
    lineas: [{ tipoIva: 21, tipoRetencion: 0 }],
    cliente: ES,
    tipoFactura: 'F1',
    ...e,
  });
  const codigos = (e: Partial<EntradaFiscal>, modo: ModoFiscal) => {
    const r = revisarFiscalidad(base(e), modo);
    return { errores: r.errores.map((x) => x.codigo), avisos: r.avisos.map((x) => x.codigo) };
  };

  it('contradicciones: error tambien al guardar', () => {
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: US }, 'guardar').errores).toContain('LINEA_CON_IVA');
    expect(
      codigos({ tipoOperacion: 'EXPORTACION', cliente: US, lineas: [{ tipoIva: 0, tipoRetencion: 15 }] }, 'guardar').errores,
    ).toEqual(['RETENCION_NO_RESIDENTE']);
    expect(codigos({ tipoOperacion: 'INTRACOMUNITARIA', cliente: FR, tipoFactura: 'F2', lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'guardar').errores).toEqual([
      'F2_NO_PERMITIDA',
    ]);
    expect(codigos({ tipoOperacion: 'ISP_NACIONAL', tipoFactura: 'F2', lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'guardar').errores).toContain(
      'F2_NO_PERMITIDA',
    );
    expect(codigos({ causaExencion: 'E1' }, 'guardar').errores).toContain('CAUSA_SIN_EXENTA');
    expect(codigos({ tipoOperacion: 'EMPRESA_EXTRANJERA' }, 'guardar').errores).toEqual(['TIPO_RESERVADO']);
    expect(codigos({ tipoOperacion: 'INVENTADO' }, 'emitir').errores).toEqual(['TIPO_RESERVADO']);
  });

  it('al guardar es aviso y al emitir es error', () => {
    const intraSinPrefijo = { tipoOperacion: 'INTRACOMUNITARIA', cliente: FR_SIN_PREFIJO, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] };
    expect(codigos(intraSinPrefijo, 'guardar').errores).toEqual([]);
    expect(codigos(intraSinPrefijo, 'guardar').avisos).toContain('CLIENTE_SIN_NIF_IVA');
    expect(codigos(intraSinPrefijo, 'emitir').errores).toEqual(['CLIENTE_SIN_NIF_IVA']);

    const nacionalAl0 = { lineas: [{ tipoIva: 21, tipoRetencion: 0 }, { tipoIva: 0, tipoRetencion: 0 }] };
    expect(codigos(nacionalAl0, 'guardar').errores).toEqual([]);
    expect(codigos(nacionalAl0, 'emitir').errores).toEqual(['LINEA_SIN_IVA']);

    const exentaSinRef = { tipoOperacion: 'EXENTA', causaExencion: 'E1', lineas: [{ tipoIva: 0, tipoRetencion: 0 }] };
    expect(codigos(exentaSinRef, 'emitir').errores).toEqual(['EXENCION_SIN_SUPUESTO']);
    expect(codigos({ ...exentaSinRef, referenciaLegal: 'art. 20.Uno.9.º Ley 37/1992' }, 'emitir').errores).toEqual([]);

    expect(codigos({ tipoOperacion: 'ISP_NACIONAL', cliente: US, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').errores).toEqual([
      'ISP_CLIENTE',
    ]);
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: ES, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').errores).toEqual([
      'CLIENTE_ESPANOL',
    ]);
    // Canarias: exportacion valida.
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: CANARIAS, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').errores).toEqual([]);
    expect(codigos({ tipoOperacion: 'INTRACOMUNITARIA', cliente: US, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').errores).toEqual([
      'CLIENTE_NO_UE',
    ]);
    expect(codigos({ tipoOperacion: null }, 'guardar').avisos).toEqual(['TIPO_AMBIGUO']);
    expect(codigos({ tipoOperacion: null }, 'emitir').errores).toEqual(['TIPO_AMBIGUO']);
  });

  it('el lector nunca rechaza y la empresa extranjera no se revisa', () => {
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: US }, 'lector').errores).toEqual([]);
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: US }, 'lector').avisos).toContain('LINEA_CON_IVA');
    expect(revisarFiscalidad(base({ empresaEspanola: false, tipoOperacion: 'LO_QUE_SEA' }), 'emitir')).toEqual({ errores: [], avisos: [] });
  });

  it('avisos informativos', () => {
    expect(codigos({ cliente: US }, 'emitir').avisos).toContain('CLIENTE_EXTRANJERO_CON_IVA');
    expect(codigos({ tipoOperacion: 'INTRACOMUNITARIA', cliente: FR, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').avisos).toContain(
      'ROI_Y_PRUEBA_TRANSPORTE',
    );
    expect(codigos({ tipoOperacion: 'EXPORTACION', cliente: FR, lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').avisos).toContain(
      'OPERACION_INCOHERENTE_PAIS',
    );
    expect(
      codigos({ tipoOperacion: 'EXENTA', causaExencion: 'E1', referenciaLegal: 'x', lineas: [{ tipoIva: 0, tipoRetencion: 0 }] }, 'emitir').avisos,
    ).toContain('PRORRATA');
  });
});

describe('resolverFiscalidadPura', () => {
  it('empresa no espanola: sin IVA ni retencion, se normaliza (no se rechaza)', () => {
    const r = resolverFiscalidadPura(
      { empresaEspanola: false, tipoOperacion: 'NACIONAL', lineas: [{ tipoIva: 21, tipoRetencion: 15 }], cliente: ES },
      'emitir',
    );
    expect(r.tipoOperacion).toBe('EMPRESA_EXTRANJERA');
    expect(r.lineas).toEqual([{ tipoIva: 0, tipoRetencion: 0 }]);
    expect(r.avisos.map((a) => a.codigo)).toEqual(['IVA_ELIMINADO_EMPRESA_EXTRANJERA']);
    expect(r.errores).toEqual([]);
  });

  it('borrador: solo se guarda el tipo elegido; al emitir, el deducido', () => {
    const e = { empresaEspanola: true, tipoOperacion: null, lineas: [{ tipoIva: 21, tipoRetencion: 0 }], cliente: ES };
    const guardar = resolverFiscalidadPura(e, 'guardar');
    expect(guardar.tipoOperacion).toBeNull();
    expect(guardar.tipoOperacionEfectivo).toBe('NACIONAL');
    expect(resolverFiscalidadPura(e, 'emitir').tipoOperacion).toBe('NACIONAL');
  });

  it('un borrador sin tipo elegido no se bloquea por el tipo deducido; al emitir, si', () => {
    const e = { empresaEspanola: true, tipoOperacion: null, lineas: [{ tipoIva: 0, tipoRetencion: 15 }], cliente: FR };
    const guardar = resolverFiscalidadPura(e, 'guardar');
    expect(guardar.errores).toEqual([]);
    expect(guardar.avisos.map((a) => a.codigo)).toContain('RETENCION_NO_RESIDENTE');
    expect(resolverFiscalidadPura(e, 'emitir').errores.map((a) => a.codigo)).toEqual(['RETENCION_NO_RESIDENTE']);
    // Elegido por el usuario: la contradiccion bloquea ya al guardar.
    expect(resolverFiscalidadPura({ ...e, tipoOperacion: 'INTRACOMUNITARIA' }, 'guardar').errores.map((a) => a.codigo)).toEqual([
      'RETENCION_NO_RESIDENTE',
    ]);
  });

  it('lector sin tipo deducible: con IVA, nacional; todo al 0 %, exenta para revisar', () => {
    const conIva = resolverFiscalidadPura(
      { empresaEspanola: true, tipoOperacion: null, lineas: [{ tipoIva: 21, tipoRetencion: 0 }, { tipoIva: 0, tipoRetencion: 0 }], cliente: ES },
      'lector',
    );
    expect(conIva.tipoOperacion).toBe('NACIONAL');
    expect(conIva.errores).toEqual([]);
    expect(conIva.avisos.map((a) => a.codigo)).toEqual(expect.arrayContaining(['TIPO_LEIDO_OCR', 'LINEA_SIN_IVA']));
  });

  it('lector sin tipo deducible: EXENTA E6 para revisar', () => {
    const r = resolverFiscalidadPura({ empresaEspanola: true, tipoOperacion: null, lineas: [{ tipoIva: 0, tipoRetencion: 0 }], cliente: ES }, 'lector');
    expect(r).toMatchObject({ tipoOperacion: 'EXENTA', causaExencion: 'E6', referenciaLegal: 'Revisar: leída por OCR' });
    expect(r.errores).toEqual([]);
    expect(r.avisos.map((a) => a.codigo)).toContain('TIPO_LEIDO_OCR');
  });

  it('la referencia legal solo se guarda en EXENTA e ISP', () => {
    const r = resolverFiscalidadPura(
      { empresaEspanola: true, tipoOperacion: 'NACIONAL', referenciaLegal: 'algo', lineas: [{ tipoIva: 21, tipoRetencion: 0 }], cliente: ES },
      'emitir',
    );
    expect(r.referenciaLegal).toBeNull();
  });
});

describe('perfil de la empresa por pais', () => {
  it('Espana en espanol; el resto en ingles con su formato', () => {
    expect(esPaisEspana('')).toBe(true);
    expect(esPaisEspana('ES')).toBe(true);
    expect(esPaisEspana('FR')).toBe(false);
    expect(idiomaPorPais('HK')).toBe('en');
    expect(formatearFecha('2026-09-21', formatoPorPais('ES'))).toBe('21/09/2026');
    expect(formatearFecha('2026-09-21', formatoPorPais('US'))).toBe('09/21/2026');
    expect(formatearFecha('2026-09-21', formatoPorPais('HK'))).toBe('21/09/2026');
    expect(formatearImporte(1234.56, 'EUR', formatoPorPais('ES'))).toBe('1.234,56 €');
    expect(formatearImporte(1234.56, 'USD', formatoPorPais('ES'))).toBe('1.234,56 USD');
    expect(formatearImporte(1234.56, 'USD', formatoPorPais('US'))).toBe('USD 1,234.56');
    expect(formatearImporte(-1234567.5, 'HKD', formatoPorPais('HK'))).toBe('HKD -1,234,567.50');
  });
});
