/**
 * Un fallo de la base de datos al mirar si un periodo esta abierto no es
 * «periodo cerrado».
 *
 * Al anular un cobro (y en las partidas de 2026, las aplicaciones de abonos,
 * las nominas y el lector) se mira si el mes del asiento sigue abierto: si lo
 * esta, el asiento pasa a REVERSED; si no, se hace un contraasiento con otra
 * fecha. Antes, cualquier error de esa comprobacion contaba como «cerrado»,
 * tambien un P2024 o un P1001 tras los reintentos: un corte pasajero creaba un
 * contraasiento que no tocaba (o pedia una fecha sin motivo). Ahora solo un
 * HttpError (mes cerrado o bloqueado, ejercicio cerrado, año de la gestoria)
 * cuenta como no abierto; el resto se relanza y la persona lee el 503 claro.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { anularCobroFactura, registrarCobroFactura } from '../services/cobrosPagos.service';
import { fechaAbierta } from '../services/periodos.service';
import { HttpError } from '../utils/http-errors';

const COMPANY_ID = `periodo-fallo-bd-${Date.now()}`;
let customerId: string;
let bancoId: string;

/** El error de Prisma de un pool agotado (sin conexion libre a tiempo). */
const poolAgotado = () =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
    code: 'P2024',
    clientVersion: Prisma.prismaVersion.client,
  });

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Periodo Fallo BD SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Periodo Fallo BD SL', nif: 'B12000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Fallo SL', nifCif: 'B22000000' } })).id;
  bancoId = (
    await prisma.bankAccount.create({ data: { companyId: COMPANY_ID, iban: 'ES0000000000000000000058', bancoNombre: 'Banco Fallo', subcuentaCodigo: '57200002' } })
  ).id;
}, 60_000);

describe('fechaAbierta', () => {
  // Un cliente a medida: solo la consulta del año llevado por la gestoria (la primera que se hace).
  const conFiscalYear = (findFirst: () => Promise<unknown>) => ({ fiscalYear: { findFirst } }) as never;

  it('un año que lleva la gestoria no esta abierto (false)', async () => {
    await expect(fechaAbierta('x', '2025-03-01', conFiscalYear(async () => ({ llevanza: 'EXTERNA' })))).resolves.toBe(false);
  });

  it('un fallo de la base de datos se relanza: no es «periodo cerrado»', async () => {
    const error = poolAgotado();
    await expect(
      fechaAbierta('x', '2026-10-01', conFiscalYear(async () => {
        throw error;
      })),
    ).rejects.toBe(error);
  });

  it('con la base de datos de verdad, un mes sin nada cerrado esta abierto', async () => {
    await expect(fechaAbierta(COMPANY_ID, '2026-10-01')).resolves.toBe(true);
  });
});

describe('anular un cobro si la base de datos falla al mirar el periodo', () => {
  it('da el 503 claro y no anula nada (antes hacia un contraasiento como si el mes estuviera cerrado)', async () => {
    const f = await incomeInvoicesService.crearIngreso({
      companyId: COMPANY_ID,
      customer: { id: customerId },
      fechaEmision: '2026-10-01',
      fechaVencimiento: '2099-12-31',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 }],
    });
    const { cobro } = await registrarCobroFactura(COMPANY_ID, 'INGRESO', f.id, { fecha: '2026-10-05', cuentaBancariaId: bancoId });
    const asientosAntes = await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } });

    // La primera consulta de la comprobacion del periodo (el año de la gestoria) falla.
    const espia = jest.spyOn(prisma.fiscalYear, 'findFirst').mockRejectedValueOnce(poolAgotado() as never);
    let error: unknown;
    try {
      await anularCobroFactura(COMPANY_ID, 'INGRESO', f.id, cobro.id, { fecha: '2026-10-14' });
    } catch (e) {
      error = e;
    } finally {
      espia.mockRestore();
    }

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(503);
    expect((error as HttpError).message).toBe(
      'La base de datos ha tardado demasiado en responder. El cobro no se ha anulado: vuelve a intentarlo dentro de un momento.',
    );
    // Ni contraasiento ni cobro anulado: todo como estaba.
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_ID } })).toBe(asientosAntes);
    expect(await prisma.invoicePayment.findUniqueOrThrow({ where: { id: cobro.id } })).toMatchObject({ estado: 'ACTIVO', anulacionEntryId: null });
    expect(await prisma.journalEntry.findUniqueOrThrow({ where: { id: cobro.asientoId! } })).toMatchObject({ estado: 'POSTED' });

    // Con la base de datos bien, se anula como siempre: mes abierto, el asiento pasa a REVERSED.
    const r = await anularCobroFactura(COMPANY_ID, 'INGRESO', f.id, cobro.id, { fecha: '2026-10-14' });
    expect(r.contraasiento).toBe(false);
    expect(await prisma.journalEntry.findUniqueOrThrow({ where: { id: cobro.asientoId! } })).toMatchObject({ estado: 'REVERSED' });
  }, 60_000);
});
