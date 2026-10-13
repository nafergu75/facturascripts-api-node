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
import { aceptado, CLAVE, ENDPOINT, fixtureAzure, fixtureClaude, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado } from './fixtures/azure-di';
import { clientesService } from '../services/clientes.service';

/** El cliente de los fixtures, dado de alta: el lector ya no lo crea al registrar (lector-tercero-alta.db.test). */
const altaCliente = (companyId: string) => clientesService.create(companyId, { nombreFiscal: 'COMERCIAL DEMO SL', nifCif: NIF_EMPRESA });

const E = `lecturas-ventas-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura emitida');

function app(companyId = E) {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-ventas', email: 'ventas@test.local', roles: ['ventas'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['ventas'] } } as never;
    req.companyId = companyId;
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

/** fixture: el nombre de uno de los de Azure, o su contenido ya cambiado. */
async function leer(fixture: string | Record<string, unknown>, companyId = E): Promise<Record<string, any>> {
  const p = await request(app(companyId)).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'emitida.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => (typeof fixture === 'string' ? resultado(fixture) : respuesta(fixture, 200)));
  const r = await request(app(companyId)).get(`/ingresos-extractor/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  // En ventas la empresa es la emisora de los fixtures.
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
  await altaCliente(E);
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

  it('el ingreso trae la direccion del cliente separada (direccionCliente) para darlo de alta con la ficha rellena', async () => {
    // Sin direccion del cliente en la factura: null.
    expect((await leer('resultado-simple')).ingreso.direccionCliente).toBeNull();

    const conDireccion = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, unknown> }> } }>('resultado-simple');
    conDireccion.analyzeResult.documents[0].fields.CustomerAddress = {
      type: 'address',
      valueAddress: { road: 'Avenida del Puerto', houseNumber: '3', postalCode: '46021', city: 'Valencia', state: 'Valencia', countryRegion: 'ESP' },
      content: 'Avenida del Puerto 3, 46021 Valencia',
      confidence: 0.9,
      boundingRegions: [{ pageNumber: 1 }],
    };
    const data = await leer(conDireccion);
    const esperada = { calle: 'Avenida del Puerto 3', cp: '46021', municipio: 'Valencia', provincia: 'Valencia', pais: 'ES', revisar: false };
    expect(data.ingreso.direccionCliente).toEqual(esperada);
    // Junto a lo de siempre: el cliente, su NIF y si ya esta dado de alta.
    expect(data.ingreso).toMatchObject({ cliente: 'COMERCIAL DEMO SL', nifCliente: 'B87654323', clienteExistente: expect.objectContaining({ nifCif: 'B87654323' }) });
    // Y al volver a pedir la lectura (GET /lecturas/:id), igual.
    const otra = await request(app()).get(`/ingresos-extractor/lecturas/${data.lecturaId}`);
    expect(otra.body.data.ingreso.direccionCliente).toEqual(esperada);
    // El documento del lector guarda la calle del cliente.
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect((doc.parsedData as { customer: { address: string | null } }).customer.address).toBe('Avenida del Puerto 3');
  });

  it('/ingresos-extractor/confirmar crea la factura y deja la lectura CONFIRMADA con incomeInvoiceId', async () => {
    const data = await leer('resultado-simple');
    const r = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(201);
    // El numero, tal como se expidio (con sus ceros y su separador); serie y numero, para la unicidad.
    expect(r.body.data).toMatchObject({ numeroCompleto: 'F2026/0012', total: 242 });
    expect(await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } })).toMatchObject({ serie: 'F2026', numero: 12, numeroCompleto: 'F2026/0012' });
    // Y asi va al libro registro de facturas expedidas (con el asiento).
    const libro = await prisma.vATBook.findFirstOrThrow({ where: { companyId: E, asientoId: r.body.data.asientoId } });
    expect(libro.numeroFactura).toBe('F2026/0012');
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect(fila).toMatchObject({ estado: 'CONFIRMADA', incomeInvoiceId: r.body.data.facturaId, confirmadaPor: 'u-ventas' });
    // La misma factura otra vez: la lectura nueva ya la marca como duplicada (error).
    const otra = await leer('resultado-simple');
    expect(otra.lectura.estado).toBe('error');
    expect(otra.ingreso.errores).toContain('Ya registraste esta factura (F2026/0012).');
  });

  it('«Cambiar cuenta»: el confirmar lleva la cuenta de cada linea y solo toma eso del cuerpo', async () => {
    // Otra empresa: el numero del fixture ya esta registrado en la de los demas casos.
    const E2 = `${E}-cuentas`;
    await prisma.company.create({ data: { id: E2, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: E2, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
    await altaCliente(E2);
    const confirmar = (cuerpo: Record<string, unknown>) => request(app(E2)).post('/ingresos-extractor/confirmar').send(cuerpo);
    const data = await leer('resultado-iva-multiple', E2);
    // Una linea por tipo de IVA, en el orden en que se registraran.
    // Cada una con las partidas de su tipo (antes las dos llevaban «Folletos A5»).
    expect(data.ingreso.lineas.map((l: { descripcion: string; base: number; tipoIva: number }) => [l.descripcion, l.base, l.tipoIva])).toEqual([
      ['Folletos A5 y carteles A3', 200, 21],
      ['Libros', 50, 10],
    ]);
    // Mas cuentas que lineas, o una que no es de ventas: 400 sin registrar nada.
    const demas = await confirmar({ documentId: data.ingreso.documentId, revisado: true, lineas: [{}, {}, { cuenta: '705' }] });
    expect(demas.status).toBe(400);
    expect(demas.body.details).toMatchObject({ campo: 'lineas' });
    const mala = await confirmar({ documentId: data.ingreso.documentId, revisado: true, lineas: [{ cuenta: '600' }] });
    expect(mala.status).toBe(400);
    expect(mala.body.details).toMatchObject({ campo: 'lineas.0.cuenta' });
    expect(mala.body.message).toMatch(/600 no es de ventas/);
    // La segunda linea a la 705; la primera, sin cuenta, va a la de por defecto. El precio del cuerpo se ignora.
    const r = await confirmar({ documentId: data.ingreso.documentId, revisado: true, lineas: [{ cuenta: null, precioUnitario: 1 }, { cuenta: '705' }] });
    expect(r.status).toBe(201);
    expect(r.body.data.total).toBe(297);
    const lineas = await prisma.incomeInvoiceLine.findMany({ where: { invoiceId: r.body.data.facturaId }, orderBy: { tipoIva: 'desc' } });
    expect(lineas.map((l) => [l.descripcion, Number(l.precioUnitario), l.tipoIva, l.accountCode ?? null])).toEqual([
      ['Folletos A5 y carteles A3', 200, 21, null],
      ['Libros', 50, 10, '705'],
    ]);
    // Con su asiento, en borrador (viene del lector): 430N del cliente, 700, 705 (la elegida) y 477.
    expect(r.body.data).toMatchObject({ contabilizada: true, asientoEnBorrador: true });
    const asiento = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: E2, invoiceId: r.body.data.facturaId }, include: { lineas: true } });
    expect(asiento.id).toBe(r.body.data.asientoId);
    expect(asiento.estado).toBe('DRAFT');
    const cliente = await prisma.customer.findFirstOrThrow({ where: { companyId: E2 } });
    expect(cliente.subcuenta430).toMatch(/^430\d+$/);
    const porCuenta = Object.fromEntries(asiento.lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]));
    expect(porCuenta).toEqual({ [cliente.subcuenta430!]: [297, 0], '700': [0, 200], '705': [0, 50], '477': [0, 47] });
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

  it('sin Azure ni clave de Anthropic: 503 con el texto y el alta a mano de ventas', async () => {
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    const clave = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const r = await request(app()).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'emitida.pdf');
      expect(r.status).toBe(503);
      expect(r.body.message).toBe('La lectura con IA no está activada en esta instalación. Crea la factura con Ventas → Nueva factura.');
      expect(r.body.details).toMatchObject({ codigo: 'LECTOR_SIN_IA', alternativa: '/dashboard/facturas/nueva' });
    } finally {
      process.env.ANTHROPIC_API_KEY = clave;
    }
  });

  it('una lectura con algo marcado necesita revisado al confirmar', async () => {
    const data = await leer('resultado-confianza-baja');
    expect(data.lectura.requiereRevision).toBe(true);
    const r = await request(app()).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('FALTA_REVISION');
  });
});

