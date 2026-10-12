/**
 * Lectores de gastos y de ventas: la factura no se registra hasta que el
 * proveedor o el cliente esta dado de alta (o se elige uno que ya existe).
 * Decision del usuario del 12-10-2026 (spec lector-arrastrar-alta.md).
 *
 *  - La lectura de ventas dice si el cliente existe (clienteExistente), como
 *    proveedorExistente en gastos: en /lecturas y en /extraer-ia.
 *  - Los dos /confirmar responden 400 TERCERO_NO_DADO_DE_ALTA si llega un
 *    tercero nuevo sin identificador, y no crean nada.
 *  - Las altas de proveedor y de cliente que usara la pantalla aceptan todo lo
 *    que lee el lector y asignan la subcuenta.
 *
 * Sobre BD real, sin llamar a Azure ni a Anthropic (fetch con los fixtures,
 * SDK simulado y almacenamiento en memoria). Necesita MySQL.
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

// El /extraer-ia de ventas de siempre, sin Anthropic: devuelve una extraccion hecha.
const mockExtraerVenta = jest.fn();
jest.mock('../services/invoice-extractor.service', () => {
  const real = jest.requireActual('../services/invoice-extractor.service');
  return { ...real, invoiceExtractorService: { ...real.invoiceExtractorService, extraer: (...a: unknown[]) => mockExtraerVenta(...a) } };
});

import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import gastosRoutes from '../routes/gastos-extractor.routes';
import ingresosRoutes from '../routes/ingresos-extractor.routes';
import clientesRoutes from '../routes/clientes.routes';
import proveedoresRoutes from '../routes/proveedores.routes';
import incomeReaderRoutes from '../routes/income-reader.routes';
import { _reiniciarPausa } from '../services/lectura/azure-di.client';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import { controlCif } from '../utils/nif';
import { aceptado, CLAVE, ENDPOINT, fixtureAzure, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado } from './fixtures/azure-di';

const BASE = `lector-tercero-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura');
/** Cliente de los fixtures de Azure (la empresa emite a el en ventas). */
const NIF_CLIENTE = NIF_EMPRESA; // B87654323, COMERCIAL DEMO SL

function app(companyId: string) {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-lector', email: 'lector@test.local', roles: ['admin'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['admin'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/gastos-extractor', gastosRoutes);
  a.use('/ingresos-extractor', ingresosRoutes);
  a.use('/clientes', clientesRoutes);
  a.use('/proveedores', proveedoresRoutes);
  a.use('/income-reader', incomeReaderRoutes);
  a.use(errorMiddleware);
  return a;
}

let colaGet: Array<() => Response>;
let fetchMock: jest.SpyInstance;
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

let n = 0;
/** Una empresa nueva para cada caso: asi la misma factura no sale repetida. */
async function empresa(nif: string): Promise<string> {
  const id = `${BASE}-${++n}`;
  await prisma.company.create({ data: { id, name: `Empresa ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Empresa ${n} SL`, nif } });
  // Empresa nueva sin el plan de la gestoria: se confirma de antemano el aviso del primer
  // cliente o proveedor (arranque-primer-tercero lo prueba aparte).
  await exigirPlanAnteriorAntesDeAlta(id, true, 'test');
  return id;
}

