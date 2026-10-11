/**
 * De prebuilt-invoice (fixtures con la forma oficial) a LecturaNormalizada:
 * campos, confianzas, desglose por tipo, recargo, retencion propuesta y que
 * no se cuela nada bruto (content, polygon, spans, words).
 */
import { completarTotalAPagar, confianzaLectura, contarPaginasPdf, leerTipo, mapearFacturaAzure, MOTIVO_A_PAGAR_SIN_TOTAL, MOTIVO_BASE_DUDOSA } from '../services/lectura/azure-factura.mapper';
import type { AnalyzeResult } from '../services/lectura/azure-di.client';
import type { LecturaHecha } from '../services/lectura/tipos';
import { fixtureAzure } from './fixtures/azure-di';

const ar = (nombre: string) => fixtureAzure<{ analyzeResult: AnalyzeResult }>(nombre).analyzeResult;
function mapear(nombre: string, paginasArchivo?: number): LecturaHecha {
  const r = mapearFacturaAzure(ar(nombre), { paginasArchivo });
  if (r.tipo !== 'hecho') throw new Error(`se esperaba una lectura de ${nombre}`);
  return r;
}

describe('resultado-simple', () => {
  const { lectura: l, texto } = mapear('resultado-simple');

  it('los datos de la factura, con su confianza y su pagina', () => {
    expect(l.emisor.nombre).toEqual({ valor: 'IMPRENTA LEVANTE SL', confianza: 0.95, fuente: 'azure', pagina: 1 });
    expect(l.emisor.nif).toMatchObject({ valor: 'B12345674', confianza: 0.93 });
    expect(l.emisor.direccion.valor).toEqual({ calle: 'Calle Mayor 12', cp: '46001', municipio: 'Valencia', provincia: 'Valencia', pais: 'ESP' });
    expect(l.receptor.nif).toMatchObject({ valor: 'B87654323', confianza: 0.9 });
    expect(l.numero).toMatchObject({ valor: 'F2026/0012', confianza: 0.96 });
    expect(l.fechaEmision).toMatchObject({ valor: '2026-03-04', confianza: 0.97 });
    expect(l.fechaVencimiento.valor).toBe('2026-04-03');
    expect(l.moneda.valor).toBe('EUR');
    expect(l.totales.base.valor).toBe(200);
    expect(l.totales.cuotaIva.valor).toBe(42);
    expect(l.totales.totalFactura.valor).toBe(242);
    expect(l.totales.totalAPagar).toMatchObject({ valor: 242, confianza: 0.91, fuente: 'azure' });
    expect(l.retencion).toBeNull();
    expect(l.tipoDocumento.valor).toBe('factura');
    expect(l.concepto.valor).toBe('Folletos A5');
    expect(l.lineas).toHaveLength(2);
    expect(l.lineas[0]).toEqual({ descripcion: 'Folletos A5', cantidad: 1000, precioUnitario: 0.1, importe: 100, tipoIva: 21, confianza: 0.93 });
    expect(texto).toContain('FACTURA Nº F2026/0012');
  });

  it('IBAN sin espacios y valido', () => {
    expect(l.iban.valor).toBe('ES9121000418450200051332');
    expect(l.iban.motivo).toBeUndefined();
  });

  it('un tramo al 21 % con la base de las lineas', () => {
    expect(l.desglose).toEqual([{ tipoIva: 21, base: { valor: 200, confianza: 0.93, fuente: 'azure' }, cuota: expect.objectContaining({ valor: 42 }), tipoRecargo: null, cuotaRecargo: null }]);
  });

  it('confianza de la lectura: la minima de los datos clave', () => {
    expect(confianzaLectura(l, 'GASTO')).toBe(0.91);
    expect(confianzaLectura(l, 'VENTA')).toBe(0.9);
  });

  it('el resultado no contiene content, polygon, spans ni words', () => {
    const json = JSON.stringify(l);
    for (const bruto of ['polygon', 'spans', 'words', 'boundingRegions', '"content"', ':barcode:', 'facturacion@']) expect(json).not.toContain(bruto);
  });
});

