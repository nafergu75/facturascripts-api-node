/**
 * Rectificativas de venta sobre una factura de la app: una venta anulada entera
 * no se anula otra vez, una rectificativa no deja la original por debajo de
 * cero y una rectificativa no se rectifica. Antes, la ficha de una A-1 ya
 * anulada con la R-1 seguía ofreciendo «Hacer rectificativa» y salía una R-2
 * igual: el 303 restaba el IVA dos veces.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import type { HttpError } from '../utils/http-errors';

const COMPANY_ID = `venta-rect-limite-${Date.now()}`;
let customerId = '';

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function emitir(base: number) {
  return incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2026-10-01', lineas: [linea(base)] });
}

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Rectificativas Venta SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Rectificativas Venta SL', nif: 'B40000001' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Rect SL', nifCif: 'B50000001' } })).id;
});

afterAll(async () => {
  // Los enlaces de las rectificativas antes que las facturas: la original no se borra con rectificativas enlazadas.
  await prisma.incomeInvoiceRectificada.deleteMany({ where: { companyId: COMPANY_ID } });
  await prisma.incomeInvoiceLine.deleteMany({ where: { invoice: { companyId: COMPANY_ID } } });
  await prisma.incomeInvoice.deleteMany({ where: { companyId: COMPANY_ID } });
});

describe('límite de las rectificativas de venta', () => {
  it('una venta anulada entera no se anula otra vez (ni emitida ni como borrador)', async () => {
    const a = await emitir(600); // 726
    const r1 = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Servicio no prestado' });
    expect(Number(r1.totalFactura)).toBe(-726);

    const otra = await error(incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Otra vez' }));
    expect(otra.statusCode).toBe(409);
    expect(otra.message).toBe(`La factura ${a.numeroCompleto} ya está anulada por completo con la ${r1.numeroCompleto}. No se puede rectificar otra vez.`);
    expect((otra.details as { codigo?: string }).codigo).toBe('RECTIFICATIVA_EXCEDE_ORIGINAL');

    const borrador = await error(incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Otra vez', borrador: true }));
    expect(borrador.statusCode).toBe(409);
    expect(await prisma.incomeInvoice.count({ where: { companyId: COMPANY_ID, facturaOriginalId: a.id } })).toBe(1);

    // La ficha lo dice: anulada entera, con su rectificativa.
    const ficha = await incomeInvoicesService.obtenerPorId(COMPANY_ID, a.id);
    expect(ficha.anuladaPorCompleto).toBe(true);
    expect(ficha.rectificadaPor).toEqual([
      { id: r1.id, numeroCompleto: r1.numeroCompleto, fechaEmision: r1.fechaEmision, totalFactura: -726, parte: -726, tipoRectificativa: 'I', tipoFactura: 'R1' },
    ]);
  });

  it('una parcial cabe; la total después ya no, y avisa de lo que queda', async () => {
    const a = await emitir(1000); // 1210
    const parcial = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, {
      motivo: 'Descuento acordado',
      lineas: [{ descripcion: 'Descuento', cantidad: -1, precioUnitario: 100, tipoIva: 21 }],
    });
    expect(Number(parcial.totalFactura)).toBe(-121);
    const total = await error(incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Anulación' }));
    expect(total.statusCode).toBe(409);
    expect(total.message).toBe(
      `La rectificativa deja la factura ${a.numeroCompleto} por debajo de cero: después de la ${parcial.numeroCompleto} solo quedan 1.089,00 € por rectificar.`,
    );
    // Lo que queda sí se puede rectificar.
    const resto = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, {
      motivo: 'Resto',
      lineas: [{ descripcion: 'Resto', cantidad: -1, precioUnitario: 900, tipoIva: 21 }],
    });
    expect(Number(resto.totalFactura)).toBe(-1089);
    expect((await incomeInvoicesService.obtenerPorId(COMPANY_ID, a.id)).anuladaPorCompleto).toBe(true);
  });

  it('una rectificativa sola mayor que la factura tampoco', async () => {
    const a = await emitir(100); // 121
    const e = await error(
      incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Demasiado', lineas: [{ descripcion: 'x', cantidad: -1, precioUnitario: 200, tipoIva: 21 }] }),
    );
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe(`La rectificativa (-242,00 €) es mayor que la factura ${a.numeroCompleto} (121,00 €).`);
  });

  it('un borrador de rectificativa total no se emite si la original ya se anuló mientras tanto', async () => {
    const a = await emitir(200); // 242
    const borrador = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Anulación', borrador: true });
    await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Anulación' });
    const e = await error(incomeInvoicesService.finalizar(COMPANY_ID, borrador.id));
    expect(e.statusCode).toBe(409);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: borrador.id } })).estadoDocumento).toBe('BORRADOR');
  });

  it('una rectificativa no se rectifica; para deshacer una anulación se rectifica otra vez la original en positivo', async () => {
    const a = await emitir(50); // 60,50
    const r = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Anulación' });
    const e = await error(incomeInvoicesService.crearRectificativa(COMPANY_ID, r.id, { motivo: 'Deshacer' }));
    expect(e.statusCode).toBe(400);
    expect(e.message).toBe(
      `La ${r.numeroCompleto} ya es una rectificativa: no se rectifica. Si hay que corregirla, haz otra rectificativa de la factura original.`,
    );
    const deshacer = await incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, {
      motivo: 'La anulación fue un error',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 50, tipoIva: 21 }],
    });
    expect(Number(deshacer.totalFactura)).toBe(60.5);
    expect((await incomeInvoicesService.obtenerPorId(COMPANY_ID, a.id)).anuladaPorCompleto).toBe(false);
  });

  it('dos rectificativas totales a la vez: solo sale una', async () => {
    const a = await emitir(300); // 363
    const r = await Promise.allSettled([
      incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Una' }),
      incomeInvoicesService.crearRectificativa(COMPANY_ID, a.id, { motivo: 'Otra' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.incomeInvoice.count({ where: { companyId: COMPANY_ID, facturaOriginalId: a.id, estadoDocumento: 'FINAL' } })).toBe(1);
  });
});