describe('sin total leido', () => {
  // Otra empresa, para que la factura no salga repetida con las de arriba.
  const SIN_TOTAL = `${E}-sin-total`;
  beforeAll(async () => {
    await prisma.company.create({ data: { id: SIN_TOTAL, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: SIN_TOTAL, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
    await altaCliente(SIN_TOTAL);
  });

  it('QR que coincide, sin InvoiceTotal ni AmountDue: el total es el calculado y cotejado, y la factura se registra', async () => {
    const f = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, unknown> }> } }>('resultado-qr-ok');
    delete f.analyzeResult.documents[0].fields.InvoiceTotal;
    delete f.analyzeResult.documents[0].fields.AmountDue;
    const a = app(SIN_TOTAL);
    const p = await request(a).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'emitida.pdf');
    expect(p.status).toBe(202);
    const id = p.body.data.lecturaId;
    await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
    colaGet.push(() => respuesta(f, 200));
    const r = await request(a).get(`/ingresos-extractor/lecturas/${id}`);
    expect(r.status).toBe(200);
    const data = r.body.data;
    expect(data.ingreso).toMatchObject({ base: 200, iva: 42, total: 242, errores: [] });
    expect(data.lectura.qr).toMatchObject({ estado: 'COINCIDE', completados: [], diferencias: [] });
    expect(data.lectura.campos['totales.totalAPagar']).toMatchObject({ estado: 'ok', fuente: 'calculado', valorLeido: 242, motivos: [] });
    expect(data.lectura).toMatchObject({ estado: 'ok', requiereRevision: false });
    expect(crear).not.toHaveBeenCalled();
    const c = await request(a).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ total: 242 });
  });
});

