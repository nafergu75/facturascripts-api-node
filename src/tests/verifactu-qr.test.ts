/**
 * QR de VERI*FACTU (AEAT v0.5.0): se interpreta sin abrir la URL y se compara
 * con lo leido de la factura.
 */
import { compararQr, interpretarValorQr, leerQrDeCodigos, textoQr } from '../services/lectura/verifactu-qr';
import { lecturaVacia, type LecturaNormalizada } from '../services/lectura/tipos';
import { fixtureAzure } from './fixtures/azure-di';

const QR = 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=B12345674&numserie=F2026%2F0012&fecha=04-03-2026&importe=242.00';

function leida(extra: (l: LecturaNormalizada) => void = () => undefined): LecturaNormalizada {
  const l = lecturaVacia();
  l.emisor.nif = { valor: 'B12345674', confianza: 0.93, fuente: 'azure' };
  l.numero = { valor: 'F2026/0012', confianza: 0.55, fuente: 'azure' };
  l.fechaEmision = { valor: '2026-03-04', confianza: 0.97, fuente: 'azure' };
  l.totales.totalFactura = { valor: 242, confianza: 0.95, fuente: 'azure' };
  l.totales.totalAPagar = { valor: 242, confianza: 0.91, fuente: 'azure' };
  extra(l);
  return l;
}

type Pagina = { barcodes: Array<{ kind: string; value: string }> };
const codigosDe = (fixture: string) => fixtureAzure<{ analyzeResult: { pages: Pagina[] } }>(fixture).analyzeResult.pages.flatMap((p) => p.barcodes);

describe('interpretar el QR', () => {
  it('produccion con ValidarQR es VERI*FACTU; con ValidarQRNoVerifactu, no', () => {
    expect(interpretarValorQr(QR)).toEqual({ estado: 'VALIDO', verifactu: true, datos: { nif: 'B12345674', numserie: 'F2026/0012', fecha: '2026-03-04', importe: 242 } });
    expect(interpretarValorQr(QR.replace('ValidarQR?', 'ValidarQRNoVerifactu?'))?.verifactu).toBe(false);
  });

  it('%26 se decodifica dentro del numero de serie', () => {
    expect(interpretarValorQr(QR.replace('F2026%2F0012', 'A%26B-7'))?.datos?.numserie).toBe('A&B-7');
  });

  it('un importe con un solo decimal ("241.4") vale', () => {
    expect(interpretarValorQr(QR.replace('242.00', '241.4'))?.datos?.importe).toBe(241.4);
  });

  it('importe con coma, fecha imposible o un parametro que falta: ILEGIBLE', () => {
    expect(interpretarValorQr(QR.replace('242.00', '242,00'))?.estado).toBe('ILEGIBLE');
    expect(interpretarValorQr(QR.replace('04-03-2026', '30-02-2026'))?.estado).toBe('ILEGIBLE');
    expect(interpretarValorQr(QR.replace('&fecha=04-03-2026', ''))?.estado).toBe('ILEGIBLE');
  });

  it('con los fixtures: ajeno, de pruebas y mal formado', () => {
    expect(leerQrDeCodigos(codigosDe('resultado-qr-ajeno'))?.estado).toBe('AJENO');
    expect(leerQrDeCodigos(codigosDe('resultado-qr-pruebas'))?.estado).toBe('PRUEBAS');
    expect(leerQrDeCodigos(codigosDe('resultado-qr-mal-formado'))?.estado).toBe('ILEGIBLE');
    expect(leerQrDeCodigos(codigosDe('resultado-simple'))).toBeNull();
    expect(leerQrDeCodigos([{ kind: 'Code128', value: QR }, { kind: 'QRCode', value: 'texto suelto' }])).toBeNull();
  });

  it('un QR ajeno antes del de la AEAT no lo tapa', () => {
    const web = { kind: 'QRCode', value: 'https://www.imprentalevante.es/pagar?f=12' };
    expect(leerQrDeCodigos([web, { kind: 'QRCode', value: QR }])).toMatchObject({ estado: 'VALIDO', datos: { numserie: 'F2026/0012' } });
    expect(leerQrDeCodigos([web, { kind: 'QRCode', value: QR.replace('242.00', '242,00') }])?.estado).toBe('ILEGIBLE');
    expect(leerQrDeCodigos([{ kind: 'QRCode', value: QR.replace('242.00', '242,00') }, { kind: 'QRCode', value: QR }])?.estado).toBe('VALIDO');
    expect(leerQrDeCodigos([web])?.estado).toBe('AJENO');
  });
});

