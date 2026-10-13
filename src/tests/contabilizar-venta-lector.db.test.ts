/**
 * La factura NZ004_26 (13-10-2026), sobre BD real y sin llamar a Azure ni a
 * Anthropic: una venta leida con el lector, el cliente dado de alta desde el
 * aviso «Dar de alta este cliente», una linea cambiada a la 701 con «Cambiar
 * cuenta» y la contabilizacion automatica que falla porque la transaccion
 * caduca. La factura queda registrada sin asiento, con un aviso en castellano
 * (no el texto de Prisma), y «Contabilizar» desde su ficha crea despues el
 * asiento con la 701 elegida, la 430 del cliente y la 477.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba-0123456789abcdefghijklmnopqrstuv';

const crear = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: crear } })),
}));

const almacen = new Map<string, Buffer>();
jest.mock('../utils/storage', () => ({
  putObject: jest.fn(async (key: string, data: Buffer) => {
    almacen.set(`mem://${key}`, data);
    return `mem://${key}`;
  }),
  getObject: jest.fn(async (ref: string) => {
    const b = almacen.get(ref);
    if (!b) throw new Error('no existe');
    return b;
  }),
  deleteObject: jest.fn(async (ref: string) => {
    almacen.delete(ref);
  }),
  deleteObjects: jest.fn(async () => undefined),
  getObjectByKey: jest.fn(async () => null),
  listObjects: jest.fn(async () => []),
}));

import express from 'express';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import ingresosRoutes from '../routes/ingresos-extractor.routes';
import { accountingEngineRoutes } from '../routes/accounting-engine.routes';
import { accountingEngineService } from '../services/accounting-engine.service';
import { clientesService } from '../services/clientes.service';
import { _reiniciarPausa } from '../services/lectura/azure-di.client';
import { aceptado, CLAVE, ENDPOINT, NIF_EMISOR, respuesta, resultado } from './fixtures/azure-di';

const E = `venta-lector-sin-asiento-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura emitida');

const caducada = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Invalid `prisma.journalEntry.create()` invocation:\n\nTransaction API error: Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5017 ms passed since the start of the transaction.',
    { code: 'P2028', clientVersion: Prisma.prismaVersion.client },
  );

function app() {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-admin', email: 'admin@test.local', roles: ['admin'], companies: [E], rolesPorEmpresa: { [E]: ['admin'] }, sesionVerificada: true } as never;
    req.companyId = E;
    next();
  });
  a.use('/ingresos-extractor', ingresosRoutes);
  a.use('/companies/:companyId/accounting', accountingEngineRoutes);
  a.use(errorMiddleware);
  return a;
}

let fetchMock: jest.SpyInstance;
let colaGet: Array<() => Response>;
beforeEach(() => {
  _reiniciarPausa();
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = ENDPOINT;
  process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = CLAVE;
  colaGet = [];
  crear.mockReset();
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const metodo = (init as RequestInit).method;
    if (metodo === 'DELETE') return respuesta(null, 204);
    if (metodo === 'POST') return aceptado();
    const siguiente = colaGet.shift();
    if (!siguiente) throw new Error('GET no esperado');
    return siguiente();
  });
});
afterEach(() => {
  fetchMock.mockRestore();
  jest.restoreAllMocks();
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
});

async function leer(fixture: string): Promise<Record<string, any>> {
  const p = await request(app()).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'NZ004_26.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => resultado(fixture));
  const r = await request(app()).get(`/ingresos-extractor/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // En ventas la empresa es la emisora de los fixtures.
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
});

describe('venta leida cuya contabilizacion automatica falla por la base de datos', () => {
  let facturaId: string;
  let clienteId: string;

  it('la factura queda registrada sin asiento y el aviso lo dice en castellano, sin el texto de Prisma', async () => {
    const data = await leer('resultado-simple');
    expect(data.ingreso.clienteExistente).toBeNull();
    // «Dar de alta este cliente», con lo leido.
    clienteId = ((await clientesService.create(E, { nombreFiscal: data.ingreso.cliente, nifCif: data.ingreso.nifCliente })) as { id: string }).id;

    // La transaccion del asiento caduca, como en produccion.
    jest.spyOn(accountingEngineService, 'contabilizarFacturaIngreso').mockRejectedValueOnce(caducada());
    const r = await request(app())
      .post('/ingresos-extractor/confirmar')
      .send({ documentId: data.ingreso.documentId, clienteId, lineas: [{ cuenta: '701' }] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'F2026/0012', total: 242, contabilizada: false });
    expect(r.body.data.motivoSinAsiento).toBe('La base de datos ha tardado demasiado en responder. La factura sí está registrada.');
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|transaction|invocation/i);
    facturaId = r.body.data.facturaId;

    // Sin asiento, con la linea en la 701; y la subcuenta del cliente no ha
    // quedado a medias en el plan: iba en la misma transaccion que el asiento.
    expect(await prisma.journalEntry.count({ where: { companyId: E, invoiceId: facturaId } })).toBe(0);
    const lineas = await prisma.incomeInvoiceLine.findMany({ where: { invoiceId: facturaId } });
    expect(lineas.map((l) => l.accountCode)).toEqual(['701']);
    const cliente = await prisma.customer.findUniqueOrThrow({ where: { id: clienteId } });
    expect(await prisma.chartOfAccounts.count({ where: { companyId: E, codigo: cliente.subcuenta430! } })).toBe(0);
  });

  it('«Contabilizar» con la base de datos aun lenta: 503 con un texto claro y sigue sin asiento', async () => {
    jest.spyOn(accountingEngineService, 'contabilizarFacturaIngreso').mockRejectedValueOnce(caducada());
    const r = await request(app()).post(`/companies/${E}/accounting/contabilizar/${facturaId}?tipo=INGRESO`).send({});
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('La base de datos ha tardado demasiado en responder. El asiento no se ha creado: vuelve a pulsar «Contabilizar» dentro de un momento.');
    expect(JSON.stringify(r.body)).not.toMatch(/prisma|transaction|invocation/i);
    expect(await prisma.journalEntry.count({ where: { companyId: E, invoiceId: facturaId } })).toBe(0);
  });

  it('«Contabilizar» desde la ficha crea el asiento con la 701 elegida, la 430 del cliente y la 477', async () => {
    const r = await request(app()).post(`/companies/${E}/accounting/contabilizar/${facturaId}?tipo=INGRESO`).send({});
    expect(r.status).toBe(200);
    // Viene del lector: en borrador, para revisarlo en el Motor contable.
    expect(r.body.estado).toBe('DRAFT');
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.journalEntryId }, include: { lineas: true } });
    expect(asiento).toMatchObject({ companyId: E, invoiceId: facturaId, estado: 'DRAFT', origen: 'FACTURA_INGRESO' });
    const cliente = await prisma.customer.findUniqueOrThrow({ where: { id: clienteId } });
    expect(cliente.subcuenta430).toMatch(/^430\d+$/);
    expect(Object.fromEntries(asiento.lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber), l.accountName]]))).toEqual({
      [cliente.subcuenta430!]: [242, 0, 'COMERCIAL DEMO SL'],
      '701': [0, 200, 'Ventas de productos terminados'],
      '477': [0, 42, 'IVA repercutido'],
    });
    // La subcuenta del cliente, ya en el plan; y la factura en el libro de facturas expedidas.
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: E, codigo: cliente.subcuenta430! } })).toMatchObject({ nombre: 'COMERCIAL DEMO SL' });
    const libro = await prisma.vATBook.findMany({ where: { companyId: E, asientoId: asiento.id } });
    expect(libro.map((l) => [l.tipoLibro, l.numeroFactura, Number(l.baseImponible), l.tipoIva, Number(l.cuotaIva)])).toEqual([['EMITIDAS', 'F2026/0012', 200, 21, 42]]);
    // Otra vez: ya esta contabilizada.
    const otra = await request(app()).post(`/companies/${E}/accounting/contabilizar/${facturaId}?tipo=INGRESO`).send({});
    expect(otra.status).toBe(400);
    expect(otra.body.details).toMatchObject({ codigo: 'YA_CONTABILIZADA', journalEntryId: asiento.id });
  });
});