describe('desglose', () => {
  it.each([
    ['21%', 21],
    ['21 %', 21],
    ['21,00 %', 21],
    ['IVA 10%', 10],
    ['5,2 %', 5.2],
    ['21', 21],
    ['sin tipo', null],
  ])('Rate "%s" es %s', (rate, tipo) => expect(leerTipo(rate)).toBe(tipo));

  it('dos tipos: cada base de sus lineas, y cuadran con la cuota', () => {
    const { lectura } = mapear('resultado-iva-multiple');
    expect(lectura.desglose.map((t) => [t.tipoIva, t.base.valor, t.base.fuente, t.cuota.valor])).toEqual([
      [21, 200, 'azure', 42],
      [10, 50, 'azure', 5],
    ]);
    expect(lectura.totales.totalFactura.valor).toBe(297);
  });

  it('sin lineas con tipo: la base sale de la cuota; un solo tramo usa el SubTotal', () => {
    const datos = ar('resultado-iva-multiple');
    delete datos.documents![0].fields!.Items;
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.desglose.map((t) => [t.tipoIva, t.base.valor, t.base.fuente])).toEqual([
      [21, 200, 'calculado'],
      [10, 50, 'calculado'],
    ]);
    expect(r.lectura.desglose[0].base.motivo).not.toBe(MOTIVO_BASE_DUDOSA); // suman el SubTotal

    const simple = ar('resultado-simple');
    delete simple.documents![0].fields!.Items;
    const s = mapearFacturaAzure(simple);
    if (s.tipo !== 'hecho') throw new Error('x');
    expect(s.lectura.desglose[0].base).toMatchObject({ valor: 200, fuente: 'azure', confianza: 0.94 });
  });

  it('bases calculadas que no suman el SubTotal: dudosas (se preguntara a Claude)', () => {
    const datos = ar('resultado-iva-multiple');
    const f = datos.documents![0].fields!;
    delete f.Items;
    f.SubTotal.valueCurrency!.amount = 251;
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.desglose.every((t) => t.base.motivo === MOTIVO_BASE_DUDOSA)).toBe(true);
  });

  it('recargo de equivalencia en TaxDetails: se empareja con su IVA y cuotaIva no lo incluye', () => {
    const { lectura } = mapear('resultado-recargo');
    expect(lectura.desglose).toHaveLength(1);
    expect(lectura.desglose[0]).toMatchObject({ tipoIva: 21, tipoRecargo: 5.2, cuotaRecargo: { valor: 10.4 } });
    expect(lectura.totales.cuotaIva.valor).toBe(42);
    expect(lectura.totales.cuotaRecargo.valor).toBe(10.4);
    expect(lectura.totales.totalFactura.valor).toBe(252.4);
  });

  it('sin TaxDetails: un tramo con el tipo mas cercano, para revisar', () => {
    const datos = ar('resultado-simple');
    delete datos.documents![0].fields!.TaxDetails;
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.desglose[0]).toMatchObject({ tipoIva: 21, base: { valor: 200, fuente: 'calculado' } });
    expect(r.lectura.desglose[0].base.motivo).toBeDefined();
  });
});

