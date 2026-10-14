/**
 * Cobros, pagos y asientos con UNA sola conexion en el pool, como en produccion.
 *
 * Regresion (14-10-2026, 04:41 UTC): «Registrar cobro» de una venta al banco
 * respondio 500 a los 30 s. crearAsiento, dentro de la transaccion del cobro,
 * comprobaba el año llevado por la gestoria con el cliente global (prisma) y no
 * con el de la transaccion (tx). En Vercel con TiDB el pool tiene una sola
 * conexion (connection_limit=1) y la tenia la transaccion: la consulta espero
 * conexion hasta el pool_timeout (P2024), se reintento dos veces como si no
 * hubiera conexion y la transaccion caduco (P2028). En local no pasaba porque
 * el pool tiene varias conexiones.
 *
 * Aqui el cliente compartido se crea con connection_limit=1 y pool_timeout=5.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
jest.mock('../config/database', () => require('./una-conexion').clienteDeUnaConexion());

import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { cobrosController } from '../controllers/cobrosPagos.controller';
import { errorMiddleware } from '../middleware/error.middleware';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { anularCobroFactura, registrarCobroFactura } from '../services/cobrosPagos.service';
import { cambiarEstadoPeriodo } from '../services/periodos.service';

jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

const COMPANY_ID = `una-conexion-${Date.now()}`;
const motor = new AccountingEngineController();
let customerId: string;
let supplierId: string;
let bancoId: string;

/** Con una conexion, lo que se cuelga tarda el pool_timeout (5 s) o mas: esto tiene que ir mucho mas rapido. */
const RAPIDO_MS = 4_000;
async function cronometrar<T>(fn: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t0 };
}

const lineas = (precio: number) => [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 }];

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Una Conexion SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Una Conexion SL', nif: 'B11000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente NZ SL', nifCif: 'B21000000' } })).id;
  supplierId = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor NZ SL', nifCif: 'B31000000' } })).id;
  // El banco del fallo: subcuenta 57200001.
  bancoId = (
    await prisma.bankAccount.create({ data: { companyId: COMPANY_ID, iban: 'ES0000000000000000000057', bancoNombre: 'Banco NZ', subcuentaCodigo: '57200001' } })
  ).id;
}, 60_000);

describe('con una sola conexion en el pool', () => {
  it('el cliente del test tiene connection_limit=1 (si no, este fichero no prueba nada)', () => {
    const url = new URL(process.env.DATABASE_URL ?? '');
    expect(url.searchParams.get('connection_limit')).toBe('1');
  });

  it('anular un cobro de un mes cerrado (contraasiento) no se cuelga (va antes: sus facturas son de septiembre)', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-09-01',
      fechaVencimiento: '2099-12-31',
      lineas: lineas(100),
    });
    const { cobro } = await registrarCobroFactura(COMPANY_ID, 'INGRESO', f.id, { fecha: '2026-09-05', cuentaBancariaId: bancoId });
    await cambiarEstadoPeriodo(COMPANY_ID, 2026, 9, 'cerrado');
    try {
      const { r, ms } = await cronometrar(() => anularCobroFactura(COMPANY_ID, 'INGRESO', f.id, cobro.id, { fecha: '2026-10-14' }));
      expect(ms).toBeLessThan(RAPIDO_MS);
      expect(r.contraasiento).toBe(true);
      expect(r.resumen).toMatchObject({ importePendiente: 121, estado: 'PENDING' });
    } finally {
      await cambiarEstadoPeriodo(COMPANY_ID, 2026, 9, 'abierto');
    }
  }, 60_000);

  it('registrar el cobro de una venta al banco no se cuelga (fallo del 14-10-2026)', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-10-01',
      fechaVencimiento: '2026-10-31',
      lineas: lineas(1000),
    });
    const { r, ms } = await cronometrar(() =>
      registrarCobroFactura(COMPANY_ID, 'INGRESO', f.id, { fecha: '2026-10-14', cuentaBancariaId: bancoId }),
    );
    expect(ms).toBeLessThan(RAPIDO_MS);
    expect(r.resumen).toMatchObject({ importeCobrado: 1210, importePendiente: 0, estado: 'PAID' });
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.cobro.asientoId! }, include: { lineas: true } });
    expect(asiento).toMatchObject({ estado: 'POSTED', origen: 'TESORERIA', invoiceId: f.id });
    expect(asiento.lineas.find((l) => l.accountCode === '57200001')).toMatchObject({ debe: 1210, haber: 0 });
  }, 60_000);

  it('contabilizar una venta y una compra, y pagar la compra, no se cuelga', async () => {
    const v = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-10-02',
      fechaVencimiento: '2026-10-31',
      lineas: lineas(200),
    });
    const { ms: msVenta } = await cronometrar(() => motor.contabilizarFacturaIngreso(COMPANY_ID, v.id));
    expect(msVenta).toBeLessThan(RAPIDO_MS);

    const g = await expenseInvoicesService.crearGasto({
      companyId: COMPANY_ID,
      provider: { id: supplierId },
      serie: 'P',
      fechaEmision: '2026-10-03',
      fechaVencimiento: '2026-11-03',
      lineas: lineas(400),
    });
    const { r: contab, ms: msGasto } = await cronometrar(() => motor.contabilizarFacturaGasto(COMPANY_ID, g.id));
    expect(msGasto).toBeLessThan(RAPIDO_MS);
    await prisma.journalEntry.update({ where: { id: contab.journalEntryId }, data: { estado: 'POSTED' } });

    const { r, ms } = await cronometrar(() => registrarCobroFactura(COMPANY_ID, 'GASTO', g.id, { fecha: '2026-10-10', cuentaBancariaId: bancoId }));
    expect(ms).toBeLessThan(RAPIDO_MS);
    expect(r.resumen).toMatchObject({ importePendiente: 0, estado: 'PAGADA' });
  }, 60_000);

  it('si la transaccion caduca, «Registrar cobro» da un 503 con el texto claro (no un 500) y no graba nada', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-10-04',
      fechaVencimiento: '2099-12-31',
      lineas: lineas(50),
    });
    // La ruta de verdad (controlador y middleware de errores), con la empresa ya resuelta.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.companyId = COMPANY_ID;
      next();
    });
    app.post('/companies/:companyId/income-invoices/:id/cobros', cobrosController.registrar);
    app.use(errorMiddleware);

    const caducada = new Prisma.PrismaClientKnownRequestError(
      'Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 30000 ms, however 30214 ms passed since the start of the transaction.',
      { code: 'P2028', clientVersion: Prisma.prismaVersion.client },
    );
    const espia = jest.spyOn(prisma, '$transaction').mockRejectedValueOnce(caducada as never);
    try {
      const r = await request(app).post(`/companies/${COMPANY_ID}/income-invoices/${f.id}/cobros`).send({ fecha: '2026-10-14', cuentaBancariaId: bancoId });
      expect(r.status).toBe(503);
      expect(r.body.message).toBe('La base de datos ha tardado demasiado en responder. El cobro no se ha registrado: vuelve a intentarlo dentro de un momento.');
      expect(r.body.details).toMatchObject({ codigo: 'FALLO_BD', codigoBD: 'P2028' });
    } finally {
      espia.mockRestore();
    }
    expect(await prisma.invoicePayment.count({ where: { companyId: COMPANY_ID, invoiceId: f.id } })).toBe(0);
  }, 60_000);
});
