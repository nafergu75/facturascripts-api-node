/**
 * Lecturas del lector de gastos con Azure, sobre BD real y sin llamar a Azure
 * ni a Anthropic: fetch responde con los fixtures oficiales, el SDK de
 * Anthropic esta simulado y el almacenamiento es de memoria.
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
const borrados: string[] = [];
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
    borrados.push(ref);
    almacen.delete(ref);
  }),
  deleteObjects: jest.fn(async () => undefined),
  getObjectByKey: jest.fn(async () => null),
  listObjects: jest.fn(async () => []),
}));

import { createHash } from 'crypto';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import gastosRoutes from '../routes/gastos-extractor.routes';
import { _reiniciarPausa, TIEMPO_GET_MS } from '../services/lectura/azure-di.client';
import { TIEMPO_COMPLEMENTO_MS } from '../services/lectura/claude-complemento';
import { TIEMPO_CLAUDE_VISION_MS } from '../services/lectura/claude-vision.adapter';
import { purgarLecturas, RESERVA_MS } from '../services/lectura/lectura.service';
import { MOTIVO_A_PAGAR_SIN_TOTAL } from '../services/lectura/azure-factura.mapper';
import { MOTIVO_DATO_DEL_QR } from '../services/lectura/verifactu-qr';
import { aceptado, CLAVE, ENDPOINT, error, fixtureAzure, fixtureClaude, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado, RESULT_ID } from './fixtures/azure-di';

const E = `lecturas-gastos-${Date.now()}`;
const OTRA = `${E}-otra`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura de prueba');

function app(companyId = E) {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-lector', email: 'lector@test.local', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/gastos-extractor', gastosRoutes);
  a.use(errorMiddleware);
  return a;
}

// ---------------------------------------------------------------------------
// Azure simulado por metodo: colas de respuestas para POST y GET; DELETE, 204.
// ---------------------------------------------------------------------------
let fetchMock: jest.SpyInstance;
let colaPost: Array<() => Response>;
let colaGet: Array<() => Response>;
const llamadas = (metodo: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === metodo);

function conAzure(): void {
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = ENDPOINT;
  process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = CLAVE;
}
function sinAzure(): void {
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
}

beforeEach(() => {
  _reiniciarPausa();
  conAzure();
  colaPost = [];
  colaGet = [];
  crear.mockReset();
  borrados.length = 0;
  fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
    const metodo = (init as RequestInit).method;
    if (metodo === 'DELETE') return respuesta(null, 204);
    const cola = metodo === 'POST' ? colaPost : colaGet;
    const siguiente = cola.shift();
    if (!siguiente) throw new Error(`fetch ${metodo} no esperado`);
    return siguiente();
  });
});
afterEach(() => {
  fetchMock.mockRestore();
  sinAzure();
});

const subir = (a = app()) => request(a).post('/gastos-extractor/lecturas').attach('archivo', PDF, 'factura marzo.pdf');
const consultar = (id: string, a = app()) => request(a).get(`/gastos-extractor/lecturas/${id}`);
/** Que la siguiente consulta a Azure ya toque. */
const yaToca = (id: string) => prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });

/** Sube y deja la lectura terminada con el fixture de Azure indicado. */
async function leerConAzure(fixture: string): Promise<{ id: string; body: Record<string, any> }> {
  colaPost.push(() => aceptado());
  const p = await subir();
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId as string;
  await yaToca(id);
  colaGet.push(() => resultado(fixture));
  const r = await consultar(id);
  expect(r.status).toBe(200);
  return { id, body: r.body.data };
}

