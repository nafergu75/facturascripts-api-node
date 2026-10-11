/**
 * Listado de facturas de gasto (paginacion, contadores, filtros y totales
 * reales), cambio de estado a mano validado, pagos y Contabilizar bloqueados
 * en borradores y anuladas, y aprobar el borrador en el Motor contable.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { controlCif } from '../utils/nif';

const E = `compras-listado-${Date.now()}`;
const motor = new AccountingEngineController();
let sup: string;
const ids: Record<string, string> = {};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-lista', roles: ['contable'], companies: [E], rolesPorEmpresa: { [E]: ['contable'] } } as never;
    req.companyId = E;
    next();
  });
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

const cuerpo = (numero: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: sup },
  numeroFacturaProveedor: numero,
  fechaEmision: '2026-02-02',
  fechaVencimiento: '2099-12-31',
  tipoGasto: 'SUMINISTROS',
  lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
  ...extra,
});

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Listado SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Listado SL', nif: 'B10000000' } });
  sup = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Papelería Listado SL', nifCif: `B1234567${controlCif('1234567').cifra}` } })).id;

  // 12 contabilizadas, 6 pendientes de revisar (lector), 4 anuladas y 8 anteriores sin contabilizar (3 vencidas).
  for (let i = 0; i < 12; i++) ids[`c${i}`] = (await expenseInvoicesService.crearGasto({ ...cuerpo(`C-${i}`), companyId: E }, { contabilizar: 'POSTED' })).id;
  for (let i = 0; i < 6; i++) ids[`d${i}`] = (await expenseInvoicesService.registrarGasto(E, cuerpo(`D-${i}`), { contabilizar: 'DRAFT' })).factura.id;
  for (let i = 0; i < 4; i++) {
    const f = await expenseInvoicesService.crearGasto({ ...cuerpo(`A-${i}`), companyId: E }, { contabilizar: 'POSTED' });
    await expenseInvoicesService.anularGasto(E, f.id, { motivo: 'Duplicada' });
    ids[`a${i}`] = f.id;
  }
  for (let i = 0; i < 8; i++) {
    ids[`l${i}`] = (
      await expenseInvoicesService.crearGasto({
        companyId: E,
        provider: { id: sup },
        serie: 'L',
        fechaEmision: '2020-01-10',
        fechaVencimiento: i < 3 ? '2020-02-10' : '2099-12-31',
        lineas: [{ descripcion: 'Antigua', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
      })
    ).id;
  }
});

describe('listado', () => {
  it('paginacion: la pagina 2 de 25 tiene 5 de 30', async () => {
    const r = await request(app()).get('/expense-invoices?page=2&limit=25');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ total: 30, page: 2, limit: 25, paginas: 2 });
    expect(r.body.data.items).toHaveLength(5);
  });

  it('contadores reales (sin el filtro de estado ni el de pago)', async () => {
    const r = await request(app()).get('/expense-invoices?estado=contabilizada');
    expect(r.body.data.contadores).toEqual({ todas: 30, sinContabilizar: 8, pendientesRevision: 6, contabilizadas: 12, anuladas: 4, pendientesPago: 26, vencidas: 3 });
    expect(r.body.data.total).toBe(12);
    expect(r.body.data.items.every((f: { estadoTexto: string }) => f.estadoTexto === 'Contabilizada')).toBe(true);
  });

  it('filtro de pago vencida y de estado en castellano', async () => {
    const r = await request(app()).get('/expense-invoices?pago=vencida');
    expect(r.body.data.total).toBe(3);
    expect(r.body.data.items[0]).toMatchObject({ vencida: true, estadoPagoTexto: 'Vencida', estadoTexto: 'Sin contabilizar' });
    const rev = await request(app()).get('/expense-invoices?estado=pendiente_revision');
    expect(rev.body.data.total).toBe(6);
    expect(rev.body.data.items[0].estadoTexto).toBe('Pendiente de revisar');
  });

  it('un estado que no existe: 400', async () => {
    const r = await request(app()).get('/expense-invoices?estado=xx');
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/^Estado no válido/);
  });

  it('los totales son del conjunto filtrado entero y sin anuladas', async () => {
    const r = await request(app()).get('/expense-invoices?limit=5');
    expect(r.body.data.items).toHaveLength(5);
    expect(r.body.data.totales).toEqual({ base: 2600, iva: 546, retencion: 0, total: 3146, pendiente: 3146 });
    const anuladas = await request(app()).get('/expense-invoices?estado=anulada');
    expect(anuladas.body.data.totales.total).toBe(0);
    expect(anuladas.body.data.items[0]).toMatchObject({ estadoTexto: 'Anulada', importePendiente: 0 });
  });

  it('busqueda por el numero del proveedor y por el de registro', async () => {
    const r = await request(app()).get('/expense-invoices?q=C-11');
    expect(r.body.data.items.map((f: { numeroFacturaProveedor: string }) => f.numeroFacturaProveedor)).toEqual(['C-11']);
    const reg = await request(app()).get('/expense-invoices?q=L-3');
    expect(reg.body.data.items.map((f: { numeroCompleto: string }) => f.numeroCompleto)).toEqual(['L-3']);
  });
});

describe('cambio de estado a mano', () => {
  it('ACCOUNTED y DRAFT no se ponen a mano (400)', async () => {
    for (const nuevoEstado of ['ACCOUNTED', 'DRAFT', 'ANULADA']) {
      const r = await request(app()).patch(`/expense-invoices/${ids.l5}/estado`).send({ nuevoEstado });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe('Ese estado no se cambia a mano: para contabilizar usa Contabilizar, y para anular, Anular.');
    }
  });

  it('una contabilizada no se cambia (409); una anterior pasa de PENDING a CONFIRMED (200)', async () => {
    const r = await request(app()).patch(`/expense-invoices/${ids.c0}/estado`).send({ nuevoEstado: 'PENDING' });
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('La factura está contabilizada: su estado no se cambia a mano.');
    const ok = await request(app()).patch(`/expense-invoices/${ids.l5}/estado`).send({ nuevoEstado: 'CONFIRMED' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ estado: 'CONFIRMED', estadoTexto: 'Sin contabilizar', acciones: { contabilizar: true } });
  });
});

describe('pagos y Contabilizar en borradores y anuladas', () => {
  it('no se paga una pendiente de revisar ni una anulada', async () => {
    await expect(registrarCobroFactura(E, 'GASTO', ids.d0, { fecha: '2026-02-05', caja: true })).rejects.toMatchObject({
      statusCode: 400,
      message: 'La factura está pendiente de revisar: aprueba su asiento en el Motor contable antes de registrar pagos.',
    });
    await expect(registrarCobroFactura(E, 'GASTO', ids.a0, { fecha: '2026-02-05', caja: true })).rejects.toMatchObject({
      statusCode: 400,
      message: 'La factura está anulada: no admite pagos.',
    });
  });

  it('Contabilizar una anulada o una pendiente de revisar: 400', async () => {
    await expect(motor.contabilizarFacturaGasto(E, ids.a1)).rejects.toMatchObject({ statusCode: 400, message: 'La factura está anulada: no se contabiliza.' });
    await expect(motor.contabilizarFacturaGasto(E, ids.d1)).rejects.toMatchObject({
      statusCode: 400,
      message: 'La factura está pendiente de revisar: su asiento en borrador está en el Motor contable.',
    });
  });

  it('el asiento en borrador se puede aprobar, y al aprobarlo la factura queda contabilizada', async () => {
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { invoiceId: ids.d2, origen: 'FACTURA_GASTO' } });
    const det = await motor.obtenerAsientoDetallado(E, asiento.id);
    expect(det.permitidoAprobar).toBe(true);
    await motor.aprobarAsiento(E, asiento.id, 'u-lista');
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: ids.d2 } })).estado).toBe('ACCOUNTED');
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asiento.id } })).estado).toBe('POSTED');
  });

  it('una factura anterior (sin asiento) se sigue contabilizando con el boton', async () => {
    const r = await motor.contabilizarFacturaGasto(E, ids.l6);
    const a = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.journalEntryId }, include: { lineas: true } });
    // COMPRA por defecto en las anteriores: la 400N del proveedor.
    expect(a.lineas.find((l) => /^400\d{5}$/.test(l.accountCode))?.haber).toBe(121);
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: ids.l6 } })).estado).toBe('ACCOUNTED');
  });
});

describe('el contador «Pendientes de pago» y su filtro cuentan lo mismo', () => {
  it('una pagada en parte cuenta en el contador y en pago=por_pagar, no en pago=pendiente', async () => {
    const bancoId = (
      await prisma.bankAccount.create({ data: { companyId: E, iban: `ES00${String(Date.now()).slice(-10)}`.padEnd(24, '0').slice(0, 24), bancoNombre: 'Banco', subcuentaCodigo: '5720001' } })
    ).id;
    await registrarCobroFactura(E, 'GASTO', ids.c3, { fecha: '2026-02-05', importe: 20, cuentaBancariaId: bancoId });
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: ids.c3 } })).estadoPago).toBe('PARCIAL');

    const porPagar = await request(app()).get('/expense-invoices?pago=por_pagar');
    expect(porPagar.status).toBe(200);
    expect(porPagar.body.data.total).toBe(porPagar.body.data.contadores.pendientesPago);
    expect(porPagar.body.data.items.some((f: { id: string }) => f.id === ids.c3)).toBe(true);
    expect(porPagar.body.data.items.some((f: { estado: string }) => f.estado === 'ANULADA')).toBe(false);

    const pendiente = await request(app()).get('/expense-invoices?pago=pendiente');
    expect(pendiente.body.data.total).toBe(porPagar.body.data.total - 1);
  });
});
