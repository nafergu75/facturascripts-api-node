/**
 * Lector de ventas con rectificativas y abonos (sección «Lector de ventas» de
 * la especificación de rectificativas de venta), sobre BD real y sin llamar a
 * Azure ni a Anthropic:
 *  - V19/V20 para revisar: la lectura propone la factura que rectifica por el
 *    número leído, en toda la empresa, con su cliente;
 *  - importes en negativo: por diferencias, sin preguntar el signo;
 *  - importes en positivo: hay que decir el signo (FALTA_SIGNO) o que es una
 *    sustitución (con la original en la app, o con sus importes si no está);
 *  - partidas de 2026 del cliente, cliente distinto, duplicado, serie de la
 *    app (409), «No es una rectificativa» y lecturas de antes con V19 en error;
 *  - el asiento queda en borrador contra la 430N del cliente de la original.
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
import { aceptado, CLAVE, ENDPOINT, fixtureClaude, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado } from './fixtures/azure-di';
import { clientesService } from '../services/clientes.service';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import * as redSeguridad from '../services/verifactu/redSeguridad';

const SUFIJO = Date.now();
const E = `lector-rect-${SUFIJO}`;
const SIN_ORIGINAL = `lector-rect-sin-${SUFIJO}`;
const OTRO = `lector-rect-otro-${SUFIJO}`;
const RED = `lector-rect-red-${SUFIJO}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura rectificativa');
const clientes: Record<string, string> = {};
const originales: Record<string, string> = {};

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

/** Lee una rectificativa (Azure con el fixture y el complemento de Claude con «rectifica a la A-12»). */
async function leer(fixture: string, companyId = E): Promise<Record<string, any>> {
  crear.mockResolvedValueOnce(fixtureClaude('complemento-rectificativa'));
  const p = await request(app(companyId)).post('/ingresos-extractor/lecturas').attach('archivo', PDF, 'rectificativa.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => resultado(fixture));
  const r = await request(app(companyId)).get(`/ingresos-extractor/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

/** Cambia el número leído guardado (para no chocar con la serie R de la app ni repetir número). */
async function conNumero(documentId: string, numero: string) {
  const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } });
  const parsed = doc.parsedData as Record<string, any>;
  await prisma.incomeReaderDocument.update({ where: { id: documentId }, data: { parsedData: { ...parsed, invoice: { ...parsed.invoice, number: numero } } } });
}

/** Cambia los importes leídos guardados (por ejemplo, para que la factura lleve IRPF). */
async function conImportes(documentId: string, amounts: Record<string, unknown>) {
  const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } });
  const parsed = doc.parsedData as Record<string, any>;
  await prisma.incomeReaderDocument.update({ where: { id: documentId }, data: { parsedData: { ...parsed, amounts: { ...parsed.amounts, ...amounts } } } });
}

const confirmar = (companyId: string, cuerpo: Record<string, unknown>) => request(app(companyId)).post('/ingresos-extractor/confirmar').send({ revisado: true, ...cuerpo });

/** Empresa emisora de los fixtures, con el cliente leído y, si se pide, su A-12 de la app. */
async function empresa(id: string, opciones: { original?: 'del-cliente' | 'de-otro' } = {}) {
  await prisma.company.create({ data: { id, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
  await prisma.ajustesFiscales.create({ data: { companyId: id, inicioEnApp: '2026-01-01' } });
  clientes[id] = String((await clientesService.create(id, { nombreFiscal: 'COMERCIAL DEMO SL', nifCif: NIF_EMPRESA })).id);
  if (!opciones.original) return;
  const otro = opciones.original === 'de-otro' ? String((await clientesService.create(id, { nombreFiscal: 'OTRA EMPRESA SL', nifCif: 'B46123456' })).id) : clientes[id];
  await listarSeries(id);
  await prisma.invoiceSeries.update({ where: { companyId_codigo: { companyId: id, codigo: 'A' } }, data: { ultimoNumero: 11 } });
  const a12 = await incomeInvoicesService.crearIngreso({
    companyId: id,
    customer: { id: otro },
    fechaEmision: '2026-03-01',
    lineas: [{ descripcion: 'Folletos', cantidad: 1, precioUnitario: 500, tipoIva: 21, cuenta: '705' }],
  } as CrearFacturaIngresoDTO);
  expect(a12.numeroCompleto).toBe('A-12');
  originales[id] = a12.id;
}

beforeAll(async () => {
  await empresa(E, { original: 'del-cliente' });
  await empresa(SIN_ORIGINAL);
  await empresa(OTRO, { original: 'de-otro' });
  await empresa(RED, { original: 'del-cliente' });
});

describe('lector de ventas: abono en negativo con la original en la app', () => {
  it('la lectura no bloquea y propone la A-12 (exacta), su cliente, el motivo y por diferencias', async () => {
    const data = await leer('resultado-rectificativa-venta');
    expect(data.ingreso.errores).toEqual([]);
    expect(data.lectura.requiereRevision).toBe(true);
    expect(data.ingreso.rectificativa).toMatchObject({
      numeroRectificada: 'A-12',
      motivoLeido: 'Devolución de mercancía',
      motivoPropuesto: 'DEVOLUCION',
      importesNegativos: true,
      pideSigno: false,
      formaPropuesta: 'I',
      propuesta: { coincidencia: 'EXACTA', original: { id: originales[E], numeroCompleto: 'A-12', exacta: true } },
      clienteDeLaOriginal: { id: clientes[E], nombreFiscal: 'COMERCIAL DEMO SL' },
      clienteDistinto: false,
    });
  });

  it('sin decir qué rectifica: 400 FALTA_RECTIFICATIVA; «No es una rectificativa» con negativos: 400', async () => {
    const data = await leer('resultado-rectificativa-venta');
    const sin = await confirmar(E, { documentId: data.ingreso.documentId });
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ codigo: 'FALTA_RECTIFICATIVA', campo: 'rectificativa' });
    const no = await confirmar(E, { documentId: data.ingreso.documentId, noEsRectificativa: true });
    expect(no.status).toBe(400);
    expect(no.body.details).toMatchObject({ codigo: 'NO_ES_RECTIFICATIVA_CON_NEGATIVOS' });
  });

  it('con el bloque: rectificativa R1 con su número leído, la cuenta de la original, explicación leída y asiento en borrador contra la 430N', async () => {
    const data = await leer('resultado-rectificativa-venta');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[E] }] } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'RV-4', total: -242, esRectificativa: true, contabilizada: true, asientoEnBorrador: true });
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
    expect(f).toMatchObject({ origen: 'lector', tipoFactura: 'R1', tipoRectificativa: 'I', causaRectificacion: 'DEVOLUCION', motivoRectificacion: 'Devolución de mercancía', facturaOriginalId: originales[E], customerId: clientes[E] });
    expect(f.lineas.map((l) => [Number(l.baseLine), l.accountCode])).toEqual([[-200, '705']]);
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asientoId }, include: { lineas: true } });
    expect(asiento.estado).toBe('DRAFT');
    const cliente = await prisma.customer.findUniqueOrThrow({ where: { id: clientes[E] } });
    expect(asiento.lineas.find((l) => l.accountCode.startsWith('43'))).toMatchObject({ accountCode: cliente.subcuenta430, debe: -242 });
    // Otra lectura con el mismo número: duplicado.
    const otra = await leer('resultado-rectificativa-venta');
    const dup = await confirmar(E, { documentId: otra.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[E] }] } });
    expect(dup.status).toBe(400);
    // La lectura ya lo ve repetido (V14) y, si no, el alta (la factura RV-4 ya existe).
    expect(dup.body.message).toMatch(/RV-4/);
  });
});

describe('lector de ventas: rectificativa en positivo', () => {
  it('pide decir el signo; con «Restan» se registra en negativo', async () => {
    const data = await leer('resultado-rectificativa');
    expect(data.ingreso.rectificativa).toMatchObject({ importesNegativos: false, pideSigno: true, formaPropuesta: null });
    await conNumero(data.ingreso.documentId, 'RV-5');
    const sinSigno = await confirmar(E, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[E] }] } });
    expect(sinSigno.status).toBe(400);
    expect(sinSigno.body.details).toMatchObject({ codigo: 'FALTA_SIGNO', campo: 'rectificativa.cambiarSigno' });
    const ok = await confirmar(E, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', cambiarSigno: true, originales: [{ id: originales[E] }] } });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ total: -242, esRectificativa: true });
  });

  it('con el número de la serie R de la app: 409, como cualquier serie de la app', async () => {
    const data = await leer('resultado-rectificativa');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', cambiarSigno: true, originales: [{ id: originales[E] }] } });
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ campo: 'serie' });
  });

  it('por sustitución con la original en la app: la factura corregida entera', async () => {
    const data = await leer('resultado-rectificativa');
    await conNumero(data.ingreso.documentId, 'RV-6');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, rectificativa: { forma: 'S', motivo: 'ERROR', explicacion: 'Precio corregido', originales: [{ id: originales[E] }] } });
    // La A-12 ya tiene rectificativas: una sustitución ya no cabe.
    expect(r.status).toBe(409);
    expect(r.body.details).toMatchObject({ codigo: 'SUSTITUCION_CON_RECTIFICATIVAS' });
  });

  it('«No es una rectificativa» con importes en positivo: se registra como factura y queda en AuditLog', async () => {
    const data = await leer('resultado-rectificativa');
    await conNumero(data.ingreso.documentId, 'FV-9');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, noEsRectificativa: true });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ esRectificativa: false, total: 242 });
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'LECTOR_VENTA_NO_ES_RECTIFICATIVA', resourceId: r.body.data.facturaId } })).toBe(1);
  });
});

describe('lector de ventas: sin la original en la app', () => {
  it('ofrece la partida de 2026 del cliente; por sustitución pide los importes de la original y guarda la diferencia', async () => {
    const p = await prisma.partidaPendiente.create({
      data: { companyId: SIN_ORIGINAL, cargaId: 'carga-x', tipo: 'COBRO', subcuenta: '4300000001', customerId: clientes[SIN_ORIGINAL], numeroDocumento: 'A-12', fechaDocumento: '2025-12-01', importePendiente: 605 },
    });
    const data = await leer('resultado-rectificativa', SIN_ORIGINAL);
    expect(data.ingreso.rectificativa).toMatchObject({ propuesta: { coincidencia: 'NINGUNA', original: null }, clienteDeLaOriginal: null });
    expect(data.ingreso.rectificativa.partidasFuera).toEqual([expect.objectContaining({ partidaId: p.id, numero: 'A-12', exacta: true, pendiente: 605 })]);
    await conNumero(data.ingreso.documentId, 'RV-7');
    const bloque = { forma: 'S', motivo: 'DESCUENTO', explicacion: 'Descuento acordado', originales: [{ partidaId: p.id }] };
    const sinImportes = await confirmar(SIN_ORIGINAL, { documentId: data.ingreso.documentId, rectificativa: bloque });
    expect(sinImportes.status).toBe(400);
    expect(sinImportes.body.details).toMatchObject({ codigo: 'FALTA_IMPORTES_ORIGINALES', campo: 'rectificativa.importesOriginales' });
    const r = await confirmar(SIN_ORIGINAL, { documentId: data.ingreso.documentId, rectificativa: { ...bloque, importesOriginales: [{ tipoIva: 21, base: 250, cuota: 52.5 }] } });
    expect(r.status).toBe(201);
    // Corregida 200 + 42 menos original 250 + 52,50: la diferencia.
    expect(r.body.data).toMatchObject({ total: -60.5, esRectificativa: true });
    const enlace = await prisma.incomeInvoiceRectificada.findFirstOrThrow({ where: { rectificativaId: r.body.data.facturaId } });
    expect(enlace).toMatchObject({ partidaPendienteId: p.id, numeroOriginal: 'A-12', baseRectificada: -50 });
  });

  it('por sustitución con IRPF: la original lleva la retención leída y su IVA escrito, si cuadra con la base', async () => {
    const data = await leer('resultado-rectificativa', SIN_ORIGINAL);
    const documentId = data.ingreso.documentId;
    await conNumero(documentId, 'RV-9');
    // Corregida: 900 + 189 - 135 (IRPF 15 %).
    await conImportes(documentId, {
      bases: [{ tax_rate: 21, base_amount: 900, tax_amount: 189 }],
      withholdings: [{ type: 'IRPF', rate: 15, amount: 135 }],
      subtotal: 900,
      tax_total: 189,
      withholding_total: 135,
      total_gross: 1089,
      total_net: 954,
    });
    const bloque = { forma: 'S', motivo: 'ERROR', explicacion: 'Precio corregido', originales: [{ numero: 'A-2025-40', fecha: '2025-11-03' }] };
    const mal = await confirmar(SIN_ORIGINAL, { documentId, rectificativa: { ...bloque, importesOriginales: [{ tipoIva: 21, base: 1000, cuota: 2100 }] } });
    expect(mal.status).toBe(400);
    expect(mal.body.details).toMatchObject({ codigo: 'IMPORTES_ORIGINALES_NO_CUADRAN', campo: 'rectificativa.importesOriginales.0.cuota' });
    // Original: 1.000 + 210,01 (IVA línea a línea) - 150. Se registra la diferencia, también de la retención.
    const r = await confirmar(SIN_ORIGINAL, { documentId, rectificativa: { ...bloque, importesOriginales: [{ tipoIva: 21, base: 1000, cuota: 210.01 }] } });
    expect(r.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } });
    expect([f.baseTotal, f.ivaTotal, f.retencionTotal, f.totalFactura]).toEqual([-100, -21.01, -15, -106.01]);
  });

  it('por sustitución con importes leídos en negativo: 400 SIGNO_NO_CUADRA', async () => {
    const data = await leer('resultado-rectificativa-venta', SIN_ORIGINAL);
    const r = await confirmar(SIN_ORIGINAL, {
      documentId: data.ingreso.documentId,
      rectificativa: { forma: 'S', motivo: 'ERROR', originales: [{ numero: 'A-2025-41', fecha: '2025-11-04' }], importesOriginales: [{ tipoIva: 21, base: 300, cuota: 63 }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ codigo: 'SIGNO_NO_CUADRA', campo: 'rectificativa.forma' });
  });
});

describe('lector de ventas: la original es de otro cliente', () => {
  it('avisa del cliente distinto; con el cliente leído elegido, 400; sin él, va al de la original', async () => {
    const data = await leer('resultado-rectificativa-venta', OTRO);
    expect(data.ingreso.rectificativa).toMatchObject({ clienteDistinto: true, clienteDeLaOriginal: { nombreFiscal: 'OTRA EMPRESA SL' } });
    const bloque = { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[OTRO] }] };
    const otro = await confirmar(OTRO, { documentId: data.ingreso.documentId, clienteId: clientes[OTRO], rectificativa: bloque });
    expect(otro.status).toBe(400);
    expect(otro.body.details).toMatchObject({ codigo: 'ORIGINAL_DE_OTRO_CLIENTE', campo: 'clienteId' });
    const ok = await confirmar(OTRO, { documentId: data.ingreso.documentId, rectificativa: bloque });
    expect(ok.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: ok.body.data.facturaId } });
    expect(f.customerId).not.toBe(clientes[OTRO]);
  });

  it('sin el NIF del cliente leído y sin elegir cliente: con la original de la app no bloquea', async () => {
    const data = await leer('resultado-rectificativa-venta', OTRO);
    const documentId = data.ingreso.documentId;
    await conNumero(documentId, 'RV-10');
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: documentId } });
    const parsed = doc.parsedData as Record<string, any>;
    await prisma.incomeReaderDocument.update({
      where: { id: documentId },
      data: { parsedData: { ...parsed, customer: { ...parsed.customer, tax_id: null }, validation: { ...parsed.validation, errors: [] } } },
    });
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    const sinNif = { codigo: 'NIF_RECEPTOR', nivel: 'error', campos: ['nifCliente'], mensaje: 'Falta el NIF del cliente.' };
    // La lectura guardó el número leído (RV-4) como repetido: con el número cambiado, ya no.
    const guardadas = ((fila.validaciones as Array<{ codigo: string }>) ?? []).filter((v) => v.codigo !== 'DUPLICADA');
    await prisma.lecturaDocumento.update({ where: { id: data.lecturaId }, data: { validaciones: [...guardadas, sinNif] as never, estadoValidacion: 'error' } });
    const r = await confirmar(OTRO, { documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[OTRO] }] } });
    expect({ status: r.status, body: r.body }).toMatchObject({ status: 201, body: { data: { esRectificativa: true, numeroCompleto: 'RV-10' } } });
  });
});

describe('lecturas de antes (V19 guardada en error)', () => {
  it('con el bloque ya no bloquean', async () => {
    const data = await leer('resultado-rectificativa-venta', SIN_ORIGINAL);
    const viejo = 'Es una factura rectificativa (rectifica a la A-12). Todavía no se puede registrar con el lector.';
    await prisma.lecturaDocumento.update({
      where: { id: data.lecturaId },
      data: { validaciones: [{ codigo: 'RECTIFICATIVA', nivel: 'error', campos: ['tipoDocumento'], mensaje: viejo }], estadoValidacion: 'error' },
    });
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    const parsed = doc.parsedData as Record<string, any>;
    await prisma.incomeReaderDocument.update({ where: { id: doc.id }, data: { parsedData: { ...parsed, invoice: { ...parsed.invoice, number: 'RV-8' }, validation: { ...parsed.validation, errors: [viejo] } } } });
    const r = await confirmar(SIN_ORIGINAL, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ numero: 'A-2025-3', fecha: '2025-10-01' }] } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ esRectificativa: true, total: -242 });
  });
});

describe('VERI*FACTU: con la red de seguridad activa (enero de 2027, reloj simulado)', () => {
  const RELOJ = process.env.VERIFACTU_RED_RELOJ_PRUEBAS;
  let espia: jest.SpyInstance;
  beforeEach(async () => {
    // Sin fila en AjustePlataforma la red está activa; la empresa es una sociedad (1-1-2027).
    await prisma.ajustePlataforma.deleteMany({ where: { clave: redSeguridad.CLAVE_RED_SEGURIDAD } });
    process.env.VERIFACTU_RED_RELOJ_PRUEBAS = '2027-01-15T10:00:00Z';
    espia = jest.spyOn(redSeguridad, 'exigirPuedeEmitirFinal');
  });
  afterEach(() => {
    espia.mockRestore();
    if (RELOJ === undefined) delete process.env.VERIFACTU_RED_RELOJ_PRUEBAS;
    else process.env.VERIFACTU_RED_RELOJ_PRUEBAS = RELOJ;
  });

  it('la rectificativa leída se registra con origen lector y no pasa por la red', async () => {
    const data = await leer('resultado-rectificativa-venta', RED);
    const r = await confirmar(RED, { documentId: data.ingreso.documentId, rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originales[RED] }] } });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'RV-4', esRectificativa: true, total: -242 });
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } });
    expect(f).toMatchObject({ origen: 'lector', estadoDocumento: 'FINAL', tipoFactura: 'R1' });
    expect(espia).not.toHaveBeenCalled();
  });

  it('la emitida desde Nueva factura sí pasa por la red: 409 VERIFACTU_INACTIVO; como borrador se guarda y no se puede emitir', async () => {
    const dto = {
      companyId: RED,
      customer: {},
      lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -100, tipoIva: 21, cuenta: '705' }],
      rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelve parte del pedido', originales: [{ id: originales[RED] }] },
    } as unknown as CrearFacturaIngresoDTO;
    const antes = await prisma.incomeInvoice.count({ where: { companyId: RED } });
    await expect(incomeInvoicesService.crearIngreso(dto)).rejects.toMatchObject({
      statusCode: 409,
      details: { codigo: redSeguridad.CODIGO_VERIFACTU_INACTIVO },
      message: expect.stringMatching(/guardar la rectificativa como borrador/),
    });
    expect(espia).toHaveBeenCalledTimes(1);
    expect(await prisma.incomeInvoice.count({ where: { companyId: RED } })).toBe(antes);
    const b = await incomeInvoicesService.crearIngreso({ ...dto, borrador: true } as CrearFacturaIngresoDTO);
    expect(b).toMatchObject({ estadoDocumento: 'BORRADOR', esRectificativa: true });
    await expect(incomeInvoicesService.finalizar(RED, b.id)).rejects.toMatchObject({ statusCode: 409, details: { codigo: redSeguridad.CODIGO_VERIFACTU_INACTIVO } });
  });
});
