/**
 * «Rellenarla a mano» (spec lector-editable, punto 3) en los dos lectores,
 * sobre BD real y sin llamar a Azure ni a Anthropic:
 *  - una lectura que falla ya no borra el archivo (salvo ARCHIVO_NO_VALIDO) y
 *    el GET dice si se puede rellenar a mano;
 *  - POST /lecturas/:id/manual desde ERROR, LEYENDO (limpia Azure) y LISTA
 *    (guarda lo leído antes); la lectura queda LISTA con origen MANUAL;
 *  - ventas: sin correcciones, FALTA_CORRECCIONES; con ellas, 201 con el
 *    archivo archivado y el AuditLog; gastos: el alta registra y archiva;
 *  - CONFIRMADA (409), DESCARTADA (400), sin archivo (409), otra empresa
 *    (404); descartar y la purga de los 7 días siguen borrando el archivo.
 *
 * Necesita MySQL.
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

import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import gastosRoutes from '../routes/gastos-extractor.routes';
import ingresosRoutes from '../routes/ingresos-extractor.routes';
import { _reiniciarPausa } from '../services/lectura/azure-di.client';
import { purgarLecturas } from '../services/lectura/lectura.service';
import { clientesService } from '../services/clientes.service';
import { aceptado, CLAVE, ENDPOINT, error, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado } from './fixtures/azure-di';

const SUFIJO = Date.now();
const E = `lector-manual-${SUFIJO}`;
const OTRA = `lector-manual-otra-${SUFIJO}`;
let nPdf = 0;
const pdf = () => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura ${SUFIJO}-${++nPdf}`);

function app(companyId = E) {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-manual', email: 'manual@test.local', roles: ['admin'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['admin'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/gastos-extractor', gastosRoutes);
  a.use('/ingresos-extractor', ingresosRoutes);
  a.use(errorMiddleware);
  return a;
}

type Lectoria = 'gastos-extractor' | 'ingresos-extractor';

let fetchMock: jest.SpyInstance;
let colaPost: Array<() => Response>;
let colaGet: Array<() => Response>;
const llamadas = (metodo: string) => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit).method === metodo);
const conAzure = () => {
  process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT = ENDPOINT;
  process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY = CLAVE;
};
const sinAzure = () => {
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  delete process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
};

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

const subir = (lector: Lectoria, companyId = E) => request(app(companyId)).post(`/${lector}/lecturas`).attach('archivo', pdf(), 'factura.pdf');
const manual = (lector: Lectoria, id: string, companyId = E) => request(app(companyId)).post(`/${lector}/lecturas/${id}/manual`);

/** Una lectura que falla: sin Azure, Claude da un error (CLAUDE_ERROR). */
async function fallida(lector: Lectoria): Promise<string> {
  sinAzure();
  crear.mockRejectedValueOnce(Object.assign(new Error('sobrecargado'), { status: 529 }));
  const r = await subir(lector);
  expect(r.status).toBe(200);
  expect(r.body.data).toMatchObject({ estado: 'ERROR', puedeRellenarAMano: true });
  return r.body.data.lecturaId as string;
}

/** Una lectura de Azure que termina con el fixture indicado. */
async function leida(lector: Lectoria, fixture = 'resultado-simple'): Promise<Record<string, any>> {
  colaPost.push(() => aceptado());
  const p = await subir(lector);
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId as string;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => resultado(fixture));
  const r = await request(app()).get(`/${lector}/lecturas/${id}`);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

