/**
 * Plantilla A (envases e IEEPNR) en las facturas de venta, sobre BD real.
 *
 * Los 7 articulos de la factura de muestra NZ004_26 (con un cliente ficticio:
 * el repo es publico) dan exactamente sus cifras, como borrador y emitida:
 * base 7.152,63 (articulos 6.974,88 + IEEPNR 177,75), IVA 1.502,05 (por tipo)
 * y total 8.654,68; kg 394,992, packs 9.826 y uds 46.320.
 *
 * Ademas: columnas guardadas y resumenEnvases, proforma y pasar a factura,
 * duplicar, los 400 nuevos, sin repercutir el IEEPNR, el tipo de los ajustes
 * cambiado despues, el lector y la serie con la plantilla de siempre.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { actualizarSerie, crearSerie, listarSeries } from '../services/series.service';
import { calcularLineasDoc } from '../domain/importesFactura';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';
import { datosPdfFactura, generarPdfFactura } from '../services/facturaPdf.service';
import { textosDePdf } from './texto-pdf';

const SUFIJO = Date.now();
const ES = `plantilla-a-es-${SUFIJO}`;
let cliente: string;
let serieA: string;
let serieP: string;

const lineasNz = (extra: Partial<CrearLineaIngresoDTO> = {}): CrearLineaIngresoDTO[] =>
  LINEAS_NZ004.map((l) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: l.packs,
    cantidad: l.cantidad,
    kgPlastico: l.kgPlastico,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    ...extra,
  }));

const alta = (extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: cliente }, fechaEmision: '2026-03-04', lineas: lineasNz(), ...extra } as never);

/** Las cifras exactas de NZ004_26 en una respuesta. */
function cifrasMuestra(f: Awaited<ReturnType<typeof alta>>) {
  expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([TOTALES_NZ004.base, TOTALES_NZ004.iva, TOTALES_NZ004.total]);
  expect([f.baseTotalDoc, f.ivaTotalDoc, f.totalFacturaDoc]).toEqual([TOTALES_NZ004.base, TOTALES_NZ004.iva, TOTALES_NZ004.total]);
  expect(f.plantillaId).toBe('A');
  expect(f.resumenEnvases).toEqual({ kgPlastico: TOTALES_NZ004.kgPlastico, packs: TOTALES_NZ004.packs, uds: TOTALES_NZ004.uds, ieepnr: TOTALES_NZ004.ieepnr });
  expect(f.lineas.map((l) => l.ieepnrImporte)).toEqual(LINEAS_NZ004.map((l) => l.ieepnr));
  // TOTAL del articulo = baseLineDoc - ieepnrImporte.
  expect(f.lineas.map((l) => Math.round(l.baseLineDoc * 100 - l.ieepnrImporte * 100) / 100)).toEqual(LINEAS_NZ004.map((l) => l.totalArticulo));
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: ES, name: 'Envases Prueba SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: ES, denominacion: 'ENVASES PRUEBA SL', nif: 'B12345674' } });
  cliente = (await prisma.customer.create({ data: { companyId: ES, nombreFiscal: 'CLIENTE FICTICIO BEBIDAS SL', nifCif: '00000000T', direccion: 'CALLE FALSA, 1', cp: '46000', municipio: 'VALENCIA', provincia: 'VALENCIA' } })).id;
  const series = await listarSeries(ES);
  serieA = series.find((s) => s.codigo === 'A')!.id;
  serieP = series.find((s) => s.codigo === 'P')!.id;
  // Una serie con la de siempre (la S) y sin la C de servicios, para que la S sea la unica que admite descuento.
  await crearSerie(ES, { codigo: 'S', descripcion: 'Estandar', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  await prisma.invoiceSeries.updateMany({ where: { companyId: ES, codigo: 'C' }, data: { activa: false } });
  await guardarAjustesFacturacion(ES, 'u-test', { ieepnrRepercute: true });
});

describe('NZ004_26 con la plantilla A', () => {
  let borradorId: string;
  let emitidaId: string;

  it('borrador: las cifras exactas de la muestra y el peso bruto', async () => {
    const f = await alta({ borrador: true, pesoBrutoKg: TOTALES_NZ004.pesoBrutoKg });
    borradorId = f.id;
    cifrasMuestra(f);
    expect([f.estadoDocumento, f.pesoBrutoKg, f.ieepnrPorKg]).toEqual(['BORRADOR', TOTALES_NZ004.pesoBrutoKg, 0.45]);
    expect(f.lineas[1]).toMatchObject({ packs: 1092, cantidad: 6552, kgPlastico: 176.17, ieepnrImporte: 79.28, textoAdicional: 'Cod. RPA Azúcar: 6B30250\nUnidad 1,5 L Refrescos SR' });
  });

  it('emitida: las mismas cifras, y las columnas guardadas', async () => {
    const f = await alta({ pesoBrutoKg: TOTALES_NZ004.pesoBrutoKg });
    emitidaId = f.id;
    cifrasMuestra(f);
    expect(f.estadoDocumento).toBe('FINAL');
    const fila = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id }, include: { lineas: true } });
    expect([fila.plantillaId, Number(fila.pesoBrutoKg), Number(fila.ieepnrPorKg), fila.serie]).toEqual(['A', 24528.62, 0.45, 'A']);
    expect(fila.lineas.map((l) => [l.packs, Number(l.kgPlastico), Number(l.ieepnrImporte)])).toEqual(LINEAS_NZ004.map((l) => [l.packs, l.kgPlastico, l.ieepnr]));
    // baseLine (base imponible) lleva el IEEPNR dentro.
    expect(Number(fila.lineas[0].baseLine)).toBe(544.05);
    expect(fila.lineas.reduce((a, l) => a + Math.round(Number(l.ivaImporte) * 100), 0)).toBe(150205);
    // GET /:id igual.
    cifrasMuestra(await incomeInvoicesService.obtenerPorId(ES, f.id));
  });

  it('al emitir el borrador las cifras no cambian', async () => {
    const f = await incomeInvoicesService.finalizar(ES, borradorId, { fechaEmision: '2026-03-04' });
    cifrasMuestra(f);
    expect(f.pesoBrutoKg).toBe(24528.62);
  });

  it('el cuerpo no fija ni la plantilla ni el IEEPNR', async () => {
    const f = await alta({
      borrador: true,
      plantillaId: 'default',
      lineas: lineasNz({ ieepnrImporte: 999 } as never),
    });
    cifrasMuestra(f);
    const b = await alta({ borrador: true, serie: 'S', plantillaId: 'A', lineas: lineasNz({ packs: null, kgPlastico: null, textoAdicional: null }) });
    expect(b.plantillaId).toBe('default');
  });

  it('cambiar el tipo en los ajustes: el borrador se recalcula al guardar con lineas; la emitida no cambia', async () => {
    const borrador = await alta({ borrador: true });
    await guardarAjustesFacturacion(ES, 'u-test', { ieepnrPorKg: 0.5 });
    // Sin lineas en el cuerpo no se recalcula el IEEPNR.
    const sinLineas = await incomeInvoicesService.actualizarBorrador(ES, borrador.id, { observaciones: 'sin cambios de lineas' });
    expect([sinLineas.resumenEnvases?.ieepnr, sinLineas.ieepnrPorKg]).toEqual([177.75, 0.45]);
    // Con lineas, con el tipo de hoy: 103,089 × 0,5 = 51,5445 -> 51,54...
    const conLineas = await incomeInvoicesService.actualizarBorrador(ES, borrador.id, { lineas: lineasNz() });
    expect(conLineas.ieepnrPorKg).toBe(0.5);
    expect(conLineas.lineas[0].ieepnrImporte).toBe(51.54);
    expect(conLineas.resumenEnvases!.ieepnr).toBe(197.5);
    // La emitida sigue igual.
    cifrasMuestra(await incomeInvoicesService.obtenerPorId(ES, emitidaId));
    expect((await incomeInvoicesService.obtenerPorId(ES, emitidaId)).ieepnrPorKg).toBe(0.45);
    await guardarAjustesFacturacion(ES, 'u-test', { ieepnrPorKg: 0.45 });
  });

  it('sin repercutir el IEEPNR (la A elegida a mano): kg sí, IEEPNR 0 y la base son solo los articulos', async () => {
    await guardarAjustesFacturacion(ES, 'u-test', { ieepnrRepercute: false });
    // Sin repercutirlo, la serie A ya no usa la A sola: hay que elegirla.
    await actualizarSerie(ES, serieA, { plantilla: 'A' });
    const f = await alta({ borrador: true });
    expect(f.lineas.every((l) => l.ieepnrImporte === 0)).toBe(true);
    expect([f.baseTotal, f.ieepnrPorKg]).toEqual([TOTALES_NZ004.articulos, null]);
    expect(f.resumenEnvases).toEqual({ kgPlastico: 394.992, packs: 9826, uds: 46320, ieepnr: 0 });
    // 6.974,88 × 21 % = 1.464,7248 -> 1.464,72 (por tipo).
    expect([f.ivaTotal, f.totalFactura]).toEqual([1464.72, 8439.6]);
    await actualizarSerie(ES, serieA, { plantilla: null });
    await guardarAjustesFacturacion(ES, 'u-test', { ieepnrRepercute: true });
  });

  it('proforma con la serie P en la A, y pasarla a factura', async () => {
    // La P es estandar: con envases, 400.
    await expect(alta({ proforma: true })).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'PLANTILLA_SIN_ENVASES' } });
    await actualizarSerie(ES, serieP, { plantilla: 'A' });
    const p = await alta({ proforma: true, pesoBrutoKg: 100.5 });
    cifrasMuestra(p);
    expect([p.estadoDocumento, p.pesoBrutoKg]).toEqual(['PROFORMA', 100.5]);
    const f = await incomeInvoicesService.pasarProformaAFactura(ES, p.id);
    cifrasMuestra(f);
    expect([f.serie, f.estadoDocumento, f.pesoBrutoKg, f.ieepnrPorKg]).toEqual(['A', 'BORRADOR', 100.5, 0.45]);
    await actualizarSerie(ES, serieP, { plantilla: null });
  });

  it('duplicar: a la serie A con sus envases; sin ninguna serie A, 400 SIN_SERIE_ENVASES', async () => {
    const copia = await incomeInvoicesService.duplicar(ES, emitidaId);
    cifrasMuestra(copia);
    expect([copia.serie, copia.estadoDocumento, copia.pesoBrutoKg]).toEqual(['A', 'BORRADOR', 24528.62]);
    expect(copia.lineas.map((l) => l.textoAdicional)).toEqual(LINEAS_NZ004.map((l) => l.textoAdicional));
    await actualizarSerie(ES, serieA, { plantilla: 'default' });
    await expect(incomeInvoicesService.duplicar(ES, emitidaId)).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'SIN_SERIE_ENVASES', campo: 'serie' } });
    await actualizarSerie(ES, serieA, { plantilla: null });
  });

  it('un borrador de la A que pasa a una serie sin envases con kg: 400 PLANTILLA_SIN_ENVASES', async () => {
    const b = await alta({ borrador: true });
    await expect(incomeInvoicesService.actualizarBorrador(ES, b.id, { serie: 'S' })).rejects.toMatchObject({
      statusCode: 400,
      details: { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'lineas.0.packs' },
    });
    // Sin envases, si pasa (y vuelve al IVA por linea de la estandar).
    const sinEnvases = await incomeInvoicesService.actualizarBorrador(ES, b.id, { serie: 'S', lineas: lineasNz({ packs: null, kgPlastico: null, textoAdicional: null }) });
    const porLinea = calcularLineasDoc(LINEAS_NZ004.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario, tipoIva: 21 }))).totales.ivaTotal;
    expect([sinEnvases.plantillaId, sinEnvases.ivaTotal, sinEnvases.resumenEnvases]).toEqual(['default', porLinea, null]);
    // Y de vuelta a la A, con IVA por tipo.
    const deVuelta = await incomeInvoicesService.actualizarBorrador(ES, b.id, { serie: 'A' });
    expect([deVuelta.plantillaId, deVuelta.ivaTotal]).toEqual(['A', 1464.72]);
  });
});