describe('comparar con lo leido', () => {
  it('todo coincide: COINCIDE y los cuatro campos pasan a fuente qr con confianza 1', () => {
    const l = compararQr(leerQrDeCodigos(codigosDe('resultado-qr-ok')), leida());
    expect(l.qr).toMatchObject({ estado: 'COINCIDE', verifactu: true, diferencias: [] });
    for (const c of [l.emisor.nif, l.numero, l.fechaEmision, l.totales.totalFactura]) expect(c).toMatchObject({ fuente: 'qr', confianza: 1 });
    expect(l.qr?.completados).toEqual([]);
    expect(textoQr(l.qr)).toBe('Los datos del QR VERI*FACTU coinciden con los leídos: NIF, número, fecha e importe.');
  });

  it('no cambia la lectura que recibe', () => {
    const original = leida();
    compararQr(interpretarValorQr(QR), original);
    expect(original.numero.fuente).toBe('azure');
  });

  it('el numero sin serie (el QR acaba en el numero leido): revisar, con el valor del QR', () => {
    const l = compararQr(interpretarValorQr(QR), leida((x) => (x.numero.valor = '0012')));
    expect(l.qr?.estado).toBe('NO_COINCIDE');
    expect(l.qr?.diferencias).toEqual([{ campo: 'numero', enQr: 'F2026/0012', leido: '0012', nivel: 'revisar' }]);
  });

  it('el numero con otros separadores coincide', () => {
    expect(compararQr(interpretarValorQr(QR), leida((x) => (x.numero.valor = 'F 2026-0012'))).qr?.estado).toBe('COINCIDE');
  });

  it('el importe coincide con el total a pagar y no con el bruto: revisar', () => {
    const l = compararQr(interpretarValorQr(QR.replace('242.00', '212.00')), leida((x) => (x.totales.totalAPagar.valor = 212)));
    expect(l.qr?.diferencias).toEqual([{ campo: 'importe', enQr: '212.00', leido: '242.00', nivel: 'revisar' }]);
  });

  it('el importe no coincide con ninguno: error', () => {
    const l = compararQr(leerQrDeCodigos(codigosDe('resultado-qr-no-coincide')), leida());
    expect(l.qr?.diferencias).toEqual([{ campo: 'importe', enQr: '224.00', leido: '242.00', nivel: 'error' }]);
    expect(textoQr(l.qr)).toBe('El QR VERI*FACTU no coincide con la factura en: importe. Revísalo antes de registrar.');
  });

  it('el NIF no coincide: error', () => {
    const l = compararQr(interpretarValorQr(QR), leida((x) => (x.emisor.nif.valor = 'A58818501')));
    expect(l.qr?.diferencias).toEqual([{ campo: 'nif', enQr: 'B12345674', leido: 'A58818501', nivel: 'error' }]);
  });

  it('Azure no leyo la fecha ni el NIF: se rellenan desde el QR', () => {
    const l = compararQr(interpretarValorQr(QR), leida((x) => {
      x.fechaEmision = { valor: null, confianza: null, fuente: 'azure' };
      x.emisor.nif = { valor: null, confianza: null, fuente: 'azure' };
    }));
    expect(l.fechaEmision).toMatchObject({ valor: '2026-03-04', fuente: 'qr', confianza: 1 });
    expect(l.emisor.nif).toMatchObject({ valor: 'B12345674', fuente: 'qr' });
    expect(l.qr?.estado).toBe('COINCIDE');
    // No se dice que coinciden datos que no se han cotejado.
    expect(l.qr?.completados).toEqual(['nif', 'fecha']);
    expect(textoQr(l.qr)).toBe('QR VERI*FACTU: el número y el importe coinciden con lo leído; el NIF y la fecha se han tomado del QR.');
  });

  it('nada leido: todo del QR y el texto lo dice', () => {
    const l = compararQr(interpretarValorQr(QR), lecturaVacia());
    expect(l.qr?.completados).toEqual(['nif', 'numero', 'fecha', 'importe']);
    expect(textoQr(l.qr)).toBe('No se ha podido cotejar el QR VERI*FACTU: el NIF, el número, la fecha y el importe se han tomado del QR.');
  });

  it('sin total leido: se toma el del QR, pero para revisar', () => {
    const l = compararQr(interpretarValorQr(QR), leida((x) => {
      x.totales.totalFactura = { valor: null, confianza: null, fuente: 'azure' };
      x.totales.totalAPagar = { valor: null, confianza: null, fuente: 'azure' };
    }));
    expect(l.totales.totalFactura).toMatchObject({ valor: 242, fuente: 'qr', confianza: null });
    expect(l.totales.totalFactura.motivo).toMatch(/compruébalo/);
  });

  it('host de pruebas: NO_COINCIDE con su motivo; mal formado: ILEGIBLE; ajeno; sin QR', () => {
    const pruebas = compararQr(leerQrDeCodigos(codigosDe('resultado-qr-pruebas')), leida());
    expect(pruebas.qr).toMatchObject({ estado: 'NO_COINCIDE', pruebas: true, motivo: 'El QR es del entorno de pruebas de la AEAT; una factura real no debería llevarlo.' });
    expect(pruebas.numero.fuente).toBe('azure');
    expect(compararQr(leerQrDeCodigos(codigosDe('resultado-qr-mal-formado')), leida()).qr?.estado).toBe('ILEGIBLE');
    expect(textoQr(compararQr(leerQrDeCodigos(codigosDe('resultado-qr-ajeno')), leida()).qr)).toBe(
      'La factura tiene un código QR que no es de la Agencia Tributaria; no se ha tenido en cuenta.',
    );
    expect(compararQr(null, leida()).qr).toEqual({ estado: 'SIN_QR', verifactu: null, datos: null, diferencias: [] });
  });
});
