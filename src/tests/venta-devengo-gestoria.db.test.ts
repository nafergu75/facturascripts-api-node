/**
 * Venta emitida en la app con la operacion de un periodo cuyo 303 presenta la
 * gestoria (la empresa lleva sus impuestos en la app desde el 1-1-2027): por
 * ejemplo, una entrega del 20-12-2026 facturada el 10-1-2027. Su IVA va en el
 * 303 del 4T de 2026, que no esta en la app: sin confirmar, 409 que lo
 * explica; confirmada, se emite con el aviso.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import type { HttpError } from '../utils/http-errors';
import { empresaDePrueba } from './fixtures/arranque/importar';

const E = `venta-devengo-${Date.now()}`;
let clienteId = '';

const linea = { descripcion: 'Entrega de diciembre', cantidad: 1, precioUnitario: 1000, tipoIva: 21 };
const TEXTO =
  'La operación es del 20/12/2026: su IVA va en el 303 del 4T de 2026, que se presenta fuera de la app (por ejemplo, lo lleva tu gestoría). Emítela igualmente y pasa la factura a quien presente ese 303 para que la incluya, y también en su 390 y su 347.';

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
  await prisma.ajustesFiscales.create({ data: { companyId: E, inicioEnApp: '2027-01-01' } });
  clienteId = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Alfa SL', nifCif: 'B46000014' } })).id;
  // Las facturas de 2027 no se emiten antes de su fecha: solo se finge la fecha.
  jest.useFakeTimers({
    now: new Date('2027-01-20T10:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
});

afterAll(() => {
  jest.useRealTimers();
});

describe('venta de 2027 con la operación en un periodo de la gestoría', () => {
  it('pasar el borrador a factura: 409 que lo explica; confirmado, se emite con el aviso', async () => {
    const b = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2027-01-10', fechaOperacion: '2026-12-20', lineas: [linea], borrador: true });
    const e = await error(incomeInvoicesService.finalizar(E, b.id, { fechaEmision: '2027-01-10' }));
    expect(e.statusCode).toBe(409);
    expect(e.message).toBe(TEXTO);
    expect(e.details).toMatchObject({ codigo: 'DEVENGO_FUERA_APP', modelo: '303', ejercicio: 2026, periodo: '4T' });
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).estadoDocumento).toBe('BORRADOR');

    const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: '2027-01-10', confirmaDevengoFuera: true });
    expect(f.estadoDocumento).toBe('FINAL');
    expect(f.avisosFiscales).toEqual(expect.arrayContaining([{ codigo: 'DEVENGO_FUERA_APP', mensaje: TEXTO }]));
  });

  it('emitirla directamente: el 409 sale antes de crear el cliente nuevo; confirmada, se emite', async () => {
    const cuerpo = {
      companyId: E,
      customer: { nuevo: { nombreFiscal: 'Cliente Nuevo SL', nifCif: 'B46000022' } },
      fechaEmision: '2027-01-10',
      fechaOperacion: '2026-12-20',
      lineas: [linea],
    };
    const e = await error(incomeInvoicesService.crearIngreso(cuerpo));
    expect(e.statusCode).toBe(409);
    expect(e.details).toMatchObject({ codigo: 'DEVENGO_FUERA_APP' });
    expect(await prisma.customer.count({ where: { companyId: E, nifCif: 'B46000022' } })).toBe(0);

    const f = await incomeInvoicesService.crearIngreso({ ...cuerpo, confirmaDevengoFuera: true });
    expect(f.estadoDocumento).toBe('FINAL');
    expect(f.avisosFiscales?.map((a) => a.codigo)).toContain('DEVENGO_FUERA_APP');
  });

  it('una operación de 2027, o un borrador, no preguntan nada', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2027-01-10', fechaOperacion: '2027-01-05', lineas: [linea] });
    expect(f.avisosFiscales?.map((a) => a.codigo) ?? []).not.toContain('DEVENGO_FUERA_APP');
    const b = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: clienteId }, fechaEmision: '2027-01-10', fechaOperacion: '2026-12-20', lineas: [linea], borrador: true });
    expect(b.estadoDocumento).toBe('BORRADOR');
  });

  it('una entrega intracomunitaria de diciembre facturada el 10 de enero devenga en enero: no pregunta', async () => {
    const aleman = (await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Müller GmbH', nifCif: 'DE123456789', pais: 'DE' } })).id;
    const f = await incomeInvoicesService.crearIngreso({
      companyId: E,
      customer: { id: aleman },
      fechaEmision: '2027-01-10',
      fechaOperacion: '2026-12-20',
      tipoOperacion: 'INTRACOMUNITARIA',
      lineas: [{ ...linea, tipoIva: 0 }],
    });
    expect(f.estadoDocumento).toBe('FINAL');
    expect(f.avisosFiscales?.map((a) => a.codigo) ?? []).not.toContain('DEVENGO_FUERA_APP');
  });
});