describe('descuentos de antes cuando la serie A pasa a la plantilla A', () => {
  const conDescuento = [{ descripcion: 'Con descuento', cantidad: 2, precioUnitario: 50, descuentoPorcentaje: 10, tipoIva: 21 }];

  it('un borrador de antes con descuento: sin lineas se retoca y se emite con su plantilla; con lineas, manda la de la serie', async () => {
    // Un borrador de cuando la serie A era la estandar.
    await actualizarSerie(ES, serieA, { plantilla: 'default' });
    const b = await alta({ borrador: true, lineas: conDescuento });
    expect(b.plantillaId).toBe('default');
    await actualizarSerie(ES, serieA, { plantilla: null });
    const retocado = await incomeInvoicesService.actualizarBorrador(ES, b.id, { observaciones: 'Solo el texto' });
    expect([retocado.plantillaId, retocado.baseTotal, retocado.ivaTotal, retocado.observaciones]).toEqual(['default', 90, 18.9, 'Solo el texto']);
    // Con lineas se mira la serie: la A no lleva descuento.
    await expect(incomeInvoicesService.actualizarBorrador(ES, b.id, { lineas: conDescuento })).rejects.toMatchObject({
      statusCode: 400,
      details: { codigo: 'DESCUENTO_NO_ADMITIDO' },
    });
    const emitida = await incomeInvoicesService.finalizar(ES, b.id, { fechaEmision: '2026-03-04' });
    expect([emitida.serie, emitida.plantillaId, emitida.baseTotal, emitida.totalFactura]).toEqual(['A', 'default', 90, 108.9]);
  });

  it('pasar a factura una proforma estandar con descuento: a la serie S (sin la A), no a la A', async () => {
    const p = await alta({ proforma: true, lineas: [{ descripcion: 'Azulejo', cantidad: 3, precioUnitario: 10, descuentoPorcentaje: 5, tipoIva: 21 }] });
    expect(p.plantillaId).toBe('default');
    const f = await incomeInvoicesService.pasarProformaAFactura(ES, p.id);
    expect([f.serie, f.plantillaId, f.estadoDocumento, f.baseTotal]).toEqual(['S', 'default', 'BORRADOR', 28.5]);
  });

  it('duplicar una factura con descuento de la serie A, que ahora usa la A: el borrador va a la S', async () => {
    await actualizarSerie(ES, serieA, { plantilla: 'default' });
    const f = await alta({ lineas: [{ descripcion: 'Antigua', cantidad: 1, precioUnitario: 100, descuentoPorcentaje: 10, tipoIva: 21 }] });
    await actualizarSerie(ES, serieA, { plantilla: null });
    const copia = await incomeInvoicesService.duplicar(ES, f.id);
    expect([copia.serie, copia.plantillaId, copia.estadoDocumento, copia.baseTotal]).toEqual(['S', 'default', 'BORRADOR', 90]);
  });
});

