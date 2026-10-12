/**
 * Compra intracomunitaria con factura de diciembre de 2026 registrada en enero
 * de 2027, en una empresa que lleva sus impuestos en la app desde el 1-1-2027.
 * Su IVA se devenga en la fecha de la factura (art. 76 LIVA): va en el 303 y
 * el 349 del 4T de 2026, que presenta la gestoria. Sin confirmar, 409 que lo
 * explica; confirmada, se registra y no entra en el 303, el 390 ni el 349 de
 * 2027 (el asiento si va en 2027). Una de enero de 2027 sigue como siempre.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { editarGasto, registrarGasto } from '../services/expense-invoices.service';
import { calcularModelo303, calcularModelo349, calcularModelo390 } from '../services/impuestosCalculo.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import type { HttpError } from '../utils/http-errors';
import { empresaDePrueba } from './fixtures/arranque/importar';

const E = `compra-ic-gestoria-${Date.now()}`;
let rossi = '';

const compra = (numero: string, fechaEmision: string, fechaRegistro?: string, extra: Record<string, unknown> = {}) => ({
  proveedor: { id: rossi },
  numeroFacturaProveedor: numero,
  fechaEmision,
  ...(fechaRegistro ? { fechaRegistro } : {}),
  tipoGasto: 'COMPRA',
  lineas: [{ descripcion: 'Maquinaria ligera', cantidad: 1, precioUnitario: 4000, tipoIva: 0 }],
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

const c303 = async (periodo: string) => (await calcularModelo303(E, periodoFiscal(2027, periodo))).casillasOficiales ?? {};

beforeAll(async () => {
  await empresaDePrueba(E);
  await prisma.ajustesFiscales.create({ data: { companyId: E, inicioEnApp: '2027-01-01' } });
  rossi = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Rossi SpA', nifCif: 'IT12345678901', pais: 'IT' } })).id;
});

describe('compra intracomunitaria de diciembre de 2026 registrada en enero de 2027', () => {
  it('sin confirmar: 409 que dice que va en el 303 y el 349 de la gestoría', async () => {
    const e = await error(registrarGasto(E, compra('IT-1', '2026-12-20', '2027-01-10'), { contabilizar: 'POSTED' }));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe(
      'El IVA de esta compra intracomunitaria se devengó el 20/12/2026, la fecha de la factura: va en el 303 y el 349 del 4T de 2026, que presenta tu gestoría. Regístrala igualmente y pásale la factura a la gestoría. En la app no entrará en los modelos de 2027.',
    );
    expect(e.details).toMatchObject({ codigo: 'DEVENGO_FUERA_APP', modelo: '303', ejercicio: 2026, periodo: '4T' });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(0);
  });

  it('confirmada: el asiento va en 2027, pero no entra en el 303, el 390 ni el 349 de 2027', async () => {
    const r = await registrarGasto(E, compra('IT-1', '2026-12-20', '2027-01-10', { confirmaDevengoFuera: true }), { contabilizar: 'POSTED' });
    const f = await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: r.factura.id } });
    expect(f.fechaImputacionIva).toBe('2026-12-20');
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } });
    expect(asiento.fecha.toISOString().slice(0, 10)).toBe('2027-01-10');
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E, asientoId: r.asientoId } });
    expect(libro.fechaFactura.toISOString().slice(0, 10)).toBe('2026-12-20');

    const c = await c303('1T');
    expect(Number(c['10'] ?? 0)).toBe(0);
    expect(Number(c['36'] ?? 0)).toBe(0);
    expect((await calcularModelo349(E, periodoFiscal(2027, '1T'))).operaciones).toEqual([]);
    const m390 = await calcularModelo390(E, 2027);
    expect(JSON.stringify(m390)).not.toContain('4000');
  });

  it('corregirla no vuelve a preguntar y la deja igual', async () => {
    const f = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, numeroFacturaProveedor: 'IT-1' } });
    await editarGasto(E, f.id, compra('IT-1', '2026-12-20', '2027-01-12'));
    expect((await prisma.expenseInvoice.findUniqueOrThrow({ where: { id: f.id } })).fechaImputacionIva).toBe('2026-12-20');
  });

  it('desde el lector: se confirma al registrarla y el asiento se aprueba sin más', async () => {
    const r = await registrarGasto(E, compra('IT-2', '2026-12-28', '2027-01-15', { confirmaDevengoFuera: true }), { contabilizar: 'DRAFT' });
    await new AccountingEngineController().aprobarAsiento(E, r.asientoId, 'u-test');
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.asientoId } })).estado).toBe('POSTED');
  });

  it('una compra intracomunitaria de enero de 2027 sigue en el 303 y el 349 de 2027, sin preguntar', async () => {
    await registrarGasto(E, compra('IT-3', '2027-01-05', '2027-01-10'), { contabilizar: 'POSTED' });
    const c = await c303('1T');
    expect(Number(c['10'])).toBe(4000);
    expect(Number(c['11'])).toBe(840);
    const ops = (await calcularModelo349(E, periodoFiscal(2027, '1T'))).operaciones;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ base: 4000 });
  });
});