/** Lee con Azure simulado (fixture resultado-simple) y devuelve la lectura LISTA. */
async function leer(companyId: string, lector: 'gastos-extractor' | 'ingresos-extractor'): Promise<Record<string, any>> {
  const p = await request(app(companyId)).post(`/${lector}/lecturas`).attach('archivo', PDF, 'factura.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => resultado('resultado-simple'));
  const r = await request(app(companyId)).get(`/${lector}/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

const cif = (siete: string) => `B${siete}${controlCif(siete).cifra}`;

// ---------------------------------------------------------------------------
// Ventas: clienteExistente y confirmar
// ---------------------------------------------------------------------------

describe('lector de ventas: clienteExistente', () => {
  it('/lecturas: null si no hay ningun cliente con ese NIF', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor');
    expect(data.ingreso).toMatchObject({ nifCliente: NIF_CLIENTE, cliente: 'COMERCIAL DEMO SL', clienteExistente: null });
  });

  it('/lecturas: el cliente de la empresa con ese NIF aunque se guardara con prefijo ES o con guiones', async () => {
    const E = await empresa(NIF_EMISOR);
    const c = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Comercial Demo, S.L.', nifCif: `ES${NIF_CLIENTE}` } });
    const data = await leer(E, 'ingresos-extractor');
    expect(data.ingreso.clienteExistente).toEqual({ id: c.id, nombreFiscal: 'Comercial Demo, S.L.', nifCif: `ES${NIF_CLIENTE}` });
  });

  it('/lecturas: el cliente de otra empresa no cuenta', async () => {
    const E = await empresa(NIF_EMISOR);
    const OTRA = await empresa(NIF_EMISOR);
    await prisma.customer.create({ data: { companyId: OTRA, nombreFiscal: 'Comercial Demo SL', nifCif: NIF_CLIENTE } });
    const data = await leer(E, 'ingresos-extractor');
    expect(data.ingreso.clienteExistente).toBeNull();
  });

  it('/extraer-ia (el de siempre): tambien dice si el cliente existe', async () => {
    const E = await empresa(NIF_EMISOR);
    const c = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente SL', nifCif: cif('2222222') } });
    const extraccion = (nif: string | null) => ({
      document_type: 'invoice',
      language: 'es',
      currency: 'EUR',
      vendor: { name: 'Empresa SL', tax_id: NIF_EMISOR, address: null, country: 'ES' },
      customer: { name: 'Cliente SL', tax_id: nif, address: 'Calle 1', country: 'ES' },
      invoice: { number: '7', series: 'A', issue_date: '2026-03-01', due_date: null, is_simplified: false, is_rectifying: false, rectified_invoice_number: null },
      lines: [{ description: 'Servicio', quantity: 1, unit_price: 100, discount_pct: 0, tax_rate: 21, total: 100 }],
      amounts: { bases: [{ tax_rate: 21, base_amount: 100, tax_amount: 21 }], subtotal: 100, tax_total: 21, withholdings: [], withholding_total: 0, total: 121, total_net: 121 },
      validation: { checks: {}, errors: [], warnings: [] },
      confidence: 0.9,
    });
    mockExtraerVenta.mockResolvedValueOnce({ documentId: 'doc-1', extraccion: extraccion(`ES-${cif('2222222')}`) });
    const r = await request(app(E)).post('/ingresos-extractor/extraer-ia').attach('archivo', PDF, 'f.pdf');
    expect(r.status).toBe(201);
    expect(r.body.data.clienteExistente).toEqual({ id: c.id, nombreFiscal: 'Cliente SL', nifCif: cif('2222222') });
    mockExtraerVenta.mockResolvedValueOnce({ documentId: 'doc-2', extraccion: extraccion(null) });
    const sinNif = await request(app(E)).post('/ingresos-extractor/extraer-ia').attach('archivo', PDF, 'f.pdf');
    expect(sinNif.status).toBe(201);
    expect(sinNif.body.data.clienteExistente).toBeNull();
  });
});

describe('lector de ventas: confirmar exige el cliente dado de alta', () => {
  it('cliente nuevo: 400 TERCERO_NO_DADO_DE_ALTA con el nombre y el NIF; no crea cliente ni factura y la lectura sigue LISTA', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor');
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Este cliente no está dado de alta: COMERCIAL DEMO SL (B87654323). Dalo de alta o elige uno que ya tengas para poder registrar la factura.');
    expect(r.body.details).toMatchObject({ codigo: 'TERCERO_NO_DADO_DE_ALTA', tipo: 'cliente', campo: 'clienteId', nombre: 'COMERCIAL DEMO SL', nif: NIF_CLIENTE });
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.incomeInvoice.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } })).toMatchObject({ estado: 'LISTA' });
    expect(await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } })).toMatchObject({ status: 'READY_FOR_VERIFICATION' });
  });

  it('dado de alta con POST /clientes con lo leido: se registra con ese cliente y su subcuenta', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor');
    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: data.ingreso.cliente, nifCif: data.ingreso.nifCliente, pais: 'ES' });
    expect(alta.status).toBe(201);
    expect(alta.body.data.subcuenta430).toMatch(/^430\d+$/);
    // La pantalla vuelve a consultar y ya lo encuentra.
    const otra = await request(app(E)).get(`/ingresos-extractor/lecturas/${data.lecturaId}`);
    expect(otra.body.data.ingreso.clienteExistente).toMatchObject({ id: alta.body.data.id });
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: alta.body.data.id });
    expect(r.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } });
    expect(f.customerId).toBe(alta.body.data.id);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(1);
  });

  it('sin clienteId pero ya dado de alta con ese NIF: se registra con el (como antes)', async () => {
    const E = await empresa(NIF_EMISOR);
    const c = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Comercial Demo SL', nifCif: NIF_CLIENTE } });
    const data = await leer(E, 'ingresos-extractor');
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(201);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } })).customerId).toBe(c.id);
  });

  it('«Es uno que ya tengo» con el NIF mal leido: el clienteId elegido manda', async () => {
    const E = await empresa(NIF_EMISOR);
    const elegido = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Comercial Demo Sociedad Limitada', nifCif: cif('5555555') } });
    const data = await leer(E, 'ingresos-extractor');
    expect(data.ingreso.clienteExistente).toBeNull();
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: elegido.id });
    expect(r.status).toBe(201);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } })).customerId).toBe(elegido.id);
    // No se ha creado ningun cliente con el NIF leido.
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(1);
  });

  it('un clienteId de otra empresa: 404 y nada nuevo', async () => {
    const E = await empresa(NIF_EMISOR);
    const OTRA = await empresa(NIF_EMISOR);
    const ajeno = await prisma.customer.create({ data: { companyId: OTRA, nombreFiscal: 'Ajeno SL', nifCif: NIF_CLIENTE } });
    const data = await leer(E, 'ingresos-extractor');
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: ajeno.id });
    expect(r.status).toBe(404);
    expect(await prisma.incomeInvoice.count({ where: { companyId: E } })).toBe(0);
  });

  it('un clienteId que no es texto: 400', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor');
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: 12 });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ campo: 'clienteId' });
  });

  it('sin NIF del cliente en la factura: con un cliente elegido se puede registrar', async () => {
    const E = await empresa(NIF_EMISOR);
    const p = await request(app(E)).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'factura.pdf');
    const id = p.body.data.lecturaId;
    await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
    const sinNif = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, unknown> }> } }>('resultado-simple');
    delete sinNif.analyzeResult.documents[0].fields.CustomerTaxId;
    colaGet.push(() => respuesta(sinNif, 200));
    // Claude completaria el NIF: responde sin el (no lo ve).
    crear.mockRejectedValue(Object.assign(new Error('x'), { status: 529 }));
    const data = (await request(app(E)).get(`/ingresos-extractor/lecturas/${id}`)).body.data;
    expect(data.estado).toBe('LISTA');
    expect(data.ingreso.nifCliente).toBeNull();
    expect(data.ingreso.clienteExistente).toBeNull();
    expect(data.ingreso.errores).toContain('Falta el NIF del cliente: es obligatorio en una factura de ingreso.');
    // Sin cliente elegido: lo de siempre (falta el NIF), sin crear nada.
    const sin = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true });
    expect(sin.status).toBe(400);
    expect(sin.body.message).toMatch(/Falta el NIF del cliente/);
    const elegido = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Comercial Demo SL', nifCif: NIF_CLIENTE } });
    const con = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true, clienteId: elegido.id });
    expect(con.status).toBe(201);
    expect((await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: con.body.data.facturaId } })).customerId).toBe(elegido.id);
  });
});

// ---------------------------------------------------------------------------
// Gastos: confirmar
// ---------------------------------------------------------------------------

describe('lector de gastos: confirmar exige el proveedor dado de alta', () => {
  const cuerpo = (extra: Record<string, unknown> = {}) => ({
    numeroFacturaProveedor: 'F2026/0012',
    fechaEmision: '2026-03-04',
    tipoGasto: 'SUMINISTROS',
    cuentaGasto: '629',
    lineas: [{ descripcion: 'Folletos', cantidad: 1, precioUnitario: 200, tipoIva: 21, tipoRetencion: 0 }],
    totalDocumento: 242,
    tipoDocumento: 'factura',
    ...extra,
  });
  const contar = async (E: string) => ({
    proveedores: await prisma.supplier.count({ where: { companyId: E } }),
    facturas: await prisma.expenseInvoice.count({ where: { companyId: E } }),
    asientos: await prisma.journalEntry.count({ where: { companyId: E } }),
  });

  it('/lecturas: proveedorExistente null y, al confirmar con un proveedor nuevo, 400 sin crear nada; la lectura sigue LISTA', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(E, 'gastos-extractor');
    expect(data.gasto).toMatchObject({ nifProveedor: NIF_EMISOR, proveedorExistente: null });
    const antes = await contar(E);
    const r = await request(app(E))
      .post('/gastos-extractor/confirmar')
      .send(cuerpo({ lecturaId: data.lecturaId, revisado: true, proveedor: { nuevo: { nombreFiscal: 'IMPRENTA LEVANTE SL', nifCif: NIF_EMISOR } } }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Este proveedor no está dado de alta: IMPRENTA LEVANTE SL (B12345674). Dalo de alta o elige uno que ya tengas para poder registrar la factura.');
    expect(r.body.details).toMatchObject({ codigo: 'TERCERO_NO_DADO_DE_ALTA', tipo: 'proveedor', campo: 'proveedor', nombre: 'IMPRENTA LEVANTE SL', nif: NIF_EMISOR });
    expect(await contar(E)).toEqual(antes);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } })).toMatchObject({ estado: 'LISTA' });
  });

  it('dado de alta con POST /proveedores con lo leido: se registra con su id y sus subcuentas', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(E, 'gastos-extractor');
    const alta = await request(app(E)).post('/proveedores').send({ nombreFiscal: data.gasto.proveedor, nifCif: data.gasto.nifProveedor, pais: 'ES' });
    expect(alta.status).toBe(201);
    expect(alta.body.data.subcuenta400).toMatch(/^400\d+$/);
    expect(alta.body.data.subcuenta410).toMatch(/^410\d+$/);
    const otra = await request(app(E)).get(`/gastos-extractor/lecturas/${data.lecturaId}`);
    expect(otra.body.data.gasto.proveedorExistente).toMatchObject({ id: alta.body.data.id });
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpo({ lecturaId: data.lecturaId, revisado: true, proveedor: { id: alta.body.data.id } }));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ proveedorCreado: false, asientoEstado: 'DRAFT' });
    expect(await prisma.supplier.count({ where: { companyId: E } })).toBe(1);
  });

  it('/extraer-ia (cuerpo sin lecturaId) con un proveedor nuevo: tambien 400', async () => {
    const E = await empresa(NIF_EMPRESA);
    const r = await request(app(E))
      .post('/gastos-extractor/confirmar')
      .send(cuerpo({ proveedor: { nuevo: { nombreFiscal: 'Proveedor Nuevo SL', nifCif: cif('3333333') } }, confianza: 0.8 }));
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('TERCERO_NO_DADO_DE_ALTA');
    expect(await contar(E)).toEqual({ proveedores: 0, facturas: 0, asientos: 0 });
  });

  it('el alias antiguo provider con un proveedor nuevo: 400', async () => {
    const E = await empresa(NIF_EMPRESA);
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpo({ provider: { nuevo: { nombreFiscal: 'Otro SL', nifCif: cif('3434343') } } }));
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('TERCERO_NO_DADO_DE_ALTA');
    expect(await prisma.supplier.count({ where: { companyId: E } })).toBe(0);
  });

  it('sin proveedor: 400 con el texto general', async () => {
    const E = await empresa(NIF_EMPRESA);
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpo());
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ message: 'Antes de registrar la factura, da de alta el proveedor o elige uno que ya tengas.', details: { codigo: 'TERCERO_NO_DADO_DE_ALTA', campo: 'proveedor' } });
  });

  it('un proveedor nuevo con un NIF que ya tienes: 400 que dice cual es', async () => {
    const E = await empresa(NIF_EMPRESA);
    const s = await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Imprenta Levante SL', nifCif: NIF_EMISOR } });
    const r = await request(app(E))
      .post('/gastos-extractor/confirmar')
      .send(cuerpo({ proveedor: { nuevo: { nombreFiscal: 'IMPRENTA LEVANTE', nifCif: `ES-${NIF_EMISOR}` } } }));
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('Ya tienes dado de alta un proveedor con ese NIF: Imprenta Levante SL. Elígelo para registrar la factura.');
    expect(r.body.details).toMatchObject({ codigo: 'TERCERO_NO_DADO_DE_ALTA', existente: { id: s.id, nombreFiscal: 'Imprenta Levante SL', nifCif: NIF_EMISOR } });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E } })).toBe(0);
  });

  it('un id de otra empresa: 404 (como antes)', async () => {
    const E = await empresa(NIF_EMPRESA);
    const OTRA = await empresa(NIF_EMPRESA);
    const ajeno = await prisma.supplier.create({ data: { companyId: OTRA, nombreFiscal: 'Ajeno SL', nifCif: NIF_EMISOR } });
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpo({ proveedor: { id: ajeno.id } }));
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Altas que usara la pantalla: todo lo que lee el lector, con su subcuenta
// ---------------------------------------------------------------------------

describe('altas de terceros desde el lector', () => {
  const ficha = (nif: string) => ({
    nombreFiscal: 'Suministros Turia SL',
    nifCif: nif,
    pais: 'ES',
    direccion: 'Calle de Colón 12, 3º',
    cp: '46004',
    municipio: 'València',
    provincia: 'Valencia',
    email: 'facturas@turia.example',
    telefono: '+34 961 234 567',
  });

  it('POST /proveedores guarda nombre, NIF, pais, direccion por partes, correo y telefono, con sus subcuentas', async () => {
    const E = await empresa(NIF_EMPRESA);
    const r = await request(app(E)).post('/proveedores').send(ficha(cif('6060606')));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ ...ficha(cif('6060606')), subcuenta400: expect.stringMatching(/^400\d+$/), subcuenta410: expect.stringMatching(/^410\d+$/) });
    const s = await prisma.supplier.findUniqueOrThrow({ where: { id: r.body.data.id } });
    expect(s).toMatchObject({ ...ficha(cif('6060606')) });
    // El mismo NIF otra vez: 409 con el id del que ya existe (para enlazarlo).
    const otra = await request(app(E)).post('/proveedores').send(ficha(cif('6060606')));
    expect(otra.status).toBe(409);
    expect(otra.body.details).toMatchObject({ campo: 'nifCif', proveedorId: s.id });
  });

  it('POST /clientes guarda nombre, NIF, pais, direccion por partes, correo y telefono, con su subcuenta 430', async () => {
    const E = await empresa(NIF_EMISOR);
    const r = await request(app(E)).post('/clientes').send(ficha(cif('7070707')));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ ...ficha(cif('7070707')), subcuenta430: expect.stringMatching(/^430\d+$/) });
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: r.body.data.id } });
    expect(c).toMatchObject({ ...ficha(cif('7070707')) });
  });

  it('POST /clientes con un NIF que ya existe (aunque sea con prefijo ES): 409 con el id del cliente, no un 500', async () => {
    const E = await empresa(NIF_EMISOR);
    const ya = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Primero SL', nifCif: cif('8080808') });
    expect(ya.status).toBe(201);
    for (const nif of [cif('8080808'), `ES${cif('8080808')}`, `${cif('8080808').slice(0, 1)}-${cif('8080808').slice(1)}`]) {
      const r = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Segundo SL', nifCif: nif });
      expect(r.status).toBe(409);
      expect(r.body.message).toBe('Ya existe un cliente con ese NIF: Primero SL.');
      expect(r.body.details).toMatchObject({ campo: 'nifCif', clienteId: ya.body.data.id });
    }
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(1);
  });

  it('GET /clientes/por-nif/:nif (como el de proveedores): el cliente con ese NIF escrito de cualquier forma, o 404', async () => {
    const E = await empresa(NIF_EMISOR);
    const c = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Por NIF SL', nifCif: `ES${cif('1212121')}` } });
    for (const nif of [cif('1212121'), `ES-${cif('1212121')}`, `${cif('1212121').slice(0, 1)}.${cif('1212121').slice(1)}`]) {
      const r = await request(app(E)).get(`/clientes/por-nif/${encodeURIComponent(nif)}`);
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ id: c.id, nombreFiscal: 'Por NIF SL', subcuenta430: null });
    }
    const no = await request(app(E)).get(`/clientes/por-nif/${cif('1313131')}`);
    expect(no.status).toBe(404);
    expect(no.body.message).toBe('No hay ningún cliente con ese NIF.');
    // Otra empresa no lo ve.
    const OTRA = await empresa(NIF_EMISOR);
    expect((await request(app(OTRA)).get(`/clientes/por-nif/${cif('1212121')}`)).status).toBe(404);
  });

  it('POST /clientes sin nombre o sin NIF: 400 con el campo (antes 404)', async () => {
    const E = await empresa(NIF_EMISOR);
    const sinNombre = await request(app(E)).post('/clientes').send({ nifCif: cif('9090909') });
    expect(sinNombre.status).toBe(400);
    expect(sinNombre.body).toMatchObject({ message: 'Falta el nombre fiscal del cliente.', details: { campo: 'nombreFiscal' } });
    const sinNif = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Sin NIF SL' });
    expect(sinNif.status).toBe(400);
    expect(sinNif.body).toMatchObject({ message: 'Falta el NIF del cliente.', details: { campo: 'nifCif' } });
  });
});

// ---------------------------------------------------------------------------
// Remates de la revision
// ---------------------------------------------------------------------------

/** Lee con Azure simulado una factura de venta con el NIF del cliente cambiado. */
async function leerVentaConNifCliente(companyId: string, nif: string): Promise<Record<string, any>> {
  const p = await request(app(companyId)).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'factura.pdf');
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  const fixture = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, any> }> } }>('resultado-simple');
  fixture.analyzeResult.documents[0].fields.CustomerTaxId = { type: 'string', valueString: nif, content: nif, confidence: 0.9 };
  colaGet.push(() => respuesta(fixture, 200));
  crear.mockRejectedValue(Object.assign(new Error('x'), { status: 529 }));
  const r = await request(app(companyId)).get(`/ingresos-extractor/lecturas/${id}`);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

describe('el lector antiguo (/income-reader) no registra lo leido con el lector de ventas', () => {
  it('PUT y verify de un documento del lector de ventas: 409, sin crear el cliente ni la factura', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor');
    const documentId = data.ingreso.documentId;
    const put = await request(app(E))
      .put(`/income-reader/${documentId}`)
      .send({ nifReceptor: cif('4444444'), nombreReceptor: 'Atajo Dos SL', numero: 'A-1', fecha: '2026-09-15', lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 10, tipoIva: 21 }] });
    expect(put.status).toBe(409);
    expect(put.body.details).toMatchObject({ codigo: 'DOCUMENTO_DEL_LECTOR_DE_VENTAS' });
    const verify = await request(app(E)).post(`/income-reader/${documentId}/verify`);
    expect(verify.status).toBe(409);
    expect(verify.body.message).toMatch(/Ventas > Lector de facturas/);
    const rechazo = await request(app(E)).post(`/income-reader/${documentId}/reject`).send({ motivo: 'x' });
    expect(rechazo.status).toBe(409);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.incomeInvoice.count({ where: { companyId: E } })).toBe(0);
    expect(await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } })).toMatchObject({ status: 'READY_FOR_VERIFICATION' });
    // Y el lector de ventas sigue pidiendo el alta.
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId });
    expect(r.body.details).toMatchObject({ codigo: 'TERCERO_NO_DADO_DE_ALTA' });
  });

  it('verify de un documento suyo sin numero: 400 y el cliente no se queda creado', async () => {
    const E = await empresa(NIF_EMISOR);
    const doc = await prisma.incomeReaderDocument.create({
      data: {
        companyId: E,
        sourceType: 'WEB_UPLOAD',
        originalFileName: 'f.pdf',
        mimeType: 'application/pdf',
        fileSize: 10,
        storagePath: 'mem://nada',
        status: 'READY_FOR_VERIFICATION',
        parsedData: { nifReceptor: cif('3333333'), nombreReceptor: 'Sin Numero SL', fecha: '2026-09-15', lineas: [{ descripcion: 'x', cantidad: 1, precioUnitario: 10, tipoIva: 21 }] },
      },
    });
    const r = await request(app(E)).post(`/income-reader/${doc.id}/verify`);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Falta el número/);
    expect(await prisma.customer.count({ where: { companyId: E } })).toBe(0);
  });
});

describe('lector de ventas: NIF del cliente mal leido y cliente elegido', () => {
  it('se registra y el PDF pasa a su carpeta definitiva, sin errores en el log', async () => {
    const E = await empresa(NIF_EMISOR);
    const elegido = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Comercial Demo SL', nifCif: NIF_CLIENTE } });
    // B87654320: el digito de control no cuadra.
    const data = await leerVentaConNifCliente(E, 'B87654320');
    expect(data.ingreso.errores.some((m: string) => /dígito de control/.test(m))).toBe(true);
    const consola = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true, clienteId: elegido.id });
      expect(r.status).toBe(201);
      expect(consola.mock.calls.filter((c) => String(c[0]).includes('no se pudo archivar'))).toEqual([]);
    } finally {
      consola.mockRestore();
    }
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect(doc.status).toBe('VERIFIED');
    expect(doc.storagePath.startsWith(`mem://facturas/${E}/`)).toBe(true);
    expect(doc.storagePath).toMatch(/\/\d{4}\/Q\d\/income\//);
  });
});