let cliente = '';
let proveedor = '';
beforeAll(async () => {
  for (const id of [E, OTRA]) {
    await prisma.company.create({ data: { id, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
  }
  cliente = String((await clientesService.create(E, { nombreFiscal: 'COMERCIAL DEMO SL', nifCif: NIF_EMPRESA })).id);
  proveedor = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Papelería Sur SL', nifCif: 'B23456783' } })).id;
});

describe('una lectura que falla guarda el archivo para rellenarla a mano', () => {
  it('ERROR con el archivo y puedeRellenarAMano; el GET lo repite', async () => {
    const id = await fallida('gastos-extractor');
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ estado: 'ERROR', errorCodigo: 'CLAUDE_ERROR' });
    expect(fila.archivoRef).toBeTruthy();
    expect(almacen.has(fila.archivoRef!)).toBe(true);
    expect(borrados).toEqual([]);
    const get = await request(app()).get(`/gastos-extractor/lecturas/${id}`);
    expect(get.body.data).toMatchObject({ estado: 'ERROR', codigo: 'CLAUDE_ERROR', puedeRellenarAMano: true });
  });

  it('un archivo que no vale (ARCHIVO_NO_VALIDO) se sigue borrando y no se ofrece', async () => {
    colaPost.push(() => error('error-400-invalid-content', 400));
    crear.mockRejectedValueOnce(Object.assign(new Error('Could not process PDF'), { status: 400 }));
    const r = await subir('gastos-extractor');
    expect(r.status).toBe(400);
    const fila = await prisma.lecturaDocumento.findFirstOrThrow({ where: { companyId: E, errorCodigo: 'ARCHIVO_NO_VALIDO' }, orderBy: { createdAt: 'desc' } });
    expect(fila.archivoRef).toBeNull();
    const get = await request(app()).get(`/gastos-extractor/lecturas/${fila.id}`);
    expect(get.body.data).toMatchObject({ estado: 'ERROR', puedeRellenarAMano: false });
    const m = await manual('gastos-extractor', fila.id);
    expect(m.status).toBe(409);
    expect(m.body.details).toMatchObject({ codigo: 'ARCHIVO_YA_BORRADO' });
  });
});

describe('gastos: rellenar a mano y registrar', () => {
  it('ERROR → manual: LISTA MANUAL con el formulario vacío; el alta registra la factura y archiva el original', async () => {
    const id = await fallida('gastos-extractor');
    const m = await manual('gastos-extractor', id);
    expect(m.status).toBe(200);
    expect(m.body.data).toMatchObject({
      lecturaId: id,
      estado: 'LISTA',
      gasto: { numeroFactura: null, proveedor: null, fecha: null, base: 0, total: 0, tramos: [], errores: [], proveedorExistente: null, duplicada: null, rectificativa: null },
      lectura: { origen: 'MANUAL', textoOrigen: 'Sin leer: se rellena a mano', requiereRevision: false, estado: 'ok', qr: { estado: 'SIN_QR', texto: '' }, avisos: [] },
    });
    // Otra vez: lo mismo.
    expect((await manual('gastos-extractor', id)).body.data).toMatchObject({ estado: 'LISTA', lectura: { origen: 'MANUAL' } });
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'LECTURA_A_MANO', resourceId: id } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'LECTURA_A_MANO', resourceId: id } });
    expect(audit.meta).toMatchObject({ lecturaId: id, lector: 'GASTO', estadoAnterior: 'ERROR', errorCodigo: 'CLAUDE_ERROR' });

    // Sin «He revisado»: una rellenada a mano no lo pide.
    const r = await request(app())
      .post('/gastos-extractor/confirmar')
      .send({
        proveedor: { id: proveedor },
        numeroFacturaProveedor: 'PS-2026-15',
        fechaEmision: '2026-03-10',
        tipoGasto: 'SUMINISTROS',
        cuentaGasto: '629',
        lineas: [{ descripcion: 'Papel', cantidad: 1, precioUnitario: 100, tipoIva: 21, tipoRetencion: 0 }],
        totalDocumento: 121,
        tipoDocumento: 'factura',
        lecturaId: id,
      });
    expect(r.status).toBe(201);
    expect(r.body.data.factura.observaciones).toBe('Registrada a mano con el archivo subido al lector.');
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    expect(fila).toMatchObject({ estado: 'CONFIRMADA', expenseInvoiceId: r.body.data.factura.id, archivoRef: null });
    const archivado = await prisma.documentoArchivo.findFirstOrThrow({ where: { companyId: E, expenseInvoiceId: r.body.data.factura.id } });
    expect(archivado.archivoHash).toBe(fila.archivoHash);
    // Ya registrada: 409.
    const otra = await manual('gastos-extractor', id);
    expect(otra.status).toBe(409);
    expect(otra.body.details).toMatchObject({ codigo: 'LECTURA_YA_CONFIRMADA' });
  });

  it('LEYENDO → manual: limpia Azure y la consulta siguiente ya no llama a Azure', async () => {
    colaPost.push(() => aceptado());
    const p = await subir('gastos-extractor');
    expect(p.body.data.estado).toBe('LEYENDO');
    const id = p.body.data.lecturaId as string;
    const m = await manual('gastos-extractor', id);
    expect(m.body.data).toMatchObject({ estado: 'LISTA', lectura: { origen: 'MANUAL' } });
    expect(llamadas('DELETE')).toHaveLength(1);
    await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
    const get = await request(app()).get(`/gastos-extractor/lecturas/${id}`);
    expect(get.body.data).toMatchObject({ estado: 'LISTA', lectura: { origen: 'MANUAL' } });
    expect(llamadas('GET')).toHaveLength(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'LECTURA_A_MANO', resourceId: id } });
    expect(audit.meta).toMatchObject({ estadoAnterior: 'LEYENDO' });
  });
});

