/**
 * Las facturas respetan los meses bloqueados y los ejercicios cerrados, sobre BD
 * real. Antes solo lo comprobaban cobros, pagos y nominas: una factura se emitia
 * y se contabilizaba (tambien desde el hook AUTO) con el mes bloqueado o el
 * ejercicio cerrado, y bloquear meses no servia de nada.
 *
 * Tambien: listarPeriodos crea los meses sin carreras (dos llamadas a la vez
 * daban un P2002 que salia como 500).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { accountingHooksService } from '../services/accounting-hooks.service';
import { cambiarEstadoPeriodo, comprobarFechaAbierta, listarPeriodos } from '../services/periodos.service';

const COMPANY_ID = `fecha-abierta-test-${Date.now()}`;
const motor = new AccountingEngineController();
let customerId: string;
let supplierId: string;

const linea = (precio: number) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const venta = (fechaEmision: string, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, fechaEmision, fechaVencimiento: '2099-12-31', lineas: [linea(100)], ...extra });
const ultimoNumeroSerieA = async () =>
  (await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: COMPANY_ID, codigo: 'A' } } })).ultimoNumero;

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Fecha Abierta SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Fecha Abierta SL', nif: 'B60000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Fechas SL', nifCif: 'B70000000' } })).id;
  supplierId = (await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Proveedor Fechas SL', nifCif: 'B80000000' } })).id;
  // 2024 cerrado (como lo dejaba el boton de Registro Mercantil, sin asientos).
  await prisma.fiscalYear.create({ data: { companyId: COMPANY_ID, label: '2024', fechaInicio: '2024-01-01', fechaFin: '2024-12-31', estado: 'CLOSED' } });
});

describe('listarPeriodos', () => {
  it('varias llamadas a la vez sobre un ejercicio nuevo: 12 meses, sin error', async () => {
    const r = await Promise.all([1, 2, 3, 4, 5].map(() => listarPeriodos(COMPANY_ID, 2031)));
    for (const periodos of r) expect(periodos.map((p) => p.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(await prisma.periodo.count({ where: { companyId: COMPANY_ID, ejercicio: 2031 } })).toBe(12);
  });

  it('respeta los meses que ya existian', async () => {
    await cambiarEstadoPeriodo(COMPANY_ID, 2032, 6, 'bloqueado');
    const periodos = await listarPeriodos(COMPANY_ID, 2032);
    expect(periodos).toHaveLength(12);
    expect(periodos.find((p) => p.mes === 6)?.estado).toBe('bloqueado');
  });
});

describe('emitir facturas de venta', () => {
  beforeAll(async () => {
    await cambiarEstadoPeriodo(COMPANY_ID, 2026, 3, 'bloqueado');
  });

  it('emitir con fecha de un mes bloqueado: 400 claro y sin gastar numero de la serie', async () => {
    await venta('2026-02-10'); // crea la serie A y le da el numero 1
    const antes = await ultimoNumeroSerieA();
    const error = await venta('2026-03-15').catch((e) => e);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe(
      'No se puede emitir la factura con fecha 15/03/2026: el mes 03/2026 está bloqueado. Usa otra fecha o desbloquea ese mes en Configuración > Ejercicios y periodos.',
    );
    expect(error.details).toMatchObject({ campo: 'fechaEmision', motivo: 'periodo_bloqueado' });
    expect(await ultimoNumeroSerieA()).toBe(antes);
    expect(await prisma.incomeInvoice.count({ where: { companyId: COMPANY_ID, fechaEmision: '2026-03-15' } })).toBe(0);
  });

  it('un borrador o una proforma si se guardan (no llevan asiento); el borrador no se emite en ese mes', async () => {
    const borrador = await venta('2026-03-16', { borrador: true });
    expect(borrador.estadoDocumento).toBe('BORRADOR');
    const proforma = await venta('2026-03-16', { proforma: true });
    expect(proforma.estadoDocumento).toBe('PROFORMA');

    await expect(incomeInvoicesService.finalizar(COMPANY_ID, borrador.id, { fechaEmision: '2026-03-20' })).rejects.toThrow(
      /No se puede emitir la factura con fecha 20\/03\/2026: el mes 03\/2026 está bloqueado/,
    );
    const emitida = await incomeInvoicesService.finalizar(COMPANY_ID, borrador.id, { fechaEmision: '2026-04-01' });
    expect(emitida.estadoDocumento).toBe('FINAL');
  });

  it('una factura del lector en un ejercicio cerrado no se registra', async () => {
    const lector = incomeInvoicesService.crearIngreso(
      { companyId: COMPANY_ID, customer: { id: customerId }, serie: 'L24', numero: 7, fechaEmision: '2024-06-01', lineas: [linea(100)] },
      { origen: 'lector' },
    );
    await expect(lector.then(() => null, (e) => e)).resolves.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/^No se puede registrar la factura con fecha 01\/06\/2024: el ejercicio 2024 está cerrado/),
    });
    // Rechazada antes de resolver la serie: no deja una serie L24 creada.
    expect(await prisma.invoiceSeries.count({ where: { companyId: COMPANY_ID, codigo: 'L24' } })).toBe(0);
  });

  it('un mes que se bloquea despues de emitir: ni el motor ni el hook AUTO la contabilizan', async () => {
    const f = await venta('2026-05-10');
    await cambiarEstadoPeriodo(COMPANY_ID, 2026, 5, 'bloqueado');
    try {
      await expect(motor.contabilizarFacturaIngreso(COMPANY_ID, f.id)).rejects.toThrow(
        /^No se puede contabilizar la factura con fecha 10\/05\/2026: el mes 05\/2026 está bloqueado/,
      );
      const r = await accountingHooksService.onIncomeInvoiceConfirmed(COMPANY_ID, f.id);
      expect(r).toMatchObject({ contabilizada: false, motivo: expect.stringMatching(/está bloqueado/) });
      expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID, invoiceId: f.id } })).toBe(0);
    } finally {
      await cambiarEstadoPeriodo(COMPANY_ID, 2026, 5, 'abierto');
    }
    await expect(motor.contabilizarFacturaIngreso(COMPANY_ID, f.id)).resolves.toMatchObject({ estado: 'POSTED' });
  });
});

describe('facturas de gasto y aprobacion de asientos', () => {
  it('no se contabiliza un gasto en un mes bloqueado', async () => {
    const g = await expenseInvoicesService.crearGasto({
      companyId: COMPANY_ID,
      provider: { id: supplierId },
      serie: 'G',
      fechaEmision: '2026-03-03',
      fechaVencimiento: '2026-04-03',
      lineas: [{ descripcion: 'Material', cantidad: 1, precioUnitario: 50, tipoIva: 21 }],
    });
    await expect(motor.contabilizarFacturaGasto(COMPANY_ID, g.id)).rejects.toThrow(
      /^No se puede contabilizar la factura de gasto con fecha 03\/03\/2026: el mes 03\/2026 está bloqueado/,
    );
    // No invita a cambiar la fecha que puso el proveedor.
    const err = await motor.contabilizarFacturaGasto(COMPANY_ID, g.id).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/No cambies la fecha de la factura/);
    expect((err as Error).message).not.toMatch(/Usa otra fecha/);
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: g.id } })).estado).not.toBe('ACCOUNTED');
  });

  it('un asiento en borrador de un mes bloqueado no se aprueba', async () => {
    const borrador = await prisma.journalEntry.create({
      data: { companyId: COMPANY_ID, fecha: new Date('2026-03-04T00:00:00Z'), numeroAsiento: 'TEST-FA-1', descripcion: 'Borrador', origen: 'MANUAL', estado: 'DRAFT' },
    });
    await expect(motor.aprobarAsiento(COMPANY_ID, borrador.id, 'u1')).rejects.toThrow(/^No se puede aprobar el asiento con fecha 04\/03\/2026/);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: borrador.id } })).estado).toBe('DRAFT');
  });
});

describe('comprobarFechaAbierta sin accion (cobros, pagos, nominas)', () => {
  it('mantiene el mensaje general de los asientos', async () => {
    await expect(comprobarFechaAbierta(COMPANY_ID, '2026-03-01')).rejects.toThrow(
      'El periodo de 03/2026 está bloqueado: no se pueden añadir asientos con esa fecha.',
    );
    await expect(comprobarFechaAbierta(COMPANY_ID, '2024-03-01')).rejects.toThrow('El ejercicio 2024 está cerrado: no se pueden añadir asientos con esa fecha.');
    await expect(comprobarFechaAbierta(COMPANY_ID, '2026-07-01')).resolves.toBeUndefined();
  });
});
