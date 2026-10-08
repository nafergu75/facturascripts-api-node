/**
 * Vencimiento por defecto unificado: la API, el lector y las facturas de gasto
 * ponen el mismo plazo que la pantalla de nueva factura (30 dias). Antes el
 * servidor ponia la emision + 15 dias y la pantalla + 30.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { DIAS_VENCIMIENTO_POR_DEFECTO, sumarDiasISO, vencimientoPorDefecto } from '../utils/fechas';

const COMPANY_ID = `venc-defecto-${Date.now()}`;
let customerId: string;
let supplierId: string;

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Vencimientos SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Vencimientos SL', nif: 'B91000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Plazos SL', nifCif: 'B92000000' } })).id;
  supplierId = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor Plazos SL', nifCif: 'B93000000' } })).id;
});

describe('vencimientoPorDefecto', () => {
  it('30 dias, en UTC, cruzando meses, años y el cambio de hora', () => {
    expect(DIAS_VENCIMIENTO_POR_DEFECTO).toBe(30);
    expect(vencimientoPorDefecto('2026-03-15')).toBe('2026-04-14');
    expect(vencimientoPorDefecto('2026-10-20')).toBe('2026-11-19');
    expect(vencimientoPorDefecto('2026-12-15')).toBe('2027-01-14');
    expect(sumarDiasISO('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('facturas sin vencimiento', () => {
  it('una factura de venta de la API vence a los 30 dias de su emision', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-06-10',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    });
    expect(f.fechaVencimiento).toBe('2026-07-10');
  });

  it('una factura de gasto tambien', async () => {
    const g = await expenseInvoicesService.crearGasto({
      companyId: COMPANY_ID,
      provider: { id: supplierId },
      serie: 'G',
      fechaEmision: '2026-06-10',
      lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 50, tipoIva: 21 }],
    });
    expect(g.fechaVencimiento).toBe('2026-07-10');
  });

  it('si se indica el vencimiento, se respeta', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-06-11',
      fechaVencimiento: '2026-06-25',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    });
    expect(f.fechaVencimiento).toBe('2026-06-25');
  });
});
