/**
 * Lecturas del lector de ventas con Azure, sobre BD real y sin llamar a Azure
 * ni a Anthropic. Al terminar se crea el documento del lector de siempre
 * (IncomeReaderDocument), y /ingresos-extractor/confirmar lo registra.
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
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import ingresosRoutes from '../routes/ingresos-extractor.routes';
import { _reiniciarPausa } from '../services/lectura/azure-di.client';
import { aceptado, CLAVE, ENDPOINT, fixtureClaude, NIF_EMISOR, respuesta, resultado } from './fixtures/azure-di';

const E = `lecturas-ventas-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura emitida');

function app() {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-ventas', email: 'ventas@test.local', roles: ['ventas'], companies: [E], rolesPorEmpresa: { [E]: ['ventas'] } } as never;
    req.companyId = E;
    next();
  });
  a.use('/ingresos-extractor', ingresosRoutes);
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
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
});

async function leer(fixture: string): Promise<Record<string, any>> {
  const p = await request(app()).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'emitida.pdf');
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

describe('lecturas del lector de ventas', () => {
  it('LISTA crea el documento del lector (EXTRACTOR_IA) y ingreso.documentId es el suyo', async () => {
    const data = await leer('resultado-simple');
    expect(data.ingreso).toMatchObject({ numeroFactura: 'F2026/0012', nifCliente: 'B87654323', cliente: 'COMERCIAL DEMO SL', base: 200, iva: 42, total: 242, errores: [] });
    expect(data.lectura).toMatchObject({ origen: 'AZURE', estado: 'ok', requiereRevision: false, confianza: 0.9 });
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect(doc).toMatchObject({ companyId: E, sourceType: 'EXTRACTOR_IA', status: 'READY_FOR_VERIFICATION', originalFileName: 'emitida.pdf' });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect(fila.incomeReaderDocumentId).toBe(doc.id);
    expect(doc.storagePath).toBe(fila.archivoRef);
  });

  it('/ingresos-extractor/confirmar crea la factura y deja la lectura CONFIRMADA con incomeInvoiceId', async () => {
    const data = await leer('resultado-simple');
    const r = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'F2026-12', total: 242 });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect(fila).toMatchObject({ estado: 'CONFIRMADA', incomeInvoiceId: r.body.data.facturaId, confirmadaPor: 'u-ventas' });
    // La misma factura otra vez: la lectura nueva ya la marca como duplicada (error).
    const otra = await leer('resultado-simple');
    expect(otra.lectura.estado).toBe('error');
    expect(otra.ingreso.errores).toContain('Ya registraste esta factura (F2026-12).');
  });

  it('con recargo o rectificativa, confirmar da 400 con el mensaje de V05 o de V19', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-recargo'));
    const recargo = await leer('resultado-recargo');
    const r1 = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: recargo.ingreso.documentId, revisado: true });
    expect(r1.status).toBe(400);
    expect(r1.body.message).toContain('Las facturas con recargo de equivalencia aún no se pueden registrar con el lector.');

    crear.mockResolvedValueOnce(fixtureClaude('complemento-rectificativa'));
    const rect = await leer('resultado-rectificativa');
    expect(rect.lectura.origen).toBe('AZURE_CLAUDE');
    const r2 = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: rect.ingreso.documentId, revisado: true });
    expect(r2.status).toBe(400);
    expect(r2.body.message).toContain('Es una factura rectificativa (rectifica a la A-12). Todavía no se puede registrar con el lector.');
  });

  it('lo que la lectura dejo en error bloquea aunque el documento se corrija despues', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-recargo'));
    const recargo = await leer('resultado-recargo');
    // Como hace PUT /invoice-extractor/:id: rehace validation.errors y se pierden los nuevos.
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: recargo.ingreso.documentId } });
    const parsed = doc.parsedData as Record<string, any>;
    await prisma.incomeReaderDocument.update({ where: { id: doc.id }, data: { parsedData: { ...parsed, validation: { ...parsed.validation, errors: [] } } } });
    const r = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: recargo.ingreso.documentId, revisado: true });
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('VALIDACION_LECTURA');
    expect(r.body.message).toContain('Las facturas con recargo de equivalencia aún no se pueden registrar con el lector.');
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: recargo.lecturaId } })).toMatchObject({ estado: 'LISTA' });
  });

  it('descartar: el documento del lector queda REJECTED y sin los datos leidos', async () => {
    const data = await leer('resultado-simple');
    const r = await request(app()).post(`/ingresos-extractor/lecturas/${data.lecturaId}/descartar`);
    expect(r.status).toBe(200);
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect(doc).toMatchObject({ status: 'REJECTED', parsedData: null, storagePath: '' });
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } })).toMatchObject({ estado: 'DESCARTADA', resultado: null });
  });

  it('una lectura con algo marcado necesita revisado al confirmar', async () => {
    const data = await leer('resultado-confianza-baja');
    expect(data.lectura.requiereRevision).toBe(true);
    const r = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('FALTA_REVISION');
  });
});