let supId: string;
beforeAll(async () => {
  for (const id of [E, OTRA]) {
    await prisma.company.create({ data: { id, name: `Lecturas ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Comercial Demo SL', nif: NIF_EMPRESA } });
  }
  supId = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Imprenta Levante SL', nifCif: NIF_EMISOR } })).id;
});

describe('POST y GET con Azure', () => {
  it('POST: 202 y la fila en LEYENDO con el resultId, el hash y el archivo, sin la URL de Azure', async () => {
    colaPost.push(() => aceptado());
    const r = await subir();
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ lecturaId: expect.any(String), estado: 'LEYENDO', reintentarEnMs: 2000, segundos: 0 });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: r.body.data.lecturaId } });
    expect(fila).toMatchObject({ estado: 'LEYENDO', lector: 'GASTO', azureResultId: RESULT_ID, archivoNombre: 'factura marzo.pdf', archivoTamanio: PDF.length, paginasArchivo: 1 });
    expect(fila.archivoHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fila.archivoRef).toBe(`mem://lecturas/${E}/${fila.id}-factura_marzo.pdf`);
    expect(JSON.stringify(fila)).not.toContain('cognitiveservices');
    // La clave va en la cabecera y el archivo en base64Source.
    const [url, init] = llamadas('POST')[0] as [string, RequestInit];
    expect(url).toContain('locale=es-ES');
    expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key']).toBe(CLAVE);
  });

  it('GET inmediato: LEYENDO sin llamar a Azure', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    const r = await consultar(id);
    expect(r.body.data).toMatchObject({ lecturaId: id, estado: 'LEYENDO' });
    expect(r.body.data.reintentarEnMs).toBeGreaterThan(0);
    expect(llamadas('GET')).toHaveLength(0);
  });

  it('GET cuando toca: running y luego succeeded da LISTA, con el gasto, la informacion de la lectura y el DELETE a Azure', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    await yaToca(id);
    colaGet.push(() => resultado('resultado-running'));
    const r1 = await consultar(id);
    expect(r1.body.data.estado).toBe('LEYENDO');
    expect(r1.body.data.reintentarEnMs).toBeGreaterThan(1900); // 2 s tras la primera consulta
    await yaToca(id);
    colaGet.push(() => resultado('resultado-simple'));
    const r2 = await consultar(id);
    expect(r2.body.data).toMatchObject({
      lecturaId: id,
      estado: 'LISTA',
      gasto: {
        numeroFactura: 'F2026/0012',
        nifProveedor: NIF_EMISOR,
        base: 200,
        iva: 42,
        total: 242,
        tipoIva: 21,
        tramos: [{ tipoIva: 21, base: 200, cuota: 42, descripcion: 'Folletos A5 y carteles A3' }],
        confianza: 0.91,
        errores: [],
        proveedorExistente: { id: supId, nifCif: NIF_EMISOR },
        duplicada: null,
      },
      lectura: { origen: 'AZURE', textoOrigen: 'Leída con Azure', respaldo: null, confianza: 0.91, estado: 'ok', requiereRevision: false, qr: { estado: 'SIN_QR', texto: 'Sin QR VERI*FACTU.' } },
    });
    expect(r2.body.data.lectura.campos['emisor.nif']).toMatchObject({ estado: 'ok', confianza: 0.93, fuente: 'azure' });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ origen: 'AZURE', confianza: 0.91, estadoValidacion: 'ok', qrEstado: 'SIN_QR', azureConsultas: 2, motivoRespaldo: null });
    expect(fila.avisos).toEqual([]);
    expect(llamadas('DELETE')).toHaveLength(1);
    expect(crear).not.toHaveBeenCalled(); // no hacia falta completar
    // En la fila nunca hay nada bruto de Azure.
    const guardado = JSON.stringify(fila);
    for (const bruto of ['analyzeResult', '"content"', 'polygon', 'spans', 'words', 'facturacion@']) expect(guardado).not.toContain(bruto);
  });

  it('dos GET a la vez: una sola llamada a Azure (bloqueo optimista)', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    await yaToca(id);
    colaGet.push(() => resultado('resultado-running'), () => resultado('resultado-running'));
    const [a, b] = await Promise.all([consultar(id), consultar(id)]);
    expect([a.body.data.estado, b.body.data.estado]).toEqual(['LEYENDO', 'LEYENDO']);
    expect(llamadas('GET')).toHaveLength(1);
  });

  it('mas de 45 s: respaldo con Claude con vision (AZURE_TIEMPO)', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    await prisma.lecturaDocumento.update({ where: { id }, data: { iniciadaEn: new Date(Date.now() - 50_000) } });
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    const r = await consultar(id);
    expect(r.body.data).toMatchObject({ estado: 'LISTA', gasto: { numeroFactura: 'F2026/0012', total: 242 }, lectura: { origen: 'CLAUDE', respaldo: { motivo: 'AZURE_TIEMPO', texto: 'Azure no ha respondido a tiempo; la factura se ha leído con IA.' } } });
    expect(llamadas('GET')).toHaveLength(0);
    expect(llamadas('DELETE')).toHaveLength(1);
    // Claude ha leido el archivo guardado (con vision).
    expect(crear.mock.calls[0][0].messages[0].content[0].type).toBe('document');
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } })).toMatchObject({ origen: 'CLAUDE', motivoRespaldo: 'AZURE_TIEMPO' });
  });

  it('el analisis falla en Azure: respaldo con Claude (AZURE_ANALISIS)', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    await yaToca(id);
    colaGet.push(() => resultado('resultado-failed'));
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    const r = await consultar(id);
    expect(r.body.data.lectura).toMatchObject({ origen: 'CLAUDE', respaldo: { motivo: 'AZURE_ANALISIS' } });
  });

  it('un 503 al consultar es pasajero: sigue leyendo y espera mas', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    await yaToca(id);
    colaGet.push(() => error('error-503', 503));
    const r = await consultar(id);
    expect(r.body.data.estado).toBe('LEYENDO');
    expect(crear).not.toHaveBeenCalled();
  });
});

