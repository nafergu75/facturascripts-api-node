/**
 * Aviso antes del primer cliente o proveedor sin el plan de la gestoria: en
 * una empresa española sin fichas, sin plan anterior y sin carga, las ocho
 * entradas que pueden dar de alta un tercero (Clientes, Proveedores, factura
 * nueva, compra nueva, lector de compras, lector de ventas y los dos
 * verificadores antiguos) dan 409 PLAN_ANTERIOR_PENDIENTE; con la
 * confirmacion siguen, queda la marca y AuditLog, y no vuelve a preguntar.
 * No salta con el plan traido, con carga, con fichas ni en una empresa de
 * EE. UU.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import clientesRoutes from '../routes/clientes.routes';
import proveedoresRoutes from '../routes/proveedores.routes';
import incomeInvoicesRoutes from '../routes/income-invoices.routes';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import gastosExtractorRoutes from '../routes/gastos-extractor.routes';
import ingresosExtractorRoutes from '../routes/ingresos-extractor.routes';
import incomeReaderRoutes from '../routes/income-reader.routes';
import invoiceExtractorRoutes from '../routes/invoice-extractor.routes';
import { avisoArranque } from '../services/arranque/aviso.service';
import { faltaPlanAnterior } from '../services/terceros/planAnteriorAlta';
import { cifDe } from './fixtures/arranque/generar';

const SUFIJO = Date.now();

function app(empresa: string, permisos = ['*']) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-primer', email: 'u@test.local', roles: ['x'], companies: [empresa], rolesPorEmpresa: { [empresa]: ['x'] }, permisosPorEmpresa: { [empresa]: permisos } } as never;
    req.companyId = empresa;
    next();
  });
  a.use('/clientes', clientesRoutes);
  a.use('/proveedores', proveedoresRoutes);
  a.use('/income-invoices', incomeInvoicesRoutes);
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use('/gastos-extractor', gastosExtractorRoutes);
  a.use('/ingresos-extractor', ingresosExtractorRoutes);
  a.use('/income-reader', incomeReaderRoutes);
  a.use('/invoice-extractor', invoiceExtractorRoutes);
  a.use(errorMiddleware);
  return a;
}

const ENTRADAS: Array<[string, string]> = [
  ['post', '/clientes'],
  ['post', '/proveedores'],
  ['post', '/income-invoices'],
  ['post', '/expense-invoices'],
  ['post', '/gastos-extractor/confirmar'],
  ['post', '/ingresos-extractor/confirmar'],
  ['post', '/income-reader/doc-x/verify'],
  ['post', '/invoice-extractor/doc-x/confirm'],
];

async function empresa(id: string, pais = 'ES') {
  await prisma.company.create({ data: { id, name: `Primer ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Primer ${id}`, nif: 'B10000000', pais, ...(pais === 'ES' ? {} : { monedaCuenta: 'USD' }) } });
}

describe('primer cliente o proveedor sin el plan de la gestoría', () => {
  const E = `arr-primer-${SUFIJO}`;
  beforeAll(async () => {
    await empresa(E);
  });

  it('las ocho entradas dan 409 con el código, el texto y el enlace', async () => {
    const a = app(E);
    for (const [, ruta] of ENTRADAS) {
      const r = await request(a).post(ruta).send({});
      expect([ruta, r.status]).toEqual([ruta, 409]);
      expect(r.body.error?.details ?? r.body.details).toMatchObject({ codigo: 'PLAN_ANTERIOR_PENDIENTE', enlace: '/dashboard/contabilidad/arranque' });
    }
    const r = await request(a).post('/clientes').send({ nombreFiscal: 'Primero SL', nifCif: cifDe('4699001') });
    expect(JSON.stringify(r.body)).toMatch(/Antes de dar de alta el primer cliente o proveedor conviene traer el plan de cuentas de 2026 de tu gestoría/);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
  });

  it('sin permiso, el 403 va antes que el aviso', async () => {
    expect((await request(app(E, ['ventas:read'])).post('/clientes').send({})).status).toBe(403);
  });

  it('con la confirmación sigue, deja la marca y AuditLog, y no vuelve a preguntar', async () => {
    const a = app(E);
    const r = await request(a).post('/clientes').send({ nombreFiscal: 'Primero SL', nifCif: cifDe('4699001'), confirmarSinPlanAnterior: true });
    expect(r.status).toBe(201);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(1);
    const reglas = (await prisma.reglasContables.findUniqueOrThrow({ where: { companyId: E } })).data as { altaSinPlanAnterior?: { userId: string } };
    expect(reglas.altaSinPlanAnterior?.userId).toBe('u-primer');
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'ALTA_SIN_PLAN_ANTERIOR' } })).toBe(1);
    // El siguiente alta ya no pregunta, y el panel deja de invitar.
    expect((await request(a).post('/proveedores').send({ nombreFiscal: 'Segundo SL', nifCif: cifDe('4699002') })).status).toBe(201);
    expect(await avisoArranque(E)).toBeNull();
  });

  it('una vez dada de alta una ficha tampoco pregunta, aunque se borrara la marca', async () => {
    await prisma.reglasContables.update({ where: { companyId: E }, data: { data: {} } });
    expect(await faltaPlanAnterior(E)).toBe(false);
  });
});

describe('cuándo no salta', () => {
  it('con el plan traído desde la puesta en marcha (AuditLog antiguo) o con «Traer la contabilidad»', async () => {
    const P = `arr-primer-p-${SUFIJO}`;
    await empresa(P);
    expect(await faltaPlanAnterior(P)).toBe(true);
    await prisma.auditLog.create({ data: { companyId: P, userId: 'x', action: 'IMPORTAR_PLAN_ANTERIOR', resourceType: 'ChartOfAccounts' } });
    expect(await faltaPlanAnterior(P)).toBe(false);

    const C = `arr-primer-c-${SUFIJO}`;
    await empresa(C);
    await prisma.reglasContables.create({ data: { companyId: C, data: { planAnterior: { cargaId: 'c1', fecha: '2026-12-01' } } } });
    expect(await faltaPlanAnterior(C)).toBe(false);

    const K = `arr-primer-k-${SUFIJO}`;
    await empresa(K);
    await prisma.cargaArranque.create({ data: { companyId: K, ejercicio: 2027, version: 1, tipo: 'PROVISIONAL', estado: 'CONFIRMADA', ficheros: [], createdBy: 'x' } });
    expect(await faltaPlanAnterior(K)).toBe(false);
  });

  it('con fichas ya dadas de alta antes de este cambio', async () => {
    const F = `arr-primer-f-${SUFIJO}`;
    await empresa(F);
    await prisma.supplier.create({ data: { companyId: F, nombreFiscal: 'Antiguo SL', nifCif: cifDe('4699003') } });
    expect((await request(app(F)).post('/clientes').send({ nombreFiscal: 'Nuevo SL', nifCif: cifDe('4699004') })).status).toBe(201);
  });

  it('en una empresa de EE. UU.', async () => {
    const U = `arr-primer-us-${SUFIJO}`;
    await empresa(U, 'US');
    expect(await faltaPlanAnterior(U)).toBe(false);
    expect((await request(app(U)).post('/clientes').send({ nombreFiscal: 'Acme Inc', nifCif: '12-3456789', pais: 'US' })).status).toBe(201);
  });
});
