/**
 * Abono de venta (rectificativa por diferencias) de una factura emitida fuera
 * de la app antes de llevar en ella la facturacion: por ejemplo, en enero de
 * 2027, un abono a Cliente Beta por la A-2026-002, que solo esta en la cartera
 * que trajo la gestoria. La R1 cita el numero y la fecha de esa factura y va
 * al 303 de 2027 como modificacion ([14]/[15]).
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { calcularModelo303 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import type { HttpError } from '../utils/http-errors';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga } from './fixtures/arranque/importar';

const E = `venta-rect-fuera-${Date.now()}`;
let beta = '';

const abono = (extra: Record<string, unknown> = {}) => ({
  companyId: E,
  customer: { id: beta },
  fechaEmision: '2027-01-15',
  tipoFactura: 'R1' as const,
  rectificaFuera: { numero: 'A-2026-002', fecha: '2026-02-20' },
  motivoRectificacion: 'Devolución de parte del pedido',
  lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -1000, tipoIva: 21 }],
  ...extra,
});

async function error(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('No ha fallado');
}

beforeAll(async () => {
  await empresaDePrueba(E);
  await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
  beta = (await prisma.customer.findFirstOrThrow({ where: { companyId: E, subcuenta430: '4300000002' } })).id;
  jest.useFakeTimers({
    now: new Date('2027-01-20T10:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
}, 120_000);

afterAll(() => {
  jest.useRealTimers();
});

describe('rectificativa de venta de una factura de fuera de la app', () => {
  it('se emite citando el número y la fecha de la factura de 2026 y va al 303 de 2027 como modificación', async () => {
    const f = await incomeInvoicesService.crearIngreso(abono());
    expect(f).toMatchObject({ estadoDocumento: 'FINAL', esRectificativa: true, tipoFactura: 'R1', tipoRectificativa: 'I' });
    expect(f.rectificaFuera).toEqual({ numero: 'A-2026-002', fecha: '2026-02-20' });
    expect(f.facturaOriginalId).toBeUndefined();
    expect(Number(f.totalFactura)).toBe(-1210);
    const c = (await calcularModelo303(E, periodoFiscal(2027, '1T'))).casillasOficiales ?? {};
    expect(Number(c['14'])).toBe(-1000);
    expect(Number(c['15'])).toBe(-210);
  });

  it('también como borrador que se pasa a factura después', async () => {
    const b = await incomeInvoicesService.crearIngreso(abono({ borrador: true }));
    expect(b.rectificaFuera).toEqual({ numero: 'A-2026-002', fecha: '2026-02-20' });
    const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: '2027-01-16' });
    expect(f).toMatchObject({ estadoDocumento: 'FINAL', esRectificativa: true, rectificaFuera: { numero: 'A-2026-002' } });
  });

  it('lo que no vale: sin motivo, de cuando ya se facturaba en la app, las dos originales, R5 o por sustitución', async () => {
    expect((await error(incomeInvoicesService.crearIngreso(abono({ motivoRectificacion: '' })))).message).toBe('Indica el motivo de la rectificación.');
    const tarde = await error(incomeInvoicesService.crearIngreso(abono({ rectificaFuera: { numero: 'A-2027-001', fecha: '2027-01-05' } })));
    expect(tarde.statusCode).toBe(400);
    expect(tarde.message).toMatch(/cuando ya llevabas la facturación en la app/);
    expect((await error(incomeInvoicesService.crearIngreso(abono({ rectificaFuera: { numero: '', fecha: '2026-02-20' } })))).message).toBe('Escribe el número de la factura que rectificas.');
    expect((await error(incomeInvoicesService.crearIngreso(abono({ rectificaFuera: { numero: 'A-2026-002', fecha: '2026-02-30' } })))).statusCode).toBe(400);
    expect((await error(incomeInvoicesService.crearIngreso(abono({ facturaOriginalId: 'otra' })))).statusCode).toBe(400);
    expect((await error(incomeInvoicesService.crearIngreso(abono({ tipoFactura: 'R5' })))).statusCode).toBe(400);
    expect((await error(incomeInvoicesService.crearIngreso(abono({ tipoRectificativa: 'S' })))).statusCode).toBe(400);
  });
});