describe('datos sacados del QR', () => {
  /** El fixture del QR que coincide, sin los campos indicados (como si Azure no los hubiera leido). */
  async function leerSin(...campos: string[]): Promise<Record<string, any>> {
    const f = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, unknown> }> } }>('resultado-qr-ok');
    for (const c of campos) delete f.analyzeResult.documents[0].fields[c];
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId as string;
    await yaToca(id);
    colaGet.push(() => respuesta(f, 200));
    const r = await consultar(id);
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('LISTA');
    return r.body.data;
  }

  it('QR que coincide y sin numero leido: el numero sale del QR, llega en completados y queda para revisar', async () => {
    const d = await leerSin('InvoiceId');
    expect(d.gasto.numeroFactura).toBe('F2026/0012');
    expect(d.lectura.qr).toMatchObject({ estado: 'COINCIDE', completados: ['numero'], diferencias: [] });
    expect(d.lectura.qr.texto).toBe('QR VERI*FACTU: el NIF, la fecha y el importe coinciden con lo leído; el número se ha tomado del QR.');
    expect(d.lectura.campos.numero).toMatchObject({ estado: 'revisar', fuente: 'qr', confianza: null, valorLeido: 'F2026/0012', motivos: [MOTIVO_DATO_DEL_QR] });
    expect(d.lectura.campos['emisor.nif']).toMatchObject({ estado: 'ok', fuente: 'qr', confianza: 1 });
    expect(d.lectura).toMatchObject({ estado: 'revisar', requiereRevision: true });
    expect(crear).not.toHaveBeenCalled();
  });

  it('sin NIF del emisor ni fecha: los dos salen del QR, para revisar', async () => {
    const d = await leerSin('VendorTaxId', 'InvoiceDate');
    expect(d.gasto).toMatchObject({ nifProveedor: NIF_EMISOR, fecha: '2026-03-04' });
    expect(d.lectura.qr).toMatchObject({ estado: 'COINCIDE', completados: ['nif', 'fecha'], diferencias: [] });
    for (const id of ['emisor.nif', 'fechaEmision']) {
      expect(d.lectura.campos[id]).toMatchObject({ estado: 'revisar', fuente: 'qr', confianza: null, motivos: [MOTIVO_DATO_DEL_QR] });
    }
    expect(d.lectura.requiereRevision).toBe(true);
  });
});