describe('IEEPNR en una venta que sale de España', () => {
  it('exportacion: el IEEPNR se cobra con un aviso que no bloquea, al guardar, al cambiar el borrador y al emitir; en una nacional, sin aviso', async () => {
    const ma = (await prisma.customer.create({ data: { companyId: ES, nombreFiscal: 'CLIENT FICTIF SARL', nifCif: 'MA123456', pais: 'MA', municipio: 'Casablanca' } })).id;
    const codigos = (f: { avisosFiscales?: Array<{ codigo: string }> }) => (f.avisosFiscales ?? []).map((a) => a.codigo);
    const b = await alta({ borrador: true, customer: { id: ma }, tipoOperacion: 'EXPORTACION', lineas: lineasNz({ tipoIva: 0 }) });
    expect([b.tipoOperacion, b.resumenEnvases?.ieepnr, b.ivaTotal]).toEqual(['EXPORTACION', 177.75, 0]);
    expect(codigos(b)).toContain('IEEPNR_VENTA_FUERA');
    expect(codigos(await incomeInvoicesService.actualizarBorrador(ES, b.id, { observaciones: 'Puerto de Valencia' }))).toContain('IEEPNR_VENTA_FUERA');
    const emitida = await incomeInvoicesService.finalizar(ES, b.id, { fechaEmision: '2026-03-04' });
    expect([emitida.estadoDocumento, emitida.baseTotal]).toEqual(['FINAL', TOTALES_NZ004.base]);
    expect(codigos(emitida)).toContain('IEEPNR_VENTA_FUERA');
    expect(codigos(await alta({ borrador: true }))).not.toContain('IEEPNR_VENTA_FUERA');
  });
});