describe('empresa sin NIF (fallo del 13-10)', () => {
  // resultado-simple: emisor IMPRENTA LEVANTE SL y cliente COMERCIAL DEMO SL.
  const RECEPTORA = `${E}-sin-nif-receptora`;
  const EMISORA = `${E}-sin-nif-emisora`;
  const OTRA = `${E}-sin-nif-otra`;
  beforeAll(async () => {
    await prisma.company.create({ data: { id: RECEPTORA, name: 'Comercial Demo SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: RECEPTORA } });
    await prisma.company.create({ data: { id: EMISORA, name: 'Otro nombre', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: EMISORA, denominacion: 'Imprenta Levante, S.L.' } });
    await altaCliente(EMISORA);
    // Sin datos de la empresa: solo el nombre de Company.
    await prisma.company.create({ data: { id: OTRA, name: 'Ifeval Sport SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  });
  const SIN_NIF =
    'Tu empresa no tiene el NIF en Más > Datos de la empresa: no se puede comprobar que esta factura la haya emitido ella. Ponlo para que el lector lo compruebe.';
  const empresa = async (lecturaId: string) => {
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: lecturaId } });
    return ((fila.validaciones ?? []) as Array<{ codigo: string; nivel: string; mensaje: string }>).filter((x) => x.codigo === 'EMPRESA');
  };

  it('con el nombre del cliente: error («léela en el lector de gastos») y no se puede registrar', async () => {
    const data = await leer('resultado-simple', RECEPTORA);
    expect(data.lectura.estado).toBe('error');
    expect(data.ingreso.errores).toContain(
      'Parece una factura recibida por la empresa: léela en el lector de gastos. Lo hemos deducido por el nombre porque tu empresa no tiene el NIF puesto; si no es así, ponlo en Más > Datos de la empresa y vuelve a leerla.',
    );
    const r = await request(app(RECEPTORA)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('Parece una factura recibida por la empresa: léela en el lector de gastos.');
  });

  it('con el nombre del emisor: revisar pidiendo el NIF, y se registra marcando «He revisado»', async () => {
    const data = await leer('resultado-simple', EMISORA);
    expect(data.lectura).toMatchObject({ estado: 'revisar', requiereRevision: true });
    expect(data.ingreso.errores).toEqual([]);
    expect(await empresa(data.lecturaId)).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: SIN_NIF })]);
    const sin = await request(app(EMISORA)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId });
    expect(sin.status).toBe(400);
    expect(sin.body.details.codigo).toBe('FALTA_REVISION');
    const con = await request(app(EMISORA)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true });
    expect(con.status).toBe(201);
  });

  it('sin coincidencias: revisar, con el nombre del emisor leído', async () => {
    const data = await leer('resultado-simple', OTRA);
    expect(data.lectura.estado).not.toBe('ok');
    expect(await empresa(data.lecturaId)).toEqual([
      expect.objectContaining({ nivel: 'revisar', mensaje: `${SIN_NIF} El emisor que se ha leído es «IMPRENTA LEVANTE SL», que no se parece al nombre de tu empresa.` }),
    ]);
  });
});