describe('sin total leido', () => {
  /** El fixture indicado, sin los campos que se quitan (como si Azure no los hubiera leido). */
  async function leerSin(fixture: string, ...campos: string[]): Promise<Record<string, any>> {
    const f = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, unknown> }> } }>(fixture);
    for (const c of campos) delete f.analyzeResult.documents[0].fields[c];
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId as string;
    await yaToca(id);
    colaGet.push(() => respuesta(f, 200));
    const r = await consultar(id);
    expect(r.status).toBe(200);
    expect(r.body.data.estado).toBe('LISTA');
    return r.body.data;
  }

  it('QR que coincide, sin InvoiceTotal ni AmountDue: el total a pagar es el total calculado con las bases y cotejado con el QR', async () => {
    const d = await leerSin('resultado-qr-ok', 'InvoiceTotal', 'AmountDue');
    expect(d.gasto).toMatchObject({ base: 200, iva: 42, total: 242, errores: [] });
    expect(d.lectura.qr).toMatchObject({ estado: 'COINCIDE', completados: [], diferencias: [] });
    expect(d.lectura.campos['totales.totalFactura']).toMatchObject({ estado: 'ok', fuente: 'qr', confianza: 1, valorLeido: 242 });
    expect(d.lectura.campos['totales.totalAPagar']).toMatchObject({ estado: 'ok', fuente: 'calculado', confianza: null, valorLeido: 242, motivos: [] });
    expect(d.lectura).toMatchObject({ estado: 'ok', requiereRevision: false });
    // El total sale de las bases: no hace falta preguntarlo a la IA.
    expect(crear).not.toHaveBeenCalled();
  });

  it('con retencion y sin ningun total impreso: el total a pagar es el total de la factura menos la retencion, calculado y para revisar', async () => {
    // La IA da la retencion, pero no los totales.
    const ia = fixtureClaude<{ content: Array<{ input: Record<string, unknown> }> }>('complemento-irpf');
    const { total_factura: _f, total_a_pagar: _p, ...input } = ia.content[0].input;
    crear.mockResolvedValueOnce({ ...ia, content: [{ ...ia.content[0], input }] });
    const d = await leerSin('resultado-irpf', 'InvoiceTotal', 'AmountDue');
    expect(crear).toHaveBeenCalledTimes(1);
    expect(d.gasto).toMatchObject({ base: 1000, iva: 210, total: 1060, errores: [] });
    expect(d.lectura.campos['totales.totalFactura']).toMatchObject({ fuente: 'calculado', valorLeido: 1210 });
    expect(d.lectura.campos['totales.totalAPagar']).toMatchObject({ estado: 'revisar', fuente: 'calculado', confianza: null, valorLeido: 1060, motivos: [MOTIVO_A_PAGAR_SIN_TOTAL] });
  });
});