describe('errores 400 nuevos', () => {
  const rechaza = async (extra: Record<string, unknown>, details: object) => {
    await expect(alta({ borrador: true, ...extra })).rejects.toMatchObject({ statusCode: 400, details });
  };

  it('PLANTILLA_SIN_ENVASES en una serie con la plantilla de siempre', async () => {
    await rechaza({ serie: 'S' }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'lineas.0.packs' });
    await rechaza({ serie: 'S', lineas: lineasNz({ packs: null }) }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'lineas.0.kgPlastico' });
    await rechaza({ serie: 'S', lineas: lineasNz({ packs: null, kgPlastico: null }) }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'lineas.0.textoAdicional' });
    await rechaza({ serie: 'S', pesoBrutoKg: 10, lineas: lineasNz({ packs: null, kgPlastico: null, textoAdicional: null }) }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'pesoBrutoKg' });
  });

  it('DESCUENTO_NO_ADMITIDO en la A', async () => {
    await rechaza({ lineas: lineasNz({ descuentoPorcentaje: 5 }) }, { codigo: 'DESCUENTO_NO_ADMITIDO', campo: 'lineas.0.descuentoPorcentaje' });
  });

  it('SIGNO_ENVASES: kg o packs con otro signo que las unidades', async () => {
    const l = lineasNz();
    await rechaza({ lineas: [{ ...l[0], kgPlastico: -1 }] }, { codigo: 'SIGNO_ENVASES', campo: 'lineas.0.kgPlastico' });
    await rechaza({ lineas: [l[0], { ...l[1], packs: -3 }] }, { codigo: 'SIGNO_ENVASES', campo: 'lineas.1.packs' });
  });

  it('IEEPNR_SOLO_EUROS: con IEEPNR en otra moneda', async () => {
    await rechaza({ moneda: 'USD', tipoCambio: 1.1, lineas: lineasNz({ moneda: 'USD' } as never) }, { codigo: 'IEEPNR_SOLO_EUROS', campo: 'moneda' });
    // Sin kg (sin IEEPNR) en USD si vale.
    const f = await alta({ borrador: true, moneda: 'USD', tipoCambio: 1.1, lineas: lineasNz({ moneda: 'USD', kgPlastico: null } as never) });
    expect([f.moneda, f.resumenEnvases?.ieepnr]).toEqual(['USD', 0]);
  });

  it('formato no valido: 400 con su campo', async () => {
    const l = lineasNz();
    await rechaza({ lineas: [{ ...l[0], packs: 1.5 }] }, { campo: 'lineas.0.packs' });
    await rechaza({ lineas: [{ ...l[0], kgPlastico: 'mucho' }] }, { campo: 'lineas.0.kgPlastico' });
    await rechaza({ lineas: [{ ...l[0], textoAdicional: 'x'.repeat(501) }] }, { campo: 'lineas.0.textoAdicional' });
    await rechaza({ lineas: [{ ...l[0], textoAdicional: '1\n2\n3\n4\n5\n6\n7' }] }, { campo: 'lineas.0.textoAdicional' });
    await rechaza({ pesoBrutoKg: -1 }, { campo: 'pesoBrutoKg' });
    await rechaza({ pesoBrutoKg: 1.0001 }, { campo: 'pesoBrutoKg' });
  });

  it('una factura rechazada por sus envases no deja creado el cliente nuevo', async () => {
    const antes = await prisma.customer.count({ where: { companyId: ES } });
    await expect(
      incomeInvoicesService.crearIngreso({
        companyId: ES,
        customer: { nuevo: { nombreFiscal: 'NO SE CREA SL', nifCif: 'B99999999' } },
        fechaEmision: '2026-03-04',
        serie: 'S',
        borrador: true,
        lineas: lineasNz(),
      }),
    ).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'PLANTILLA_SIN_ENVASES' } });
    expect(await prisma.customer.count({ where: { companyId: ES } })).toBe(antes);
  });
});