describe('ventas: rellenar a mano y registrar con las correcciones', () => {
  it('ERROR → manual: sin correcciones, FALTA_CORRECCIONES; incompleta, el campo que falta; completa, 201 con el archivo archivado y el AuditLog', async () => {
    const id = await fallida('ingresos-extractor');
    const m = await manual('ingresos-extractor', id);
    expect(m.status).toBe(200);
    expect(m.body.data).toMatchObject({
      estado: 'LISTA',
      ingreso: { numeroFactura: null, cliente: null, lineas: [], errores: [], clienteExistente: null, rectificativa: null },
      lectura: { origen: 'MANUAL', requiereRevision: false, qr: { estado: 'SIN_QR', texto: '' } },
    });
    const documentId = m.body.data.ingreso.documentId as string;
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    expect(doc).toMatchObject({ status: 'READY_FOR_VERIFICATION', storagePath: fila.archivoRef });

    const confirmar = (cuerpo: Record<string, unknown>) => request(app()).post('/ingresos-extractor/confirmar').send({ documentId, clienteId: cliente, ...cuerpo });
    const sin = await confirmar({});
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ codigo: 'FALTA_CORRECCIONES', campo: 'correcciones' });
    const incompleta = await confirmar({ correcciones: { numero: 'M-2026-1' } });
    expect(incompleta.status).toBe(400);
    expect(incompleta.body.details).toMatchObject({ codigo: 'FALTA_CORRECCIONES', campo: 'correcciones.fechaEmision' });

    const r = await confirmar({
      correcciones: { numero: 'M-2026-1', fechaEmision: '2026-04-02', concepto: 'Carteles', lineas: [{ descripcion: '', base: 100, tipoIva: 21 }], total: 121 },
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'M-2026-1', total: 121, corregida: true, aMano: true, asientoEnBorrador: true });
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
    expect(f).toMatchObject({ origen: 'lector', customerId: cliente, observaciones: 'Registrada a mano desde factura.pdf. Concepto: Carteles.' });
    // Sin descripción, el concepto.
    expect(f.lineas.map((l) => l.descripcion)).toEqual(['Carteles']);
    const archivada = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } });
    expect(archivada.status).toBe('VERIFIED');
    // El archivo va con el nombre del cliente de la ficha (no se leyó nada).
    expect(archivada.storagePath).toMatch(/\/2026\/Q2\/income\/2026-04-02_INVOICE_M-2026-1_COMERCIAL-DEMO-SL\.pdf$/);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } })).toMatchObject({ estado: 'CONFIRMADA', incomeInvoiceId: f.id, archivoRef: null });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'LECTOR_VENTA_CORREGIDA', resourceId: f.id } });
    expect(audit.meta).toMatchObject({ manual: true, lecturaId: id, cambios: expect.arrayContaining([{ campo: 'numero', leido: null, puesto: 'M-2026-1' }]) });
  });

  it('LISTA → manual: guarda lo leído antes y vacía el documento del lector; al registrarla, lo leído va al AuditLog', async () => {
    const data = await leida('ingresos-extractor');
    const m = await manual('ingresos-extractor', data.lecturaId);
    expect(m.body.data).toMatchObject({ estado: 'LISTA', ingreso: { documentId: data.ingreso.documentId, lineas: [], errores: [] }, lectura: { origen: 'MANUAL' } });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect((fila.resultado as { leidaAntes?: { numero: { valor: string } } }).leidaAntes?.numero.valor).toBe('F2026/0012');
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect((doc.parsedData as { amounts: { bases: unknown[] }; invoice: { number: string | null } }).invoice.number).toBeNull();
    expect((doc.parsedData as { amounts: { bases: unknown[] } }).amounts.bases).toEqual([]);

    // La purga de 90 días vacía el resultado de las confirmadas: lo leído antes queda en el AuditLog.
    const r = await request(app())
      .post('/ingresos-extractor/confirmar')
      .send({
        documentId: data.ingreso.documentId,
        clienteId: cliente,
        correcciones: { numero: 'M-2026-2', fechaEmision: '2026-03-04', lineas: [{ descripcion: 'Folletos', base: 200, tipoIva: 21 }], total: 242 },
      });
    expect(r.status).toBe(201);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'LECTOR_VENTA_CORREGIDA', resourceId: r.body.data.facturaId } });
    const cambios = (audit.meta as { manual: boolean; cambios: Array<{ campo: string }> }).cambios;
    expect(cambios).toEqual(
      expect.arrayContaining([{ campo: 'numero', leido: 'F2026/0012', puesto: 'M-2026-2' }, expect.objectContaining({ campo: 'lineas', leido: [{ tipoIva: 21, base: 200, cuota: 42 }] })]),
    );
    // La fecha y el total son los leídos: no cuentan como cambio.
    expect(cambios.map((c) => c.campo)).not.toEqual(expect.arrayContaining(['fechaEmision']));
    expect(cambios.map((c) => c.campo)).not.toContain('total');
  });

  it('«¿De dónde es el cliente?» en una rellenada a mano solo guarda la elección; un cliente de fuera de la UE sin NIF leído se registra', async () => {
    const id = await fallida('ingresos-extractor');
    const m = await manual('ingresos-extractor', id);
    const origen = await request(app()).post(`/ingresos-extractor/lecturas/${id}/origen-tercero`).send({ origen: 'FUERA', pais: 'DO' });
    expect(origen.status).toBe(200);
    expect(origen.body.data).toMatchObject({ estado: 'LISTA', lectura: { origen: 'MANUAL', estado: 'ok', tercero: { origen: 'FUERA', pais: 'DO' } } });
    const caribe = await clientesService.create(E, { nombreFiscal: 'Distribuidora Caribe SRL', nifCif: '1-31-12345-6', pais: 'DO' });
    const r = await request(app())
      .post('/ingresos-extractor/confirmar')
      .send({
        documentId: m.body.data.ingreso.documentId,
        clienteId: String(caribe.id),
        correcciones: { numero: 'EXP-7', fechaEmision: '2026-04-03', lineas: [{ descripcion: 'Servicio de diseño', base: 500, tipoIva: 0 }], total: 500 },
      });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ aMano: true, total: 500 });
  });
});

describe('lo que no se puede rellenar a mano', () => {
  it('DESCARTADA: 400; de otra empresa: 404; descartar después borra el archivo', async () => {
    const id = await fallida('gastos-extractor');
    expect((await manual('gastos-extractor', id, OTRA)).status).toBe(404);
    expect((await manual('ingresos-extractor', id)).status).toBe(404);
    await manual('gastos-extractor', id);
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    const d = await request(app()).post(`/gastos-extractor/lecturas/${id}/descartar`);
    expect(d.status).toBe(200);
    expect(borrados).toContain(fila.archivoRef);
    const m = await manual('gastos-extractor', id);
    expect(m.status).toBe(400);
    expect(m.body.details).toMatchObject({ codigo: 'LECTURA_NO_LISTA' });
  });

  it('la purga de los 7 días descarta la lectura en ERROR y borra su archivo', async () => {
    const id = await fallida('gastos-extractor');
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } });
    await prisma.lecturaDocumento.update({ where: { id }, data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });
    await purgarLecturas(E);
    expect(await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id } })).toMatchObject({ estado: 'DESCARTADA', archivoRef: null });
    expect(borrados).toContain(fila.archivoRef);
  });
});