describe('respaldo y cortocircuito', () => {
  it('sin variables de Azure: el POST lee con Claude en el momento (200, AZURE_NO_CONFIGURADO)', async () => {
    sinAzure();
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    const r = await subir();
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ estado: 'LISTA', lectura: { origen: 'CLAUDE', textoOrigen: 'Leída con IA (Claude)', respaldo: { motivo: 'AZURE_NO_CONFIGURADO', texto: null } } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin Azure y sin clave de Anthropic: 503 LECTOR_SIN_IA, sin guardar nada', async () => {
    sinAzure();
    const clave = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const antes = await prisma.lecturaDocumento.count({ where: { companyId: E } });
    const r = await subir();
    process.env.ANTHROPIC_API_KEY = clave;
    expect(r.status).toBe(503);
    expect(r.body.details.codigo).toBe('LECTOR_SIN_IA');
    expect(await prisma.lecturaDocumento.count({ where: { companyId: E } })).toBe(antes);
  });

  it('403 de cuota: AZURE_CUOTA; la siguiente va directa a Claude, sin llamar a Azure', async () => {
    colaPost.push(() => error('error-403-cuota', 403));
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto')).mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    const r1 = await subir();
    expect(r1.status).toBe(200);
    expect(r1.body.data.lectura.respaldo).toEqual({ motivo: 'AZURE_CUOTA', texto: 'Azure ha llegado a su límite de este mes; la factura se ha leído con IA.' });
    const r2 = await subir();
    expect(r2.body.data.lectura.respaldo.motivo).toBe('AZURE_CUOTA');
    expect(llamadas('POST')).toHaveLength(1);
  });

  it('archivo danado (400 InvalidContent) y Claude tampoco puede: 400 ARCHIVO_NO_VALIDO', async () => {
    colaPost.push(() => error('error-400-invalid-content', 400));
    crear.mockRejectedValueOnce(Object.assign(new Error('Could not process PDF'), { status: 400 }));
    const r = await subir();
    expect(r.status).toBe(400);
    expect(r.body.details.codigo).toBe('ARCHIVO_NO_VALIDO');
    // La lectura queda en ERROR sin el original: no se reintenta y la pantalla no tiene su id para descartarla.
    const fila = await prisma.lecturaDocumento.findFirstOrThrow({ where: { companyId: E, estado: 'ERROR' }, orderBy: { createdAt: 'desc' } });
    expect(fila).toMatchObject({ errorCodigo: 'ARCHIVO_NO_VALIDO', archivoRef: null });
    expect(borrados).toContain(`mem://lecturas/${E}/${fila.id}-factura_marzo.pdf`);
  });

  it('formato no admitido o mas de 4 MB: 400', async () => {
    const gif = await request(app()).post('/gastos-extractor/lecturas').attach('archivo', Buffer.from('GIF89a....'), 'f.gif');
    expect(gif.status).toBe(400);
    const grande = await request(app()).post('/gastos-extractor/lecturas').attach('archivo', Buffer.alloc(4 * 1024 * 1024 + 10, 1), 'g.pdf');
    expect(grande.status).toBe(400);
    expect(grande.body.message).toBe('El archivo pesa más de 4 MB: redúcelo o hazle una foto con menos resolución.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('tiempos', () => {
  it('la reserva de una lectura pasa de lo que puede tardar una consulta (GET a Azure mas Claude con vision o el complemento)', () => {
    const margen = 10_000;
    expect(RESERVA_MS).toBeGreaterThan(TIEMPO_GET_MS + TIEMPO_CLAUDE_VISION_MS + margen);
    expect(RESERVA_MS).toBeGreaterThan(TIEMPO_GET_MS + TIEMPO_COMPLEMENTO_MS + margen);
  });
});

describe('aislamiento', () => {
  it('una lectura de otra empresa o del lector de ventas: 404', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    const otra = await consultar(id, app(OTRA));
    expect(otra.status).toBe(404);
    expect(otra.body.message).toBe('No se encuentra esa lectura.');
    const venta = await prisma.lecturaDocumento.create({ data: { companyId: E, lector: 'VENTA', archivoNombre: 'v.pdf', archivoTipo: 'application/pdf', archivoTamanio: 1, archivoHash: 'a'.repeat(64) } });
    expect((await consultar(venta.id)).status).toBe(404);
    expect((await request(app(OTRA)).post(`/gastos-extractor/lecturas/${id}/descartar`)).status).toBe(404);
  });
});

describe('confirmar con lecturaId', () => {
  const cuerpo = (lecturaId: string, extra: Record<string, unknown> = {}) => ({
    proveedor: { id: supId },
    numeroFacturaProveedor: 'F2026/0012',
    fechaEmision: '2026-03-04',
    tipoGasto: 'SUMINISTROS',
    cuentaGasto: '629',
    lineas: [{ descripcion: 'Folletos', cantidad: 1, precioUnitario: 200, tipoIva: 21, tipoRetencion: 0 }],
    totalDocumento: 242,
    tipoDocumento: 'factura',
    lecturaId,
    ...extra,
  });

  it('sin revisado con campos marcados: 400; con revisado: factura en borrador, lectura CONFIRMADA y original archivado; otra vez: 409', async () => {
    // Confianza baja: se pide completar a Claude, que falla; queda lo de Azure, para revisar.
    crear.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 529 }));
    const { id, body } = await leerConAzure('resultado-confianza-baja');
    expect(body.lectura).toMatchObject({ origen: 'AZURE', estado: 'revisar', requiereRevision: true, confianza: 0.42 });
    expect(body.lectura.avisos).toContain('No se ha podido completar la retención, el recargo o el tipo de factura: revísalos a mano.');
    expect(body.lectura.campos.numero).toMatchObject({ estado: 'revisar', motivos: ['No se ha podido leer bien.'] });

    const sin = await request(app()).post('/gastos-extractor/confirmar').send(cuerpo(id));
    expect(sin.status).toBe(400);
    expect(sin.body).toMatchObject({ message: 'Marca que has revisado los datos señalados antes de registrar.', details: { codigo: 'FALTA_REVISION' } });

    const con = await request(app()).post('/gastos-extractor/confirmar').send(cuerpo(id, { revisado: true }));
    expect(con.status).toBe(201);
    expect(con.body.data).toMatchObject({ asientoEstado: 'DRAFT', factura: { estado: 'DRAFT', numeroFacturaProveedor: 'F2026/0012' } });
    expect(con.body.data.factura.observaciones).toBe('Leída con Azure (confianza 42 %).');
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ estado: 'CONFIRMADA', confirmadaPor: 'u-lector', revisada: true, expenseInvoiceId: con.body.data.factura.id, archivoRef: null });
    expect(fila.confirmadaEn).toBeInstanceOf(Date);
    // El original queda con la factura y se borra el de la lectura.
    const doc = await prisma.documentoArchivo.findFirstOrThrow({ where: { companyId: E, expenseInvoiceId: con.body.data.factura.id } });
    expect(doc.archivoPath).not.toBe('');
    expect(doc.archivoHash).toBe(fila.archivoHash);
    expect(borrados).toContain(`mem://lecturas/${E}/${id}-factura_marzo.pdf`);

    const otra = await request(app()).post('/gastos-extractor/confirmar').send(cuerpo(id, { revisado: true }));
    expect(otra.status).toBe(409);
    expect(otra.body.details.codigo).toBe('LECTURA_YA_CONFIRMADA');
  });

  it('se vuelve a validar lo que llega: la empresa como proveedor es error', async () => {
    const { id } = await leerConAzure('resultado-simple');
    const r = await request(app())
      .post('/gastos-extractor/confirmar')
      .send(cuerpo(id, { revisado: true, proveedor: { nuevo: { nombreFiscal: 'Yo mismo', nifCif: NIF_EMPRESA } }, numeroFacturaProveedor: 'X-1' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ message: 'Parece una factura emitida por la empresa: léela en el lector de ventas.', details: { codigo: 'VALIDACION_LECTURA', campo: 'emisor.nif' } });
  });

  it('una rectificativa no se registra aunque se marque He revisado (seria un gasto positivo)', async () => {
    crear.mockResolvedValueOnce(fixtureClaude('complemento-rectificativa'));
    const { id, body } = await leerConAzure('resultado-rectificativa');
    expect(body.lectura.estado).toBe('error');
    const r = await request(app()).post('/gastos-extractor/confirmar').send(cuerpo(id, { revisado: true, numeroFacturaProveedor: 'R-3' }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ message: 'Es una factura rectificativa (rectifica a la A-12). Todavía no se puede registrar con el lector.', details: { codigo: 'RECTIFICATIVA_NO_ADMITIDA' } });
    expect(await prisma.expenseInvoice.count({ where: { companyId: E, numeroFacturaProveedor: 'R-3' } })).toBe(0);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } })).toMatchObject({ estado: 'LISTA' });
  });

  it('una lectura que no existe: 404', async () => {
    expect((await request(app()).post('/gastos-extractor/confirmar').send(cuerpo('no-existe'))).status).toBe(404);
  });

  it('sin lecturaId: como hoy', async () => {
    const { lecturaId: _x, ...hoy } = cuerpo('x', { numeroFacturaProveedor: 'HOY-1', confianza: 0.82 });
    const r = await request(app()).post('/gastos-extractor/confirmar').send(hoy);
    expect(r.status).toBe(201);
    expect(r.body.data.factura.observaciones).toBe('Leída con el lector de gastos (confianza 82 %).');
  });
});

