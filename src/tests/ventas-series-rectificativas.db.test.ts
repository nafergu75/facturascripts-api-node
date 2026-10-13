/**
 * Series de las rectificativas de venta (art. 6.1.a y 7.1.a RD 1619/2012):
 * las R1-R4 en la de rectificativas (R), las R5 en la de tickets (RT, que se
 * crea con la primera), nunca en una de facturas. Y el lector: una serie
 * leida que es de la app da 409; una historica de facturas del otro programa
 * se usa para su rectificativa, con aviso.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import type { HttpError } from '../utils/http-errors';

const E = `venta-series-rect-${Date.now()}`;
let cliente = '';

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

/** Una venta registrada desde el lector con su numero y su serie (del otro programa). */
const leida = (serie: string, numero: number, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso(
    { companyId: E, customer: { id: cliente }, serie, numero, fechaEmision: '2026-09-10', lineas: [linea(100)], ...extra } as unknown as CrearFacturaIngresoDTO,
    { origen: 'lector', numeroLeido: `${serie}-${numero}` },
  );

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Series Rectificativas SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Series Rectificativas SL', nif: 'B40000003' } });
  cliente = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Series SL', nifCif: 'B50000021' } })).id;
  await listarSeries(E);
});

afterAll(async () => {
  await prisma.incomeInvoiceRectificada.deleteMany({ where: { companyId: E } });
  await prisma.incomeInvoiceLine.deleteMany({ where: { invoice: { companyId: E } } });
  await prisma.incomeInvoice.deleteMany({ where: { companyId: E } });
});

describe('rectificativas hechas en la app', () => {
  it('la primera R5 crea la RT; R1 en la RT, R5 en la R o cualquiera en la A: 400', async () => {
    expect(await prisma.invoiceSeries.count({ where: { companyId: E, tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA' } })).toBe(0);
    const ticket = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, tipoFactura: 'F2', lineas: [linea(40)] });
    const completa = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, lineas: [linea(40)] });
    const bloque = (id: string, ticketSi = false) => ({ ticket: ticketSi, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id }] });
    // Una R5 rechazada (una devolución que suma) no deja creada la RT.
    const rechazada = await error(incomeInvoicesService.crearIngreso({ companyId: E, customer: {}, lineas: [linea(10)], rectificativa: bloque(ticket.id, true) } as unknown as CrearFacturaIngresoDTO));
    expect(rechazada.details).toMatchObject({ codigo: 'SIGNO_NO_CUADRA' });
    expect(await prisma.invoiceSeries.count({ where: { companyId: E, tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA' } })).toBe(0);
    const r5 = await incomeInvoicesService.crearIngreso({ companyId: E, customer: {}, lineas: [linea(-10)], rectificativa: bloque(ticket.id, true) } as unknown as CrearFacturaIngresoDTO);
    expect(r5).toMatchObject({ tipoFactura: 'R5', serie: 'RT', numeroCompleto: 'RT-1' });
    expect(await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: E, codigo: 'RT' } } })).toMatchObject({ tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true });
    for (const [serie, b] of [
      ['RT', bloque(completa.id)],
      ['R', bloque(ticket.id, true)],
      ['A', bloque(completa.id)],
    ] as const) {
      const e = await error(incomeInvoicesService.crearIngreso({ companyId: E, customer: {}, serie, lineas: [linea(-10)], rectificativa: b } as unknown as CrearFacturaIngresoDTO));
      expect(e.statusCode).toBe(400);
      expect(e.details).toMatchObject({ codigo: 'SERIE_NO_RECTIFICATIVA', campo: 'serie' });
    }
    // Las R1-R4 siguen en la R.
    const r1 = await incomeInvoicesService.crearIngreso({ companyId: E, customer: {}, lineas: [linea(-10)], rectificativa: bloque(completa.id) } as unknown as CrearFacturaIngresoDTO);
    expect(r1.serie).toBe('R');
  });
});

describe('rectificativas leídas', () => {
  it('con la serie de rectificativas de la app (R): 409, como cualquier serie de la app', async () => {
    const original = await leida('FV', 1);
    const e = await error(
      leida('R', 5, { lineas: [linea(-100)], rectificativa: { forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: original.id }] } }),
    );
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ campo: 'serie' });
  });

  it('en la serie histórica de facturas del otro programa: se registra con aviso SERIE_HISTORICA_MIXTA', async () => {
    const original = await leida('FX', 7);
    const r = await leida('FX', 8, { lineas: [linea(-100)], rectificativa: { forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devolución', originales: [{ id: original.id }] } });
    expect(r).toMatchObject({ serie: 'FX', numeroCompleto: 'FX-8', esRectificativa: true, tipoFactura: 'R1' });
    expect(r.avisosFiscales).toEqual(expect.arrayContaining([expect.objectContaining({ codigo: 'SERIE_HISTORICA_MIXTA' })]));
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.id } })).origen).toBe('lector');
  });
});
