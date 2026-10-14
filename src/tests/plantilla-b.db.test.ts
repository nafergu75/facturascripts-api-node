/**
 * Plantilla B (ceramica) y serie C sobre BD real, con las lineas de la factura
 * de muestra NZ013_2026 (cliente ficticio).
 *
 *  - La serie B usa sola la B: TOTAL BRUTO 600,74, IVA 126,16 y TOTAL 726,90;
 *    obra, peso neto y bruto, palets, cajas, m2, piezas, formato, calidad,
 *    unidad del precio y el cargo de palets (a la 704 de los ajustes).
 *  - Asiento, libro de expedidas, 303 y 347: igual que una venta normal.
 *  - Errores 400 de la B, y que las otras plantillas no la aceptan.
 *  - Borradores, proformas, duplicar y rectificativas con sus datos.
 *  - Observaciones por defecto de la serie.
 *  - Serie C: la plantilla C (la de siempre), IVA por linea y descuento.
 *
 * Pasa tambien con connection_limit=1 (como en produccion).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { actualizarSerie, crearSerie, listarSeries } from '../services/series.service';
import { calcularModelo303, calcularModelo347 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { aCentimos } from '../utils/money';
import { datosPdfFactura, generarPdfFactura } from '../services/facturaPdf.service';
import { borrarImagenFactura, guardarImagenFactura } from '../services/imagenesFactura.service';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';

const SUFIJO = Date.now();
const ES = `plantilla-b-${SUFIJO}`;
/** Empresa de EE. UU.: su serie B usa la estandar. */
const US = `plantilla-b-us-${SUFIJO}`;
const motor = new AccountingEngineController();
let cliente = '';
let clienteUs = '';

/** Las lineas de NZ013_2026 como las manda la pantalla. */
const lineasNz = (cambios: Partial<CrearLineaIngresoDTO> = {}): CrearLineaIngresoDTO[] =>
  LINEAS_NZ013.map((l) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    ...(l.cargoPalets
      ? { cargoPalets: true }
      : { palets: l.palets, cajas: l.cajas, metros2: l.metros2, piezas: l.piezas, formato: l.formato, calidad: l.calidad, unidadPrecio: l.unidadPrecio }),
    ...cambios,
  }));