describe('retencion, moneda y otros', () => {
  it('retencion propuesta a partir de AmountDue (15 % de 1.000)', () => {
    const { lectura } = mapear('resultado-irpf');
    expect(lectura.retencion?.tipo).toMatchObject({ valor: 15, fuente: 'calculado' });
    expect(lectura.retencion?.importe.valor).toBe(150);
    expect(lectura.totales.retencion.valor).toBe(150);
    expect(lectura.totales.totalAPagar.valor).toBe(1060);
    expect(lectura.totales.totalFactura.valor).toBe(1210);
  });

  it('USD', () => {
    expect(mapear('resultado-usd').lectura.moneda.valor).toBe('USD');
  });

  it('sin codigo de moneda: el simbolo €; sin nada, EUR para revisar', () => {
    const datos = ar('resultado-simple');
    const f = datos.documents![0].fields!;
    for (const k of ['InvoiceTotal', 'SubTotal', 'AmountDue']) delete f[k].valueCurrency!.currencyCode;
    let r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.moneda).toEqual({ valor: 'EUR', confianza: null, fuente: 'calculado' });
    for (const k of ['InvoiceTotal', 'SubTotal', 'AmountDue']) delete f[k].valueCurrency!.currencySymbol;
    r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.moneda.motivo).toBeDefined();
  });

  it('un campo sin confidence guarda null', () => {
    const datos = ar('resultado-simple');
    delete datos.documents![0].fields!.InvoiceId.confidence;
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.numero).toMatchObject({ valor: 'F2026/0012', confianza: null, fuente: 'azure' });
  });

  it('sin cliente: simplificada para revisar', () => {
    const datos = ar('resultado-simple');
    delete datos.documents![0].fields!.CustomerName;
    delete datos.documents![0].fields!.CustomerTaxId;
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.tipoDocumento).toMatchObject({ valor: 'simplificada', fuente: 'calculado' });
  });

  it('sin documents: AZURE_SIN_FACTURA', () => {
    expect(mapearFacturaAzure(ar('resultado-sin-documento'))).toEqual({ tipo: 'fallo', codigo: 'AZURE_SIN_FACTURA', reintentable: false });
  });

  it('paginas: las del archivo y las leidas', () => {
    expect(mapear('resultado-dos-paginas', 3).lectura.paginas).toEqual({ archivo: 3, leidas: 2 });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R 4 0 R] >>\n2 0 obj << /Type /Page >>\n3 0 obj << /Type/Page >>\n4 0 obj << /Type /Page >>');
    expect(contarPaginasPdf(pdf)).toBe(3);
    expect(contarPaginasPdf(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('el QR se interpreta (sin comparar todavia)', () => {
    expect(mapear('resultado-qr-ok').qr).toMatchObject({ estado: 'VALIDO', verifactu: true });
    expect(mapear('resultado-simple').qr).toBeNull();
  });

  it('varias facturas en el archivo: aviso y lo principal a revisar', () => {
    const datos = ar('resultado-simple');
    datos.documents!.push(datos.documents![0]);
    const r = mapearFacturaAzure(datos);
    if (r.tipo !== 'hecho') throw new Error('x');
    expect(r.lectura.avisos).toContain('El archivo parece tener varias facturas; solo se ha leído la primera.');
    expect(r.lectura.numero.motivo).toBeDefined();
  });
});

describe('sin total a pagar leido (completarTotalAPagar)', () => {
  /** El fixture sin InvoiceTotal ni AmountDue. */
  function sinTotales(nombre: string) {
    const a = ar(nombre);
    const f = a.documents![0].fields as Record<string, unknown>;
    delete f.InvoiceTotal;
    delete f.AmountDue;
    const r = mapearFacturaAzure(a);
    if (r.tipo !== 'hecho') throw new Error('x');
    return r.lectura;
  }

  it('el mapeo calcula el total de la factura con las bases y deja el total a pagar sin valor', () => {
    const l = sinTotales('resultado-qr-ok');
    expect(l.totales.totalFactura).toMatchObject({ valor: 242, fuente: 'calculado' });
    expect(l.totales.totalAPagar.valor).toBeNull();
  });

  it('sin retencion: el total a pagar es el total de la factura, calculado y sin motivo', () => {
    const l = sinTotales('resultado-qr-ok');
    completarTotalAPagar(l);
    expect(l.totales.totalAPagar).toEqual({ valor: 242, confianza: null, fuente: 'calculado' });
  });

  it('con retencion: el total menos la retencion, con su motivo', () => {
    const l = sinTotales('resultado-irpf');
    l.retencion = { tipo: { valor: 15, confianza: null, fuente: 'claude' }, importe: { valor: 150, confianza: null, fuente: 'claude' } };
    completarTotalAPagar(l);
    expect(l.totales.totalAPagar).toEqual({ valor: 1060, confianza: null, fuente: 'calculado', motivo: MOTIVO_A_PAGAR_SIN_TOTAL });
  });

  it('conserva el motivo que ya tuviera y no toca un total a pagar leido', () => {
    const l = sinTotales('resultado-qr-ok');
    l.totales.totalAPagar.motivo = 'No se ha podido completar con la IA: revísalo a mano.';
    completarTotalAPagar(l);
    expect(l.totales.totalAPagar).toMatchObject({ valor: 242, motivo: 'No se ha podido completar con la IA: revísalo a mano.' });
    const leida = mapear('resultado-irpf').lectura;
    const antes = structuredClone(leida.totales.totalAPagar);
    completarTotalAPagar(leida);
    expect(leida.totales.totalAPagar).toEqual(antes);
  });
});

