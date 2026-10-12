// Un companyId en el cuerpo no puede elegir la empresa.
//
// Regresion: crearIngreso montaba el DTO como { companyId: req.companyId, ...req.body },
// asi que el companyId del cuerpo pisaba al de la URL. companyScope y authorize solo
// miran el de la URL: con ventas:write en la empresa A se podia emitir una factura
// en la B (creando el cliente alli y gastando un numero de su serie).
// Autenticacion y permisos reales (BD); los servicios de alta, simulados.
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { randomBytes } from 'crypto';

jest.mock('../services/income-invoices.service', () => ({
  ...(jest.requireActual('../services/income-invoices.service') as object),
  incomeInvoicesService: {
    crearIngreso: jest.fn(async (dto: { companyId: string }) => ({
      id: 'F1',
      companyId: dto.companyId,
      estadoDocumento: 'FINAL',
      numeroCompleto: 'F-2026-1',
      totalFactura: 121,
      customerId: 'C1',
    })),
  },
}));
jest.mock('../services/expense-invoices.service', () => ({
  ...(jest.requireActual('../services/expense-invoices.service') as object),
  expenseInvoicesService: {
    crearGasto: jest.fn(async (dto: { companyId: string }) => ({ id: 'G1', companyId: dto.companyId })),
  },
}));
jest.mock('../services/chart-of-accounts.service', () => ({
  ...(jest.requireActual('../services/chart-of-accounts.service') as object),
  chartOfAccountsService: {
    crearSubcuentaPersonalizada: jest.fn(async (dto: { companyId: string }) => ({
      id: 'S1',
      companyId: dto.companyId,
      codigo: '6290001',
      nombre: 'Gastos varios',
    })),
  },
}));
jest.mock('../services/accounting-hooks.service', () => ({
  accountingHooksService: { onIncomeInvoiceConfirmed: jest.fn(async () => ({ contabilizada: true })) },
}));
jest.mock('../services/archivoFacturas.service', () => ({
  ...(jest.requireActual('../services/archivoFacturas.service') as object),
  archivarVentaSinRomper: jest.fn(),
  archivarGastoSinRomper: jest.fn(),
}));
jest.mock('../services/auditoria.service', () => ({ registrarAuditoria: jest.fn() }));

import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import { authService } from '../services/auth.service';
import { hashPassword } from '../utils/password';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { chartOfAccountsService } from '../services/chart-of-accounts.service';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const EMPRESA_A = `cic-a-${SUFIJO}`;
const EMPRESA_B = `cic-b-${SUFIJO}`;
let token = '';

describeBd('companyId en el cuerpo (permisos reales)', () => {
  beforeAll(async () => {
    for (const id of [EMPRESA_A, EMPRESA_B]) {
      await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
      // Empresa nueva sin plan de la gestoria: se confirma de antemano el aviso del primer cliente o proveedor.
      await exigirPlanAnteriorAntesDeAlta(id, true, 'test');
    }
    // Puede todo en A; en B solo lee.
    const email = `cic-${SUFIJO}@test.local`;
    const u = await prisma.user.create({ data: { email, passwordHash: hashPassword(randomBytes(18).toString('base64url')) } });
    await prisma.membership.create({ data: { userId: u.id, companyId: EMPRESA_A, role: 'admin' } });
    await prisma.membership.create({ data: { userId: u.id, companyId: EMPRESA_B, role: 'solo_lectura' } });
    token = authService.generateToken({ userId: u.id, email, roles: [], companies: [] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: `cic-${SUFIJO}@test.local` } });
    await prisma.company.deleteMany({ where: { id: { in: [EMPRESA_A, EMPRESA_B] } } });
  });

  it('POST /companies/A/income-invoices crea la factura en A aunque el cuerpo diga B', async () => {
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/income-invoices`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        companyId: EMPRESA_B,
        customer: { nuevo: { nombreFiscal: 'Cliente Colado', nifCif: 'B12345674' } },
        lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, ivaPorcentaje: 21 }],
      });

    expect(res.status).toBe(201);
    expect(incomeInvoicesService.crearIngreso).toHaveBeenCalledWith(expect.objectContaining({ companyId: EMPRESA_A }));
    expect(incomeInvoicesService.crearIngreso).not.toHaveBeenCalledWith(expect.objectContaining({ companyId: EMPRESA_B }));
  });

  it('POST /companies/A/expense-invoices crea el gasto en A aunque el cuerpo diga B', async () => {
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/expense-invoices`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: EMPRESA_B, proveedorId: 'P1', baseImponible: 100 });

    expect(res.status).toBe(201);
    const llamada = (expenseInvoicesService.crearGasto as unknown as jest.Mock).mock.calls[0] as unknown[];
    expect(llamada[0]).toEqual(expect.objectContaining({ companyId: EMPRESA_A }));
  });

  it('POST /companies/A/accounting/chart-of-accounts crea la subcuenta en A aunque el cuerpo diga B', async () => {
    const res = await request(app)
      .post(`/companies/${EMPRESA_A}/accounting/chart-of-accounts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyId: EMPRESA_B, codigo: '6290001', nombre: 'Gastos varios' });

    expect(res.status).toBe(201);
    expect(chartOfAccountsService.crearSubcuentaPersonalizada).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: EMPRESA_A }),
    );
  });
});