describe('empresa espanola que no repercute el IEEPNR (no vende envases)', () => {
  const SIN = `plantilla-a-sin-${SUFIJO}`;
  let clienteSin: string;
  beforeAll(async () => {
    await prisma.company.create({ data: { id: SIN, name: 'Servicios Prueba SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: SIN, denominacion: 'SERVICIOS PRUEBA SL', nif: 'B76543217' } });
    clienteSin = (await prisma.customer.create({ data: { companyId: SIN, nombreFiscal: 'CLIENTE FICTICIO SL', nifCif: 'B00000000', municipio: 'VALENCIA' } })).id;
  });

  it('su serie A sigue con la de siempre: IVA por linea y descuento por linea', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: SIN,
      customer: { id: clienteSin },
      fechaEmision: '2026-03-04',
      lineas: [
        { descripcion: 'Uno', cantidad: 1, precioUnitario: 1.03, tipoIva: 21 },
        { descripcion: 'Dos', cantidad: 1, precioUnitario: 1.03, tipoIva: 21 },
      ],
    });
    // Por linea: 0,22 + 0,22 = 0,44 (por tipo seria 2,06 x 21 % = 0,43).
    expect([f.serie, f.plantillaId, f.baseTotal, f.ivaTotal, f.totalFactura, f.resumenEnvases]).toEqual(['A', 'default', 2.06, 0.44, 2.5, null]);
    const conDescuento = await incomeInvoicesService.crearIngreso({
      companyId: SIN,
      customer: { id: clienteSin },
      fechaEmision: '2026-03-04',
      lineas: [{ descripcion: 'Con descuento', cantidad: 2, precioUnitario: 50, descuentoPorcentaje: 10, tipoIva: 21 }],
    });
    expect([conDescuento.serie, conDescuento.plantillaId, conDescuento.baseTotal]).toEqual(['A', 'default', 90]);
    expect((await textosDePdf((await generarPdfFactura(SIN, conDescuento.id)).contenido)).some((t) => t.texto === 'KG.Plast')).toBe(false);
  });
});

