/**
 * Arreglos de la revision de Compras, sobre BD real:
 *  - el alta (manual y del lector) y la aprobacion del borrador no meten una
 *    factura en un trimestre con el 303 (o el 111/115) ya presentado.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import expenseInvoicesRoutes from '../routes/expense-invoices.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { controlCif } from '../utils/nif';
import { esperarCuadre } from './ayuda-cuadre-recibidas';

const SUFIJO = `${Date.now()}`;
const motor = new AccountingEngineController();
let n = 0;
const cif = () => {
  const siete = String(3000000 + ((Date.now() + n++ * 15485863) % 6999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

async function nuevaEmpresa(nombre: string): Promise<string> {
  const id = `compras-rev-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Revision ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Revision ${nombre} SL`, nif: 'B10000000' } });
  return id;
}
const proveedor = async (companyId: string, nombre = 'Suministros Levante SL') =>
  (await prisma.supplier.create({ data: { companyId, nombreFiscal: nombre, nifCif: cif() } })).id;

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-rev', email: 'contable@test.local', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/expense-invoices', expenseInvoicesRoutes);
  a.use(errorMiddleware);
  return a;
}

const factura = (supplierId: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: supplierId },
  numeroFacturaProveedor: 'S-100',
  fechaEmision: '2026-02-10',
  tipoGasto: 'SUMINISTROS',
  lineas: [{ descripcion: 'Luz', cantidad: 1, precioUnitario: 1000, tipoIva: 21 }],
  ...extra,
});

const presentar = (companyId: string, codigo: string, periodo: string, ejercicio = 2026) =>
  prisma.modeloImpuesto.create({ data: { companyId, codigo, ejercicio, periodo, estado: 'presentado' } });

describe('alta en un trimestre con el 303 presentado', () => {
  it('alta manual: 409 que pide la fecha de registro, y con ella entra en el 2T', async () => {
    const E = await nuevaEmpresa('alta303');
    const sup = await proveedor(E);
    await presentar(E, '303', '1T');
    const r = await request(app(E)).post('/expense-invoices').send(factura(sup, { fechaEmision: '2026-03-20' }));
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/^El 303 del 1T de 2026 ya está presentado: si la recibiste más tarde, indica en «¿La recibiste más tarde\?»/);
    expect(r.body.details).toEqual({ campo: 'fechaRegistro' });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(0);

    const ok = await request(app(E)).post('/expense-invoices').send(factura(sup, { fechaEmision: '2026-03-20', fechaRegistro: '2026-05-04' }));
    expect(ok.status).toBe(201);
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });

  it('con el 111 presentado solo se bloquean las que llevan retención de profesionales', async () => {
    const E = await nuevaEmpresa('alta111');
    const sup = await proveedor(E);
    await presentar(E, '111', '1T');
    const sin = await request(app(E)).post('/expense-invoices').send(factura(sup, { numeroFacturaProveedor: 'L-1' }));
    expect(sin.status).toBe(201);
    const con = await request(app(E))
      .post('/expense-invoices')
      .send(factura(sup, { numeroFacturaProveedor: 'P-1', tipoGasto: 'SERVICIO_PROFESIONAL', lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 15 }] }));
    expect(con.status).toBe(409);
    expect(con.body.message).toMatch(/^El 111 del 1T de 2026 ya está presentado/);
  });

  it('lector: el borrador tampoco se crea en un trimestre presentado', async () => {
    const E = await nuevaEmpresa('lector303');
    const sup = await proveedor(E);
    await presentar(E, '303', '1T');
    await expect(expenseInvoicesService.registrarGasto(E, factura(sup), { contabilizar: 'DRAFT' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('aprobar un borrador cuyo trimestre se presentó después: 409 y nada cambia', async () => {
    const E = await nuevaEmpresa('aprobar303');
    const sup = await proveedor(E);
    const { factura: f, asientoId } = await expenseInvoicesService.registrarGasto(E, factura(sup), { contabilizar: 'DRAFT' });
    await presentar(E, '303', '1T');
    await expect(motor.aprobarAsiento(E, asientoId, 'u-rev')).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/^El 303 del 1T de 2026 ya está presentado: modifica la factura/),
    });
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: asientoId } })).estado).toBe('DRAFT');
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).estado).toBe('DRAFT');
    await esperarCuadre(expect, E, 2026, 1, 0, 0);

    // Con la fecha de registro en el 2T, el borrador se rehace y ya se aprueba.
    const r = await request(app(E)).put(`/expense-invoices/${f.id}`).send(factura(sup, { fechaRegistro: '2026-04-06' }));
    expect(r.status).toBe(200);
    await motor.aprobarAsiento(E, r.body.data.asiento.id, 'u-rev');
    await esperarCuadre(expect, E, 2026, 1, 0, 0);
    await esperarCuadre(expect, E, 2026, 2, 210, 1000);
  });
});
