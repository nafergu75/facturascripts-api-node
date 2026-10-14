/**
 * Rectificativas de facturas con la plantilla A (envases e IEEPNR), sobre BD real.
 *
 *  - La total espejo de NZ004_26 deja a cero base, IVA, total, IEEPNR y kg
 *    (con el bloque nuevo y por /credit-note).
 *  - Por diferencias con una linea de -kg: IEEPNR simetrico.
 *  - Por diferencias, una linea de 0 uds con kg corrige solo los kg y su
 *    IEEPNR (sin packs); en una factura o por sustitucion, 400 UDS_CERO.
 *  - Por sustitucion: la diferencia lleva el IEEPNR.
 *  - El tipo del IEEPNR es el de la original aunque los ajustes hayan cambiado.
 *  - La plantilla se hereda de la original aunque la serie R sea estandar.
 *  - Con dos originales A, el reparto cuadra con el IVA por tipo.
 *  - GET /:id/rectificar trae la plantilla, el tipo y los datos de envase.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { datosParaRectificarVenta } from '../services/rectificativasVenta.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { crearSerie, listarSeries } from '../services/series.service';
import type { HttpError } from '../utils/http-errors';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';

const E = `plantilla-a-rect-${Date.now()}`;
let cliente = '';

const lineasNz = (signo: 1 | -1 = 1): CrearLineaIngresoDTO[] =>
  LINEAS_NZ004.map((l) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: signo * l.packs,
    cantidad: signo * l.cantidad,
    kgPlastico: signo * l.kgPlastico,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
  }));

const emitir = (extra: Partial<CrearFacturaIngresoDTO> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, fechaEmision: '2026-03-04', lineas: lineasNz(), ...extra } as CrearFacturaIngresoDTO);

const rect = (rectificativa: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas: lineasNz(-1),
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelven la mercancía', ...rectificativa },
    ...extra,
  } as unknown as CrearFacturaIngresoDTO);

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

const cent = (n: number) => Math.round(n * 100);

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Rectificativas Envases SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'RECTIFICATIVAS ENVASES SL', nif: 'B12345674' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'CLIENTE FICTICIO BEBIDAS SL', nifCif: '00000000T' } })).id;
  await listarSeries(E);
  await crearSerie(E, { codigo: 'B', descripcion: 'Ceramica', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  await guardarAjustesFacturacion(E, 'u-test', { ieepnrRepercute: true });
});

describe('rectificativa total (espejo)', () => {
  it('con el bloque y las lineas espejo: base, IVA, total, IEEPNR y kg a cero', async () => {
    const o = await emitir();
    expect([o.baseTotal, o.ivaTotal, o.totalFactura]).toEqual([TOTALES_NZ004.base, TOTALES_NZ004.iva, TOTALES_NZ004.total]);
    const r = await rect({ originales: [{ id: o.id }] });
    expect([r.serie, r.plantillaId, r.ieepnrPorKg]).toEqual(['R', 'A', 0.45]);
    expect([r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual([-TOTALES_NZ004.base, -TOTALES_NZ004.iva, -TOTALES_NZ004.total]);
    expect(r.resumenEnvases).toEqual({ kgPlastico: -TOTALES_NZ004.kgPlastico, packs: -TOTALES_NZ004.packs, uds: -TOTALES_NZ004.uds, ieepnr: -TOTALES_NZ004.ieepnr });
    r.lineas.forEach((l, i) => {
      expect(cent(l.baseLine) + cent(o.lineas[i].baseLine)).toBe(0);
      expect(cent(l.ivaImporte) + cent(o.lineas[i].ivaImporte)).toBe(0);
      expect(cent(l.ieepnrImporte) + cent(o.lineas[i].ieepnrImporte)).toBe(0);
      expect(l.kgPlastico).toBe(-o.lineas[i].kgPlastico!);
      expect(l.packs).toBe(-o.lineas[i].packs!);
    });
    expect(r.lineas.map((l) => l.textoAdicional)).toEqual(LINEAS_NZ004.map((l) => l.textoAdicional));
  });

  it('por /credit-note (sin lineas): el espejo lleva los kg, los packs y el IEEPNR en negativo', async () => {
    const o = await emitir();
    const r = await incomeInvoicesService.crearRectificativa(E, o.id, { motivo: 'Anulación' });
    expect([r.plantillaId, r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual(['A', -TOTALES_NZ004.base, -TOTALES_NZ004.iva, -TOTALES_NZ004.total]);
    expect(r.resumenEnvases).toEqual({ kgPlastico: -394.992, packs: -9826, uds: -46320, ieepnr: -177.75 });
    const filas = await prisma.incomeInvoiceLine.findMany({ where: { invoiceId: r.id } });
    expect(filas.reduce((a, l) => a + cent(Number(l.ieepnrImporte)), 0)).toBe(-17775);
  });

  it('por /credit-note con lineas: conserva los kg y calcula su IEEPNR', async () => {
    const o = await emitir();
    const r = await incomeInvoicesService.crearRectificativa(E, o.id, {
      motivo: 'Devolución de un pack',
      lineas: [{ descripcion: 'Devolución', cantidad: -4, precioUnitario: 0.162, packs: -1, kgPlastico: -0.134, tipoIva: 21 }],
    });
    // -0,134 × 0,45 = -0,0603 -> -0,06; base = -0,65 - 0,06 = -0,71
    expect(r.lineas[0]).toMatchObject({ packs: -1, kgPlastico: -0.134, ieepnrImporte: -0.06, baseLine: -0.71 });
  });
});

describe('por diferencias', () => {
  it('una linea de -kg: IEEPNR simetrico (-0,1 kg da -0,05, no -0,04)', async () => {
    const o = await emitir();
    const r = await rect({ originales: [{ id: o.id }] }, { lineas: [{ descripcion: 'Devolución', cantidad: -1, precioUnitario: 0.162, kgPlastico: -0.1, tipoIva: 21 }] });
    expect(r.lineas[0]).toMatchObject({ kgPlastico: -0.1, ieepnrImporte: -0.05, baseLine: -0.21 });
    expect([r.baseTotal, r.ivaTotal]).toEqual([-0.21, -0.04]);
  });

  it('solo los kg: una linea de 0 uds con kg corrige el IEEPNR sin tocar las uds, a la baja y al alza', async () => {
    const o = await emitir();
    const baja = await rect({ originales: [{ id: o.id }] }, { lineas: [{ descripcion: 'Corrección de kg', cantidad: 0, precioUnitario: 0.162, kgPlastico: -10, tipoIva: 21 }] });
    // -10 kg × 0,45 = -4,50; IVA por tipo -4,50 × 21 % = -0,945 -> -0,95.
    expect(baja.lineas[0]).toMatchObject({ cantidad: 0, kgPlastico: -10, ieepnrImporte: -4.5, baseLine: -4.5, packs: null });
    expect([baja.baseTotal, baja.ivaTotal, baja.totalFactura]).toEqual([-4.5, -0.95, -5.45]);
    expect(baja.resumenEnvases).toEqual({ kgPlastico: -10, packs: 0, uds: 0, ieepnr: -4.5 });
    // Al alza (faltaban kg): un error, no una devolucion.
    const sube = await rect(
      { originales: [{ id: o.id }], motivo: 'ERROR', explicacion: 'Faltaban kg de plástico' },
      { lineas: [{ descripcion: 'Faltaban kg', cantidad: 0, precioUnitario: 0, kgPlastico: 10, tipoIva: 21 }] },
    );
    expect([sube.baseTotal, sube.ivaTotal, sube.lineas[0].ieepnrImporte]).toEqual([4.5, 0.95, 4.5]);
  });

  it('0 uds: con packs, 400 PACKS_SIN_UDS; sin kg, la cantidad; en una factura o por sustitucion, 400 UDS_CERO', async () => {
    const o = await emitir();
    const linea = { descripcion: 'Corrección de kg', cantidad: 0, precioUnitario: 0, kgPlastico: -10, tipoIva: 21 };
    expect((await error(rect({ originales: [{ id: o.id }] }, { lineas: [{ ...linea, packs: -1 }] }))).details).toMatchObject({ codigo: 'PACKS_SIN_UDS', campo: 'lineas.0.packs' });
    expect((await error(rect({ originales: [{ id: o.id }] }, { lineas: [{ ...linea, kgPlastico: 0 }] }))).message).toMatch(/distinto de cero/);
    expect((await error(emitir({ lineas: [{ ...linea, kgPlastico: 10 }] }))).details).toMatchObject({ codigo: 'UDS_CERO', campo: 'lineas.0.cantidad' });
    const corregidas = [...lineasNz(), linea];
    const e = await error(rect({ forma: 'S', motivo: 'ERROR', explicacion: 'Kg mal', originales: [{ id: o.id }] }, { lineas: corregidas }));
    expect(e.details).toMatchObject({ codigo: 'UDS_CERO', campo: 'lineas.7.cantidad' });
  });

  it('usa el tipo de la original aunque los ajustes hayan cambiado', async () => {
    const o = await emitir();
    await guardarAjustesFacturacion(E, 'u-test', { ieepnrPorKg: 0.5 });
    const r = await rect({ originales: [{ id: o.id }] }, { lineas: [{ descripcion: 'Devolución', cantidad: -10, precioUnitario: 0.162, kgPlastico: -1, tipoIva: 21 }] });
    expect([r.ieepnrPorKg, r.lineas[0].ieepnrImporte]).toEqual([0.45, -0.45]);
    await guardarAjustesFacturacion(E, 'u-test', { ieepnrPorKg: 0.45 });
  });

  it('la plantilla se hereda de la original aunque la serie R sea estandar, tambien al corregir y emitir el borrador', async () => {
    const o = await emitir();
    const series = await listarSeries(E, 'RECTIFICATIVA');
    expect(series[0]).toMatchObject({ codigo: 'R', plantilla: 'default' });
    const r = await rect({ originales: [{ id: o.id }] }, { borrador: true, lineas: [{ descripcion: 'Devolución', cantidad: -1, precioUnitario: 0.162, kgPlastico: -0.5, tipoIva: 21 }] });
    expect([r.plantillaId, r.ieepnrPorKg]).toEqual(['A', 0.45]);
    // El borrador corregido (sin lineas en el cuerpo) conserva sus envases y su plantilla.
    const corregido = await incomeInvoicesService.actualizarBorrador(E, r.id, { rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Otra explicación', originales: [{ id: o.id }] } });
    expect([corregido.plantillaId, corregido.lineas[0].kgPlastico, corregido.lineas[0].ieepnrImporte]).toEqual(['A', -0.5, -0.23]);
    // Y al emitirlo, igual.
    const emitida = await incomeInvoicesService.finalizar(E, r.id);
    expect([emitida.plantillaId, emitida.lineas[0].ieepnrImporte, emitida.baseTotal]).toEqual(['A', -0.23, -0.39]);
  });

  it('con dos originales A, el reparto cuadra con el IVA por tipo', async () => {
    const a = await emitir();
    const b = await emitir();
    const lineas = [
      { descripcion: 'Devolución 1', cantidad: -1, precioUnitario: 0.162, kgPlastico: -1, tipoIva: 21 },
      { descripcion: 'Devolución 2', cantidad: -1, precioUnitario: 0.145, kgPlastico: -1, tipoIva: 21 },
    ];
    // Bases -0,61 y -0,60: por tipo, -1,21 × 21 % = -0,25 (linea a linea serian -0,26).
    const r = await rect({ originales: [{ id: a.id, base: -0.61, cuota: -0.13 }, { id: b.id, base: -0.6, cuota: -0.12 }] }, { lineas });
    expect([r.baseTotal, r.ivaTotal, r.totalFactura]).toEqual([-1.21, -0.25, -1.46]);
    expect(r.rectificativa!.originales.map((x) => [x.base, x.cuota])).toEqual([[-0.61, -0.13], [-0.6, -0.12]]);
    // El reparto linea a linea ya no cuadra.
    const e = await error(rect({ originales: [{ id: a.id, base: -0.61, cuota: -0.13 }, { id: b.id, base: -0.6, cuota: -0.13 }] }, { lineas }));
    expect(e.details).toMatchObject({ codigo: 'REPARTO_NO_CUADRA' });
  });

  it('originales con distinta plantilla: 400 ORIGINALES_INCOMPATIBLES', async () => {
    const a = await emitir();
    const b = await emitir({ serie: 'B', lineas: [{ descripcion: 'Azulejo', cantidad: 1, precioUnitario: 10, tipoIva: 21 }] });
    const e = await error(rect({ originales: [{ id: a.id, base: -1, cuota: -0.21 }, { id: b.id, base: -1, cuota: -0.21 }] }, { lineas: [{ descripcion: 'x', cantidad: -2, precioUnitario: 1, tipoIva: 21 }] }));
    expect(e.details).toMatchObject({ codigo: 'ORIGINALES_INCOMPATIBLES', campo: 'rectificativa.originales' });
  });
});

describe('por sustitucion', () => {
  it('la diferencia con la original lleva el IEEPNR', async () => {
    const o = await emitir();
    const corregidas = lineasNz();
    corregidas[0] = { ...corregidas[0], kgPlastico: 100 };
    const s = await rect({ forma: 'S', motivo: 'ERROR', explicacion: 'Kg de plástico mal puestos', originales: [{ id: o.id }] }, { lineas: corregidas });
    // 100 kg × 0,45 = 45,00 en vez de 46,39: base 7.151,24 e IVA por tipo 1.501,76.
    expect([s.plantillaId, s.baseTotal, s.ivaTotal, s.lineas[0].ieepnrImporte]).toEqual(['A', 7151.24, 1501.76, 45]);
    expect(s.rectificativa!.originales[0]).toMatchObject({ base: -1.39, cuota: -0.29 });
  });
});

describe('GET /:id/rectificar', () => {
  it('trae la plantilla y el tipo de la original, y los datos de envase de cada linea', async () => {
    const o = await emitir();
    const d = await datosParaRectificarVenta(E, o.id);
    expect(d.original).toMatchObject({ plantillaId: 'A', ieepnrPorKg: 0.45 });
    expect(d.lineas[0]).toMatchObject({ packs: 768, kgPlastico: 103.089, ieepnrImporte: 46.39, textoAdicional: 'Unidad 2,00 L Refrescos SR', baseLine: 544.05 });
  });
});