const alta = (extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({
    companyId: ES,
    customer: { id: cliente },
    serie: 'B',
    fechaEmision: '2026-07-10',
    lineas: lineasNz(),
    obra: TOTALES_NZ013.obra,
    pesoNetoKg: TOTALES_NZ013.pesoNetoKg,
    pesoBrutoKg: TOTALES_NZ013.pesoBrutoKg,
    observaciones: TOTALES_NZ013.observaciones,
    ...extra,
  } as never);

/** Las cifras exactas de NZ013_2026 en una respuesta. */
function cifrasMuestra(f: Awaited<ReturnType<typeof alta>>) {
  expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([TOTALES_NZ013.base, TOTALES_NZ013.iva, TOTALES_NZ013.total]);
  expect([f.baseTotalDoc, f.ivaTotalDoc, f.totalFacturaDoc]).toEqual([TOTALES_NZ013.base, TOTALES_NZ013.iva, TOTALES_NZ013.total]);
  expect(f.plantillaId).toBe('B');
  expect(f.lineas.map((l) => l.baseLineDoc)).toEqual(LINEAS_NZ013.map((l) => l.importe));
  expect(f.resumenCeramica).toEqual({
    palets: TOTALES_NZ013.palets,
    cajas: TOTALES_NZ013.cajas,
    metros2: TOTALES_NZ013.metros2,
    piezas: TOTALES_NZ013.piezas,
    pesoKg: 0,
    cargoPalets: { cantidad: 1, importe: 9 },
  });
}

/** Debe y haber (en centimos) por cuenta; la del cliente, como «430N». */
async function asiento(companyId: string, invoiceId: string) {
  const r = await motor.contabilizarFacturaIngreso(companyId, invoiceId);
  const lineas = await prisma.journalEntryLine.findMany({ where: { entryId: r.journalEntryId } });
  const por: Record<string, [number, number]> = {};
  for (const l of lineas) {
    const c = l.accountCode.startsWith('43') ? '430N' : l.accountCode;
    const [d, h] = por[c] ?? [0, 0];
    por[c] = [d + aCentimos(Number(l.debe)), h + aCentimos(Number(l.haber))];
  }
  return por;
}

const error = (p: Promise<unknown>) => p.then(() => null, (e) => e as { statusCode: number; details?: Record<string, unknown>; message: string });

let emitidaId = '';

beforeAll(async () => {
  await prisma.company.create({ data: { id: ES, name: 'Ceramica Prueba SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: ES, denominacion: 'CERAMICA PRUEBA SL', nif: 'B12345674' } });
  await asegurarPlanContableEmpresa(ES);
  cliente = (
    await prisma.customer.create({
      data: { companyId: ES, nombreFiscal: 'CLIENTE FICTICIO OBRAS SL', nifCif: 'B00000000', direccion: 'CALLE FALSA, 1', cp: '46000', municipio: 'VALENCIA', provincia: 'VALENCIA' },
    })
  ).id;
  await listarSeries(ES);
  await crearSerie(ES, { codigo: 'B', descripcion: 'Ceramica y materiales', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  // El cargo de palets va a la 704 (ventas de envases y embalajes).
  await guardarAjustesFacturacion(ES, 'u-test', { cuentaPalets: '704' });

  await prisma.company.create({ data: { id: US, name: 'Tiles Inc', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: US, denominacion: 'TILES INC', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
  clienteUs = (await prisma.customer.create({ data: { companyId: US, nombreFiscal: 'US CUSTOMER LLC', nifCif: '98-7654321', pais: 'US' } })).id;
  await listarSeries(US);
  await crearSerie(US, { codigo: 'B', descripcion: 'Tiles', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
});

describe('NZ013_2026 con la plantilla B', () => {
  it('emitida en la serie B: las cifras exactas de la muestra, sin indicar la plantilla', async () => {
    const f = await alta();
    emitidaId = f.id;
    cifrasMuestra(f);
    expect([f.estadoDocumento, f.serie, f.obra, f.pesoNetoKg, f.pesoBrutoKg]).toEqual(['FINAL', 'B', null, 353, 373]);
    expect(f.observaciones).toBe(TOTALES_NZ013.observaciones);
    expect(f.lineas[0]).toMatchObject({
      palets: 0,
      cajas: 3,
      metros2: 5.04,
      piezas: 18,
      formato: '23,3x120',
      calidad: '1',
      unidadPrecio: 'M2',
      cantidad: 5.04,
      textoAdicional: 'PORCELANICO RECTIFICADO',
      cargoPalets: false,
      cuenta: null,
    });
    expect(f.lineas[1]).toMatchObject({ palets: 1, cajas: 10, metros2: 7.9, piezas: 20, unidadPrecio: 'PIEZA', cantidad: 20 });
    // El cargo de palets: por unidad, sin medidas y a la 704 de los ajustes.
    expect(f.lineas[2]).toMatchObject({ cargoPalets: true, unidadPrecio: 'UNIDAD', cantidad: 1, palets: null, piezas: null, cuenta: '704' });
    // Lo guardado en la BD.
    const fila = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id }, include: { lineas: true } });
    expect([fila.plantillaId, Number(fila.pesoNetoKg), Number(fila.pesoBrutoKg), Number(fila.baseTotal), Number(fila.ivaTotal)]).toEqual(['B', 353, 373, 600.74, 126.16]);
    expect(fila.lineas.map((l) => [l.palets, l.cajas, Number(l.metros2), Number(l.piezas), l.unidadPrecio, l.cargoPalets])).toEqual([
      [0, 3, 5.04, 18, 'M2', false],
      [1, 10, 7.9, 20, 'PIEZA', false],
      [null, null, 0, 0, 'UNIDAD', true],
    ]);
    expect(fila.lineas.reduce((a, l) => a + aCentimos(Number(l.ivaImporte)), 0)).toBe(12616);
    cifrasMuestra(await incomeInvoicesService.obtenerPorId(ES, f.id));
  });

  it('borrador con la obra; al emitirlo las cifras no cambian', async () => {
    const b = await alta({ borrador: true, obra: '  Reforma   vivienda C/ Falsa 1 ' });
    expect(b.obra).toBe('Reforma vivienda C/ Falsa 1');
    cifrasMuestra(b);
    const f = await incomeInvoicesService.finalizar(ES, b.id, { fechaEmision: '2026-07-10' });
    cifrasMuestra(f);
    expect([f.obra, f.pesoNetoKg, f.pesoBrutoKg]).toEqual(['Reforma vivienda C/ Falsa 1', 353, 373]);
  });

  it('la cantidad sale de los m2 o de las piezas si no llega distinta; el cargo con su propia cuenta la conserva', async () => {
    const lineas = lineasNz();
    lineas[0] = { ...lineas[0], metros2: null } as never;
    lineas[1] = { ...lineas[1], piezas: null } as never;
    lineas[2] = { ...lineas[2], cuenta: '705' };
    const f = await alta({ borrador: true, lineas });
    expect(f.lineas.map((l) => [l.metros2, l.piezas, l.cuenta])).toEqual([
      [5.04, 18, null],
      [7.9, 20, null],
      [null, null, '705'],
    ]);
    cifrasMuestra(f);
  });
});

describe('PDF', () => {
  it('lleva los datos de la B, el logo de la marca y el sello de los ajustes; el de la serie C no los carga', async () => {
    let { datos } = await datosPdfFactura(ES, emitidaId);
    expect([datos.plantilla, datos.pesoNetoKg, datos.pesoBrutoKg, datos.logoMarca, datos.sello]).toEqual(['B', 353, 373, null, null]);
    expect(datos.lineas.map((l) => [l.palets ?? null, l.cajas ?? null, l.metros2 ?? null, l.piezas ?? null, l.unidadPrecio, l.cargoPalets ?? false])).toEqual([
      [0, 3, 5.04, 18, 'M2', false],
      [1, 10, 7.9, 20, 'PIEZA', false],
      [null, null, null, null, 'UNIDAD', true],
    ]);
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await guardarImagenFactura(ES, 'MARCA', PNG);
    await guardarImagenFactura(ES, 'SELLO', PNG);
    ({ datos } = await datosPdfFactura(ES, emitidaId));
    expect([datos.logoMarca?.mime, datos.sello?.mime]).toEqual(['image/png', 'image/png']);
    const { contenido } = await generarPdfFactura(ES, emitidaId);
    expect(contenido.subarray(0, 5).toString()).toBe('%PDF-');
    const c = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: cliente }, serie: 'C', fechaEmision: '2026-07-10', borrador: true, lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 1 }] } as never);
    ({ datos } = await datosPdfFactura(ES, c.id));
    expect([datos.plantilla, datos.logoMarca, datos.sello]).toEqual(['C', undefined, undefined]);
    await borrarImagenFactura(ES, 'MARCA');
    await borrarImagenFactura(ES, 'SELLO');
  });
});

describe('contabilidad e impuestos, como una venta normal', () => {
  it('asiento: 430 al Debe 726,90; al Haber 700 por 591,74, 704 por el cargo de palets (9,00) y 477 por 126,16', async () => {
    expect(await asiento(ES, emitidaId)).toEqual({ '430N': [72690, 0], '700': [0, 59174], '704': [0, 900], '477': [0, 12616] });
  });

  it('libro de expedidas y 303 del 3T: la base con el cargo de palets', async () => {
    const libro = await prisma.vATBook.findMany({ where: { companyId: ES } });
    expect(libro.map((l) => [l.tipoIva, Number(l.baseImponible), Number(l.cuotaIva)])).toEqual([[21, 600.74, 126.16]]);
    // En el 3T hay dos emitidas de la muestra (la de arriba y el borrador ya emitido).
    const m = await calcularModelo303(ES, periodoFiscal(2026, '3T'));
    expect(m.ivaDevengado.find((d) => d.tipo === 21)).toEqual({ tipo: 21, base: 1201.48, cuota: 252.32 });
  });

  it('347: con cinco facturas de la muestra el cliente pasa de 3.005,06 € y sale con su total', async () => {
    for (let i = 0; i < 3; i++) await alta();
    const m = await calcularModelo347(ES, 2026);
    expect(m.operaciones.map((o) => [o.cifnif, o.tipo, o.baseAnual])).toEqual([['B00000000', 'cliente', 3634.5]]);
  });
});

describe('errores 400 de la plantilla B', () => {
  const rechaza = async (extra: Record<string, unknown>, detalles: Record<string, unknown>) => {
    const e = await error(alta({ borrador: true, ...extra }));
    expect(e).not.toBeNull();
    expect([e!.statusCode, e!.details]).toEqual([400, detalles]);
    return e!;
  };

  it('DESCUENTO_NO_ADMITIDO: la B no lleva descuento por linea', async () => {
    await rechaza({ lineas: lineasNz({ descuentoPorcentaje: 10 }) }, { codigo: 'DESCUENTO_NO_ADMITIDO', campo: 'lineas.0.descuentoPorcentaje' });
  });

  it('CANTIDAD_NO_CUADRA: el precio va por m2 o por pieza y la cantidad no es ese dato', async () => {
    const m2 = lineasNz();
    m2[0] = { ...m2[0], cantidad: 5 };
    await rechaza({ lineas: m2 }, { codigo: 'CANTIDAD_NO_CUADRA', campo: 'lineas.0.metros2' });
    const pz = lineasNz();
    pz[1] = { ...pz[1], cantidad: 19 };
    await rechaza({ lineas: pz }, { codigo: 'CANTIDAD_NO_CUADRA', campo: 'lineas.1.piezas' });
  });

  it('PIEZAS_ENTERAS: por pieza, la cantidad es entera', async () => {
    const l = lineasNz();
    l[1] = { ...l[1], cantidad: 2.5, piezas: null } as never;
    await rechaza({ lineas: l }, { codigo: 'PIEZAS_ENTERAS', campo: 'lineas.1.piezas' });
  });

  it('SIGNO_MEDIDAS: las medidas con otro signo que la cantidad', async () => {
    const l = lineasNz();
    l[0] = { ...l[0], cajas: -3 };
    await rechaza({ lineas: l }, { codigo: 'SIGNO_MEDIDAS', campo: 'lineas.0.cajas' });
  });

  it('CARGO_PALETS_CON_MEDIDAS: el cargo de palets no lleva m2, cajas ni formato, y va por unidad', async () => {
    const l = lineasNz();
    l[2] = { ...l[2], cajas: 1 };
    await rechaza({ lineas: l }, { codigo: 'CARGO_PALETS_CON_MEDIDAS', campo: 'lineas.2.cajas' });
    const u = lineasNz();
    u[2] = { ...u[2], unidadPrecio: 'M2' };
    await rechaza({ lineas: u }, { codigo: 'CARGO_PALETS_CON_MEDIDAS', campo: 'lineas.2.unidadPrecio' });
  });

  it('formato no valido: 400 con su campo', async () => {
    for (const [cambio, campo] of [
      [{ palets: 1.5 }, 'lineas.0.palets'],
      [{ cajas: 'tres' }, 'lineas.0.cajas'],
      [{ metros2: 'mucho' }, 'lineas.0.metros2'],
      [{ formato: 'x'.repeat(41) }, 'lineas.0.formato'],
      [{ calidad: 'PRIMERA CAL' }, 'lineas.0.calidad'],
      [{ unidadPrecio: 'CAJA' }, 'lineas.0.unidadPrecio'],
      [{ cargoPalets: 'si' }, 'lineas.0.cargoPalets'],
    ] as const) {
      const l = lineasNz();
      l[0] = { ...l[0], ...(cambio as object) };
      const e = await error(alta({ borrador: true, lineas: l }));
      expect([e!.statusCode, e!.details?.campo]).toEqual([400, campo]);
    }
    for (const [cambio, campo] of [
      [{ obra: 'x'.repeat(201) }, 'obra'],
      [{ obra: 7 }, 'obra'],
      [{ pesoNetoKg: -1 }, 'pesoNetoKg'],
      [{ pesoNetoKg: 1.2345 }, 'pesoNetoKg'],
    ] as const) {
      const e = await error(alta({ borrador: true, ...cambio }));
      expect([e!.statusCode, e!.details?.campo]).toEqual([400, campo]);
    }
  });

  it('PLANTILLA_SIN_CERAMICA: la serie A (estandar) y la C no aceptan datos de ceramica, obra ni peso neto', async () => {
    const simple = [{ descripcion: 'x', cantidad: 1, precioUnitario: 1 }];
    for (const serie of ['A', 'C']) {
      await rechaza({ serie, pesoBrutoKg: null }, { codigo: 'PLANTILLA_SIN_CERAMICA', campo: 'pesoNetoKg' });
      await rechaza({ serie, pesoNetoKg: null, pesoBrutoKg: null }, { codigo: 'PLANTILLA_SIN_CERAMICA', campo: 'lineas.0.palets' });
      await rechaza({ serie, obra: 'Obra', pesoNetoKg: null, pesoBrutoKg: null, lineas: simple }, { codigo: 'PLANTILLA_SIN_CERAMICA', campo: 'obra' });
      await rechaza(
        { serie, pesoNetoKg: null, pesoBrutoKg: null, lineas: [{ descripcion: 'Palets', cantidad: 1, precioUnitario: 9, cargoPalets: true }] },
        { codigo: 'PLANTILLA_SIN_CERAMICA', campo: 'lineas.0.cargoPalets' },
      );
      // El peso bruto y el texto adicional tampoco (solo la A y la B los llevan).
      await rechaza({ serie, pesoNetoKg: null, lineas: simple }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'pesoBrutoKg' });
      await rechaza({ serie, pesoNetoKg: null, pesoBrutoKg: null, lineas: [{ ...simple[0], textoAdicional: 'Texto' }] }, { codigo: 'PLANTILLA_SIN_ENVASES', campo: 'lineas.0.textoAdicional' });
    }
  });

  it('empresa de EE. UU.: su serie B usa la estandar y no acepta datos de ceramica', async () => {
    const e = await error(
      incomeInvoicesService.crearIngreso({ companyId: US, customer: { id: clienteUs }, serie: 'B', fechaEmision: '2026-07-10', borrador: true, lineas: lineasNz() } as never),
    );
    expect(e!.details).toMatchObject({ codigo: 'PLANTILLA_SIN_CERAMICA' });
    const f = await incomeInvoicesService.crearIngreso({
      companyId: US,
      customer: { id: clienteUs },
      serie: 'B',
      fechaEmision: '2026-07-10',
      borrador: true,
      lineas: [{ descripcion: 'Tiles', cantidad: 2, precioUnitario: 10 }],
    } as never);
    expect([f.plantillaId, f.resumenCeramica]).toEqual(['default', null]);
  });
});

describe('borradores, copias y rectificativas', () => {
  it('un borrador de la B que pasa a la C con datos de ceramica: 400; con lineas normales, sin obra ni pesos', async () => {
    const b = await alta({ borrador: true, obra: 'Obra 1' });
    const e = await error(incomeInvoicesService.actualizarBorrador(ES, b.id, { serie: 'C' }));
    expect(e!.details).toMatchObject({ codigo: 'PLANTILLA_SIN_CERAMICA' });
    const c = await incomeInvoicesService.actualizarBorrador(ES, b.id, { serie: 'C', lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }] });
    expect([c.serie, c.plantillaId, c.obra, c.pesoNetoKg, c.pesoBrutoKg, c.resumenCeramica]).toEqual(['C', 'C', null, null, null, null]);
  });

  it('cambiar la obra y el peso neto de un borrador; null los quita', async () => {
    const b = await alta({ borrador: true });
    let f = await incomeInvoicesService.actualizarBorrador(ES, b.id, { obra: 'Obra nueva', pesoNetoKg: 350.5 });
    expect([f.obra, f.pesoNetoKg]).toEqual(['Obra nueva', 350.5]);
    cifrasMuestra(f);
    f = await incomeInvoicesService.actualizarBorrador(ES, b.id, { obra: null, pesoNetoKg: null });
    expect([f.obra, f.pesoNetoKg, f.pesoBrutoKg]).toEqual([null, null, 373]);
  });

  it('duplicar: a la serie B con sus datos; una proforma en la B pasa a factura en la B', async () => {
    const copia = await incomeInvoicesService.duplicar(ES, emitidaId);
    expect([copia.serie, copia.plantillaId, copia.estadoDocumento, copia.pesoNetoKg, copia.observaciones]).toEqual(['B', 'B', 'BORRADOR', 353, TOTALES_NZ013.observaciones]);
    cifrasMuestra(copia);
    // La serie P con la plantilla B.
    const p = (await listarSeries(ES, 'PROFORMA')).find((s) => s.codigo === 'P')!;
    await actualizarSerie(ES, p.id, { plantilla: 'B' });
    const proforma = await alta({ serie: undefined, proforma: true });
    expect([proforma.serie, proforma.plantillaId]).toEqual(['P', 'B']);
    cifrasMuestra(proforma);
    const factura = await incomeInvoicesService.pasarProformaAFactura(ES, proforma.id);
    expect([factura.serie, factura.plantillaId, factura.pesoNetoKg, factura.pesoBrutoKg]).toEqual(['B', 'B', 353, 373]);
    cifrasMuestra(factura);
    await actualizarSerie(ES, p.id, { plantilla: null });
  });

  it('duplicar sin ninguna serie con la B: 400 SIN_SERIE_CERAMICA', async () => {
    const b = (await listarSeries(ES, 'FACTURA')).find((s) => s.codigo === 'B')!;
    await actualizarSerie(ES, b.id, { plantilla: 'default' });
    const e = await error(incomeInvoicesService.duplicar(ES, emitidaId));
    expect(e!.details).toMatchObject({ codigo: 'SIN_SERIE_CERAMICA', campo: 'serie' });
    await actualizarSerie(ES, b.id, { plantilla: null });
  });

  it('anular la factura (rectificativa total): todo en negativo, con sus medidas, el cargo de palets y la obra', async () => {
    const o = await alta({ obra: 'Obra a anular' });
    await asiento(ES, o.id);
    const r = await incomeInvoicesService.crearRectificativa(ES, o.id, { motivo: 'Anulación' });
    expect([r.plantillaId, r.baseTotal, r.ivaTotal, r.totalFactura, r.obra]).toEqual(['B', -600.74, -126.16, -726.9, 'Obra a anular']);
    expect(r.lineas.map((l) => [l.cantidad, l.palets, l.cajas, l.metros2, l.piezas, l.unidadPrecio, l.cargoPalets])).toEqual([
      [-5.04, 0, -3, -5.04, -18, 'M2', false],
      [-20, -1, -10, -7.9, -20, 'PIEZA', false],
      [-1, null, null, null, null, 'UNIDAD', true],
    ]);
    expect(r.resumenCeramica).toMatchObject({ palets: -1, cajas: -13, metros2: -12.94, piezas: -38, cargoPalets: { cantidad: -1, importe: -9 } });
    expect(await asiento(ES, r.id)).toEqual({ '430N': [-72690, 0], '700': [0, -59174], '704': [0, -900], '477': [0, -12616] });
  });

  it('rectificativa por diferencias de una B: devuelve 2 piezas del peldaño', async () => {
    const o = await alta();
    const r = await incomeInvoicesService.crearIngreso({
      companyId: ES,
      customer: {},
      lineas: [{ descripcion: 'PELDAÑO MULTIESTEP', cantidad: -2, precioUnitario: 26.5, tipoIva: 21, piezas: -2, unidadPrecio: 'PIEZA', formato: '33X120' }],
      rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelven 2 piezas', originales: [{ id: o.id }] },
    } as never);
    expect([r.plantillaId, r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual(['B', -53, -11.13, -64.13]);
    expect(r.resumenCeramica).toMatchObject({ piezas: -2, cajas: 0 });
  });
});

describe('observaciones por defecto de la serie', () => {
  it('sin observaciones en el cuerpo, las de la serie; vacias, se quedan vacias', async () => {
    const b = (await listarSeries(ES, 'FACTURA')).find((s) => s.codigo === 'B')!;
    await actualizarSerie(ES, b.id, { observacionesDefecto: 'ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE' });
    const con = await alta({ borrador: true, observaciones: undefined });
    expect(con.observaciones).toBe('ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE');
    const vacia = await alta({ borrador: true, observaciones: '' });
    expect(vacia.observaciones ?? '').toBe('');
    const propia = await alta({ borrador: true, observaciones: 'Portes pagados' });
    expect(propia.observaciones).toBe('Portes pagados');
    // Un borrador guardado no las toma al cambiarlo.
    const f = await incomeInvoicesService.actualizarBorrador(ES, vacia.id, { fechaEmision: '2026-07-11' });
    expect(f.observaciones ?? '').toBe('');
    await actualizarSerie(ES, b.id, { observacionesDefecto: null });
  });
});

describe('serie C: la plantilla de siempre, con su nombre', () => {
  it('una factura de la serie C: plantilla C, IVA por linea, descuento y numeracion propia', async () => {
    const lineas = [
      { descripcion: 'Montaje', cantidad: 1, precioUnitario: 1.03, tipoIva: 21 },
      { descripcion: 'Desplazamiento', cantidad: 1, precioUnitario: 1.03, tipoIva: 21, descuentoPorcentaje: 10 },
    ];
    const f = await incomeInvoicesService.crearIngreso({ companyId: ES, customer: { id: cliente }, serie: 'C', fechaEmision: '2026-07-12', lineas } as never);
    expect([f.serie, f.numeroCompleto, f.plantillaId, f.resumenCeramica, f.resumenEnvases]).toEqual(['C', 'C-1', 'C', null, null]);
    // IVA por linea: 0,22 + 0,20 = 0,42 (por tipo saldria 0,41: 1,96 × 21 % = 0,4116).
    expect(f.lineas.map((l) => [l.baseLine, l.ivaImporte])).toEqual([
      [1.03, 0.22],
      [0.93, 0.2],
    ]);
    expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([1.96, 0.42, 2.38]);
    // Las de la A y la B siguen su numeracion.
    const b = await alta();
    expect(b.numeroCompleto).toMatch(/^B-\d+$/);
  });
});
