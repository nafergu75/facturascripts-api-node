/**
 * Resumen de cobros de clientes del panel sobre BD real: factura pendiente,
 * parcialmente cobrada, cobrada, vencida, cobrada a mano, rectificativas, y
 * borradores y proformas fuera. Tambien la ruta GET /stats/cobros (permiso y
 * que no la capture '/:id').
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { resumenCobrosClientes } from '../services/cobrosClientes.service';
import incomeInvoicesRoutes from '../routes/income-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const COMPANY_ID = `cobros-panel-test-${Date.now()}`;
const HOY = '2026-10-07';
let customerId: string;

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });

async function emitir(base: number, fechaEmision: string, fechaVencimiento = '2099-12-31') {
  return incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision, fechaVencimiento, lineas: [linea(base)] });
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Cobros Panel SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Cobros Panel SL', nif: 'B40000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Panel SL', nifCif: 'B50000000' } })).id;

  // Serie A en orden de fechas (la numeracion no admite fechas anteriores).
  ids.vieja = (await emitir(100, '2025-11-20', '2025-12-20')).id; // 121, vencida, de 2025
  ids.cobrada2025 = (await emitir(50, '2025-12-01', '2025-12-31')).id; // 60,50
  await registrarCobroFactura(COMPANY_ID, 'INGRESO', ids.cobrada2025, { fecha: '2026-01-05', caja: true });
  ids.vencida = (await emitir(1000, '2026-01-10', '2026-09-27')).id; // 1210, vencida hace 10 dias
  ids.parcial = (await emitir(500, '2026-02-01')).id; // 605
  await registrarCobroFactura(COMPANY_ID, 'INGRESO', ids.parcial, { fecha: '2026-02-15', importe: 205, caja: true });
  ids.cobrada = (await emitir(200, '2026-03-01')).id; // 242
  await registrarCobroFactura(COMPANY_ID, 'INGRESO', ids.cobrada, { fecha: '2026-03-05', caja: true });
  ids.anulada = (await emitir(300, '2026-04-01')).id; // 363, anulada entera por su rectificativa
  ids.rectAnulada = (await incomeInvoicesService.crearRectificativa(COMPANY_ID, ids.anulada, { motivo: 'Servicio no prestado' })).id;
  ids.conAbono = (await emitir(1000, '2026-05-01')).id; // 1210 - 121 de rectificativa = 1089
  ids.rectParcial = (
    await incomeInvoicesService.crearRectificativa(COMPANY_ID, ids.conAbono, {
      motivo: 'Descuento acordado',
      lineas: [{ descripcion: 'Descuento', cantidad: -1, precioUnitario: 100, tipoIva: 21 }],
    })
  ).id;
  ids.aMano = (await emitir(10, '2026-06-01')).id; // 12,10, marcada cobrada antes de existir los cobros
  await prisma.incomeInvoice.update({ where: { id: ids.aMano }, data: { estado: 'PAID' } });

  ids.borrador = (
    await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2026-07-01', lineas: [linea(9000)], borrador: true })
  ).id;
  ids.proforma = (
    await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision: '2026-07-01', lineas: [linea(7000)], proforma: true })
  ).id;
});

describe('resumen de cobros de clientes', () => {
  it('pendiente: todas las facturas emitidas con algo por cobrar, de cualquier año', async () => {
    const r = await resumenCobrosClientes(COMPANY_ID, 2026, HOY);
    expect(r.pendientes).toEqual({ numero: 4, importe: 2820 }); // 121 + 1210 + 400 + 1089
    expect(r.vencidas).toEqual({ numero: 2, importe: 1331 });
    expect(r.parcialmenteCobradas).toEqual({ numero: 1, importe: 400 });
  });

  it('cobradas del año por fecha de emision, y lo cobrado con fecha en el año', async () => {
    const r2026 = await resumenCobrosClientes(COMPANY_ID, 2026, HOY);
    expect(r2026.cobradas).toEqual({ numero: 2, importe: 254.1 }); // 242 + 12,10 (a mano)
    expect(r2026.cobradoEnElAnio).toBe(507.5); // 60,50 + 205 + 242
    const r2025 = await resumenCobrosClientes(COMPANY_ID, 2025, HOY);
    expect(r2025.cobradas).toEqual({ numero: 1, importe: 60.5 });
    expect(r2025.cobradoEnElAnio).toBe(0);
    expect(r2025.pendientes).toEqual(r2026.pendientes);
  });

  it('proximas: por vencimiento, con lo pendiente y el retraso', async () => {
    const { proximas } = await resumenCobrosClientes(COMPANY_ID, 2026, HOY);
    expect(proximas.map((f) => f.id)).toEqual([ids.vieja, ids.vencida, ids.parcial, ids.conAbono]);
    expect(proximas[0]).toMatchObject({ cliente: 'Cliente Panel SL', total: 121, pendiente: 121, vencida: true, diasRetraso: 291 });
    expect(proximas[1]).toMatchObject({ fechaVencimiento: '2026-09-27', vencida: true, diasRetraso: 10 });
    expect(proximas[2]).toMatchObject({ total: 605, cobrado: 205, pendiente: 400, vencida: false, diasRetraso: 0 });
    expect(proximas[3]).toMatchObject({ total: 1210, pendiente: 1089 });
    expect(proximas[0].numeroCompleto).toMatch(/^A-\d+$/);
  });

  it('fuera: borradores, proformas, rectificativas y la factura anulada', async () => {
    const { proximas } = await resumenCobrosClientes(COMPANY_ID, 2026, HOY);
    const fuera = [ids.borrador, ids.proforma, ids.rectAnulada, ids.rectParcial, ids.anulada, ids.cobrada, ids.aMano];
    expect(proximas.filter((f) => fuera.includes(f.id))).toEqual([]);
  });

  it('cobrar lo que queda de la parcial la pasa a cobradas', async () => {
    await registrarCobroFactura(COMPANY_ID, 'INGRESO', ids.parcial, { fecha: '2026-03-20', caja: true });
    const r = await resumenCobrosClientes(COMPANY_ID, 2026, HOY);
    expect(r.pendientes).toEqual({ numero: 3, importe: 2420 });
    expect(r.parcialmenteCobradas.numero).toBe(0);
    expect(r.cobradas).toEqual({ numero: 3, importe: 859.1 });
    expect(r.cobradoEnElAnio).toBe(907.5);
  });
});

describe('GET /companies/:companyId/income-invoices/stats/cobros', () => {
  function app(roles: string[]) {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { userId: 'u-panel', email: 'panel@test.es', roles } as never;
      req.companyId = COMPANY_ID;
      next();
    });
    a.use('/companies/:companyId/income-invoices', incomeInvoicesRoutes);
    a.use(errorMiddleware);
    return a;
  }

  it('devuelve el resumen del año (no lo captura la ruta /:id)', async () => {
    const res = await request(app(['ventas'])).get(`/companies/${COMPANY_ID}/income-invoices/stats/cobros?anio=2026`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(await resumenCobrosClientes(COMPANY_ID, 2026));
    expect(res.body.data.pendientes.numero).toBeGreaterThan(0);
  });

  it('lo puede ver el rol contable (contabilidad:read) y no quien no tiene permiso de lectura', async () => {
    expect((await request(app(['contable'])).get(`/companies/${COMPANY_ID}/income-invoices/stats/cobros`)).status).toBe(200);
    expect((await request(app([])).get(`/companies/${COMPANY_ID}/income-invoices/stats/cobros`)).status).toBe(403);
  });

  it('un año que no es un año da 400', async () => {
    const res = await request(app(['ventas'])).get(`/companies/${COMPANY_ID}/income-invoices/stats/cobros?anio=abc`);
    expect(res.status).toBe(400);
  });
});