describe('las otras plantillas no cambian', () => {
  it('serie S (la de siempre): importes por linea, identicos al calculo de siempre, y plantillaId default', async () => {
    const lineas = lineasNz({ packs: null, kgPlastico: null, textoAdicional: null });
    const f = await alta({ serie: 'S', lineas });
    const deSiempre = calcularLineasDoc(lineas.map((l) => ({ descripcion: l.descripcion, cantidad: l.cantidad, precioUnitario: l.precioUnitario, tipoIva: 21 })));
    expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([deSiempre.totales.baseTotal, deSiempre.totales.ivaTotal, deSiempre.totales.totalFactura]);
    expect(f.baseTotal).toBe(TOTALES_NZ004.articulos);
    expect([f.plantillaId, f.resumenEnvases, f.pesoBrutoKg, f.ieepnrPorKg]).toEqual(['default', null, null, null]);
    expect(f.lineas.every((l) => l.packs === null && l.kgPlastico === null && l.ieepnrImporte === 0 && l.textoAdicional === null)).toBe(true);
  });

  it('el lector: siempre la estandar, aunque su serie tenga la A', async () => {
    await prisma.invoiceSeries.create({ data: { companyId: ES, codigo: 'LX', descripcion: 'Otro programa', tipoDocumento: 'FACTURA', activa: false, plantilla: 'A' } });
    const f = await incomeInvoicesService.crearIngreso(
      {
        companyId: ES,
        customer: { id: cliente },
        serie: 'LX',
        numero: 7,
        fechaEmision: '2026-03-05',
        lineas: [{ descripcion: 'Leida', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
      },
      { origen: 'lector', numeroLeido: 'LX-7' },
    );
    expect([f.plantillaId, f.resumenEnvases]).toEqual(['default', null]);
  });
});

describe('PDF de la factura', () => {
  it('la A sale con su diseno y sus datos; la de la serie S, con el de siempre', async () => {
    await prisma.bankAccount.create({ data: { companyId: ES, iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX', bancoNombre: 'Banco de pruebas', subcuentaCodigo: '572000' } });
    await prisma.legalConfig.update({ where: { companyId: ES }, data: { datosRegistrales: 'T 1, F 2, H CS 3', registroMercantilProvincia: 'Castellón' } });
    const a = await alta({ pesoBrutoKg: 100 });
    const { datos } = await datosPdfFactura(ES, a.id);
    expect(datos).toMatchObject({ plantilla: 'A', pesoBrutoKg: 100 });
    expect(datos.cuenta).toMatchObject({ bancoNombre: 'Banco de pruebas' });
    expect(datos.emisor).toMatchObject({ datosRegistrales: 'T 1, F 2, H CS 3', registroMercantilProvincia: 'Castellón' });
    expect(datos.lineas[0]).toMatchObject({ packs: 768, kgPlastico: 103.089, ieepnrImporte: 46.39, textoAdicional: 'Unidad 2,00 L Refrescos SR' });
    const textos = (await textosDePdf((await generarPdfFactura(ES, a.id)).contenido)).map((t) => t.texto);
    expect(textos).toEqual(expect.arrayContaining(['KG.Plast', 'PESO BRUTO(kg)', '100', '8.654,68 €', 'SWIFT BANK: CAIXESBBXXX - BANCO DE PRUEBAS']));
    expect(textos).toContain('Inscrita en el Registro Mercantil de Castellón, T 1, F 2, H CS 3, con CIF: B12345674');
    const b = await alta({ serie: 'S', lineas: lineasNz({ packs: null, kgPlastico: null, textoAdicional: null }) });
    expect((await datosPdfFactura(ES, b.id)).datos.plantilla).toBe('default');
    expect((await textosDePdf((await generarPdfFactura(ES, b.id)).contenido)).some((t) => t.texto === 'KG.Plast')).toBe(false);
  });
});