describe('avisos que no van ligados a un dato', () => {
  it('archivo ya registrado: el texto llega en generales y en avisos', async () => {
    const hash = createHash('sha256').update(PDF).digest('hex');
    await prisma.lecturaDocumento.create({
      data: { companyId: E, lector: 'GASTO', estado: 'CONFIRMADA', archivoNombre: 'antes.pdf', archivoTipo: 'application/pdf', archivoTamanio: PDF.length, archivoHash: hash, confirmadaEn: new Date('2026-05-02T10:00:00Z') },
    });
    const { body } = await leerConAzure('resultado-simple');
    expect(body.lectura.requiereRevision).toBe(true);
    const mensaje = expect.stringMatching(/^Este mismo archivo ya se registró el \d{2}\/\d{2}\/\d{4}\.$/);
    expect(body.lectura.generales).toEqual(expect.arrayContaining([{ nivel: 'revisar', mensaje }]));
    expect(body.lectura.avisos).toEqual(expect.arrayContaining([mensaje]));
  });
});

describe('descartar y purgar', () => {
  it('descartar: DESCARTADA y se borra el archivo', async () => {
    colaPost.push(() => aceptado());
    const id = (await subir()).body.data.lecturaId;
    const r = await request(app()).post(`/gastos-extractor/lecturas/${id}/descartar`);
    expect(r.status).toBe(200);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } })).toMatchObject({ estado: 'DESCARTADA', archivoRef: null, resultado: null });
    expect(borrados).toContain(`mem://lecturas/${E}/${id}-factura_marzo.pdf`);
    expect(llamadas('DELETE')).toHaveLength(1); // y el resultado en Azure
    expect((await consultar(id)).body.data).toEqual({ lecturaId: id, estado: 'DESCARTADA' });
  });

  it('purga: una LISTA de hace 8 dias pasa a DESCARTADA sin resultado; una CONFIRMADA de hace 91 dias conserva la pista', async () => {
    const dia = 24 * 60 * 60 * 1000;
    const base = { companyId: E, lector: 'GASTO', archivoNombre: 'v.pdf', archivoTipo: 'application/pdf', archivoTamanio: 1, archivoHash: 'b'.repeat(64) };
    const vieja = await prisma.lecturaDocumento.create({ data: { ...base, estado: 'LISTA', archivoRef: 'mem://vieja', resultado: { lectura: {} }, createdAt: new Date(Date.now() - 8 * dia) } });
    const antigua = await prisma.lecturaDocumento.create({
      data: { ...base, estado: 'CONFIRMADA', origen: 'AZURE', confianza: 0.9, qrEstado: 'COINCIDE', resultado: { lectura: {} }, confirmadaEn: new Date(Date.now() - 91 * dia), confirmadaPor: 'u' },
    });
    sinAzure();
    crear.mockResolvedValueOnce(fixtureClaude('vision-gasto'));
    await subir();
    const v = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: vieja.id } });
    expect(v).toMatchObject({ estado: 'DESCARTADA', resultado: null, archivoRef: null });
    expect(borrados).toContain('mem://vieja');
    const a = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: antigua.id } });
    expect(a).toMatchObject({ estado: 'CONFIRMADA', resultado: null, origen: 'AZURE', confianza: 0.9, qrEstado: 'COINCIDE', confirmadaPor: 'u' });
  });

  it('purga a los 90 dias: una DESCARTADA pierde tambien las validaciones y los avisos (llevan valores leidos)', async () => {
    const dia = 24 * 60 * 60 * 1000;
    const base = { companyId: E, lector: 'GASTO', archivoNombre: 'v.pdf', archivoTipo: 'application/pdf', archivoTamanio: 1, archivoHash: 'c'.repeat(64) };
    const d = await prisma.lecturaDocumento.create({
      data: { ...base, estado: 'DESCARTADA', validaciones: [{ codigo: 'NIF_EMISOR', nivel: 'error', campos: ['emisor.nif'], mensaje: 'El NIF B1 no vale' }], avisos: ['aviso con 242,00 €'] },
    });
    await prisma.$executeRaw`UPDATE LecturaDocumento SET updatedAt = ${new Date(Date.now() - 91 * dia)} WHERE id = ${d.id}`;
    await purgarLecturas(E);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ estado: 'DESCARTADA', resultado: null, validaciones: null, avisos: null });
  });

  it('purga diaria de todas las empresas (la llama /cron/carmen-purga): tambien las de una empresa que no vuelve a subir facturas', async () => {
    const dia = 24 * 60 * 60 * 1000;
    const otra = await prisma.lecturaDocumento.create({
      data: { companyId: OTRA, lector: 'GASTO', archivoNombre: 'v.pdf', archivoTipo: 'application/pdf', archivoTamanio: 1, archivoHash: 'd'.repeat(64), estado: 'LISTA', archivoRef: 'mem://otra', resultado: { lectura: {} }, createdAt: new Date(Date.now() - 8 * dia) },
    });
    expect(await purgarLecturas()).toBeGreaterThanOrEqual(1);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: otra.id } })).toMatchObject({ estado: 'DESCARTADA', resultado: null, archivoRef: null });
    expect(borrados).toContain('mem://otra');
  });
});
