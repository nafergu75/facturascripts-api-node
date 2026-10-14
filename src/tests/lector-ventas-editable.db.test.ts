/**
 * Lector de ventas: «Corregir los datos» (spec lector-editable). La venta
 * leida se registra con lo corregido en el bloque `correcciones` del
 * confirmar, vuelto a validar como una lectura, sobre BD real y sin llamar a
 * Azure ni a Anthropic:
 *  - número, fecha, líneas, retención y total corregidos; sigue siendo una
 *    venta leída (origen lector, serie histórica desactivada, asiento en
 *    borrador) y queda en AuditLog lo leído y lo puesto;
 *  - los errores corregidos dejan de bloquear y los que siguen, sí, con el
 *    campo de la corrección (fecha futura, duplicada, serie de la app, total);
 *  - cuotas repartidas por tipo con dos líneas al 21 % a la 700 y la 705;
 *  - rectificativas: bases corregidas en negativo y la S sin original;
 *  - lo que no se admite: `lineas` a la vez, base negativa en una venta
 *    normal, documentos del lector antiguo y sin permiso de escritura.
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
import { aceptado, CLAVE, ENDPOINT, fixtureAzure, fixtureClaude, NIF_EMISOR, NIF_EMPRESA, respuesta, resultado } from './fixtures/azure-di';
import { clientesService } from '../services/clientes.service';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';

const SUFIJO = Date.now();
const E = `lector-edit-${SUFIJO}`;
const SIN_ORIGINAL = `lector-edit-sin-${SUFIJO}`;
/** Un PDF distinto en cada lectura: el mismo archivo ya registrado queda para revisar (ARCHIVO_REPETIDO). */
let nPdf = 0;
const pdf = () => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura emitida ${SUFIJO}-${++nPdf}`);
const clientes: Record<string, string> = {};
let originalA12 = '';

function app(companyId = E, rol = 'ventas') {
  const a = express();
  a.use(express.json({ limit: '20mb' }));
  a.use((req, _res, next) => {
    req.user = { userId: 'u-ventas', email: 'ventas@test.local', roles: [rol], companies: [companyId], rolesPorEmpresa: { [companyId]: [rol] } } as never;
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

/** Lee una factura de venta. fixture: el nombre de uno de Azure o su contenido ya cambiado. */
async function leer(fixture: string | Record<string, unknown>, companyId = E, opciones: { rectificativa?: boolean } = {}): Promise<Record<string, any>> {
  if (opciones.rectificativa) crear.mockResolvedValueOnce(fixtureClaude('complemento-rectificativa'));
  const p = await request(app(companyId)).post('/ingresos-extractor/lecturas').attach('archivo', pdf(), 'emitida.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => (typeof fixture === 'string' ? resultado(fixture) : respuesta(fixture, 200)));
  const r = await request(app(companyId)).get(`/ingresos-extractor/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

const confirmar = (companyId: string, cuerpo: Record<string, unknown>, rol = 'ventas') => request(app(companyId, rol)).post('/ingresos-extractor/confirmar').send(cuerpo);

/** El fixture simple (200 + 42 = 242) con el total de la factura cambiado: no cuadra (CUADRE en error). */
function simpleQueNoCuadra(): Record<string, unknown> {
  const f = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Record<string, any> }> } }>('resultado-simple');
  const campos = f.analyzeResult.documents[0].fields;
  campos.InvoiceTotal.valueCurrency.amount = 250;
  campos.AmountDue.valueCurrency.amount = 250;
  return f as unknown as Record<string, unknown>;
}

async function empresa(id: string) {
  await prisma.company.create({ data: { id, name: 'Imprenta Levante SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Imprenta Levante SL', nif: NIF_EMISOR } });
  await prisma.ajustesFiscales.create({ data: { companyId: id, inicioEnApp: '2026-01-01' } });
  clientes[id] = String((await clientesService.create(id, { nombreFiscal: 'COMERCIAL DEMO SL', nifCif: NIF_EMPRESA })).id);
  await listarSeries(id);
}

beforeAll(async () => {
  await empresa(E);
  await empresa(SIN_ORIGINAL);
  await prisma.invoiceSeries.update({ where: { companyId_codigo: { companyId: E, codigo: 'A' } }, data: { ultimoNumero: 11 } });
  const a12 = await incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: { id: clientes[E] },
    fechaEmision: '2026-03-01',
    lineas: [{ descripcion: 'Folletos', cantidad: 1, precioUnitario: 500, tipoIva: 21, cuenta: '705' }],
  } as CrearFacturaIngresoDTO);
  expect(a12.numeroCompleto).toBe('A-12');
  originalA12 = a12.id;
});

describe('corregir el número, la fecha y el concepto', () => {
  it('201 con el número corregido: venta leída, serie histórica desactivada, archivada en el trimestre de la fecha corregida y AuditLog', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, {
      documentId: data.ingreso.documentId,
      correcciones: { numero: 'F2026/0099', fechaEmision: '2026-05-05', fechaVencimiento: '2026-06-05', concepto: 'Folletos de mayo' },
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'F2026/0099', total: 242, corregida: true, aMano: false, contabilizada: true, asientoEnBorrador: true });
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } });
    expect(f).toMatchObject({ origen: 'lector', fechaEmision: '2026-05-05', serie: 'F2026', numero: 99 });
    expect(f.observaciones).toBe('Digitalizada desde emitida.pdf. Corregida a mano: número, fecha, vencimiento y concepto. Concepto: Folletos de mayo.');
    const serie = await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: E, codigo: 'F2026' } } });
    expect(serie.activa).toBe(false);
    // El documento del lector lleva lo corregido: el archivo va al 2.º trimestre, con el número bueno.
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    expect(doc.status).toBe('VERIFIED');
    expect(doc.storagePath).toMatch(/\/2026\/Q2\/income\/2026-05-05_INVOICE_F2026-0099_/);
    const archivado = await prisma.documentoArchivo.findFirst({ where: { companyId: E, incomeInvoiceId: f.id } });
    expect(archivado).toMatchObject({ trimestre: 2, fecha: '2026-05-05' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { companyId: E, action: 'LECTOR_VENTA_CORREGIDA', resourceId: f.id } });
    expect(audit.meta).toMatchObject({
      documentId: data.ingreso.documentId,
      lecturaId: data.lecturaId,
      manual: false,
      cambios: [
        { campo: 'numero', leido: 'F2026/0012', puesto: 'F2026/0099' },
        { campo: 'fechaEmision', leido: '2026-03-04', puesto: '2026-05-05' },
        { campo: 'fechaVencimiento', leido: '2026-04-03', puesto: '2026-06-05' },
        { campo: 'concepto', leido: expect.anything(), puesto: 'Folletos de mayo' },
      ],
    });
    const lectura = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect(lectura).toMatchObject({ estado: 'CONFIRMADA', incomeInvoiceId: f.id });
    // Otra vez (un doble clic): ya está registrada, 409.
    const otra = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0100' } });
    expect(otra.status).toBe(409);
    expect(otra.body.details).toMatchObject({ codigo: 'LECTURA_YA_CONFIRMADA' });
    expect(await prisma.incomeInvoice.count({ where: { companyId: E, numeroCompleto: 'F2026/0100' } })).toBe(0);
  });

  it('el número de otra factura ya registrada: DUPLICADA con el campo del número', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0099' } });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ codigo: 'VALIDACION_LECTURA', campo: 'correcciones.numero' });
    expect(r.body.details.validaciones.map((v: { codigo: string }) => v.codigo)).toContain('DUPLICADA');
  });

  it('una serie de la app (A o R): 409 con el campo serie', async () => {
    for (const numero of ['A-15', 'R-3']) {
      const data = await leer('resultado-simple');
      const r = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero } });
      expect(r.status).toBe(409);
      expect(r.body.details).toMatchObject({ campo: 'serie' });
    }
  });

  it('un número que no acaba en cifras: NUMERO_NO_VALIDO', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero: 'SIN-NUMERO' } });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ codigo: 'NUMERO_NO_VALIDO', campo: 'correcciones.numero' });
  });

  it('una fecha posterior a hoy: VALIDACION_LECTURA en la fecha', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0101', fechaEmision: '2099-01-01' } });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ codigo: 'VALIDACION_LECTURA', campo: 'correcciones.fechaEmision' });
  });
});

describe('corregir los importes', () => {
  it('la lectura que no cuadra: sin corregir, 400; con las líneas y el total, 201 con el asiento en borrador', async () => {
    const data = await leer(simpleQueNoCuadra());
    expect(data.ingreso.errores.join(' ')).toMatch(/no cuadran/);
    const sin = await confirmar(E, { documentId: data.ingreso.documentId, revisado: true, correcciones: { numero: 'F2026/0102' } });
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ codigo: 'VALIDACION_LECTURA', campo: 'correcciones.total' });
    // La lectura tenía un error: hace falta «He revisado».
    const cuerpo = { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0102', lineas: [{ descripcion: 'Folletos', base: 200, tipoIva: 21 }], total: 242 } };
    const sinRevisar = await confirmar(E, cuerpo);
    expect(sinRevisar.status).toBe(400);
    expect(sinRevisar.body.details).toMatchObject({ codigo: 'FALTA_REVISION' });
    const r = await confirmar(E, { ...cuerpo, revisado: true });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'F2026/0102', total: 242, corregida: true, asientoEnBorrador: true });
    const asiento = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.body.data.asientoId } });
    expect(asiento.estado).toBe('DRAFT');
  });

  it('un total que no cuadra con las líneas: CUADRE en el total; un céntimo de más (para revisar en la lectura): NO_CUADRA al registrar', async () => {
    const data = await leer('resultado-simple');
    const lineas = [{ descripcion: 'Folletos', base: 200, tipoIva: 21 }];
    const mal = await confirmar(E, { documentId: data.ingreso.documentId, revisado: true, correcciones: { numero: 'F2026/0103', lineas, total: 250 } });
    expect(mal.status).toBe(400);
    expect(mal.body.details).toMatchObject({ codigo: 'VALIDACION_LECTURA', campo: 'correcciones.total' });
    const centimo = await confirmar(E, { documentId: data.ingreso.documentId, revisado: true, correcciones: { numero: 'F2026/0103', lineas, total: 242.01 } });
    expect(centimo.status).toBe(400);
    expect(centimo.body.details).toMatchObject({ codigo: 'NO_CUADRA', campo: 'correcciones.total' });
  });

  it('una retención del 3 %: para revisar (FALTA_REVISION); con «He revisado», 201', async () => {
    const data = await leer('resultado-simple');
    const cuerpo = { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0104', tipoRetencion: 3, total: 236 } };
    const sin = await confirmar(E, cuerpo);
    expect(sin.status).toBe(400);
    expect(sin.body.details.codigo).toBe('FALTA_REVISION');
    expect(sin.body.details.validaciones.map((v: { codigo: string }) => v.codigo)).toContain('IRPF');
    const r = await confirmar(E, { ...cuerpo, revisado: true });
    expect(r.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId } });
    expect([f.baseTotal, f.ivaTotal, f.retencionTotal, f.totalFactura]).toEqual([200, 42, 6, 236]);
  });

  it('la retención leída sin porcentaje (solo el importe): sin corregir, con las líneas o solo el total, se registra con el que sale del importe', async () => {
    const casos: Array<[string, Record<string, unknown> | null]> = [
      ['F2026/0110', { lineas: [{ descripcion: 'Diseño', base: 600, tipoIva: 21 }, { descripcion: 'Impresión', base: 400, tipoIva: 21 }], total: 1060 }],
      ['F2026/0111', { total: 1060 }],
      ['F2026/0112', null],
    ];
    // Una empresa aparte: la última se registra con el número leído (F2026/0012), que las demás pruebas también leen.
    const RET = `lector-edit-ret-${SUFIJO}`;
    await empresa(RET);
    for (const [numero, importes] of casos) {
      // 1.000 € al 21 % con 150 € de retención: la IA puede leer el importe y no el porcentaje.
      const data = await leer('resultado-irpf', RET);
      const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
      const resultado = structuredClone(fila.resultado) as { lectura: { retencion: { tipo: unknown } } };
      resultado.lectura.retencion.tipo = { valor: null, confianza: null, fuente: 'claude' };
      await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { resultado: resultado as never } });
      if (!importes) {
        // Sin corregir nada: el documento del lector se rehace como al cambiar de dónde es el cliente.
        await request(app(RET)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'ES' });
      }
      const r = await confirmar(RET, { documentId: data.ingreso.documentId, revisado: true, ...(importes ? { correcciones: { numero, ...importes } } : {}) });
      expect(r.status).toBe(201);
      const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
      expect([f.baseTotal, f.ivaTotal, f.retencionTotal]).toEqual([1000, 210, 150]);
      expect(f.lineas.every((l) => l.tipoRetencion === 15)).toBe(true);
    }
  });

  it('dos líneas al 21 % a la 700 y a la 705: la cuota del tipo repartida, cuadra y cada línea en su cuenta', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, {
      documentId: data.ingreso.documentId,
      correcciones: {
        numero: 'F2026/0105',
        lineas: [
          { descripcion: 'Impresión', base: 100.5, tipoIva: 21, cuenta: '700' },
          { descripcion: 'Diseño', base: 99.5, tipoIva: 21, cuenta: '705' },
        ],
        total: 242,
      },
    });
    expect(r.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
    expect([f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual([200, 42, 242]);
    const porCuenta = f.lineas.map((l) => [l.descripcion, Number(l.baseLine), Number(l.ivaImporte), l.accountCode]).sort((a, b) => String(a[3]).localeCompare(String(b[3])));
    expect(porCuenta).toEqual([
      ['Impresión', 100.5, 21.1, '700'],
      ['Diseño', 99.5, 20.9, '705'],
    ]);
  });

  it('`lineas` de arriba a la vez que las corregidas: 400; una base en negativo en una venta normal: IMPORTE_NEGATIVO', async () => {
    const data = await leer('resultado-simple');
    const ambas = await confirmar(E, {
      documentId: data.ingreso.documentId,
      lineas: [{ cuenta: '705' }],
      correcciones: { lineas: [{ descripcion: 'x', base: 200, tipoIva: 21 }], total: 242 },
    });
    expect(ambas.status).toBe(400);
    expect(ambas.body.details).toMatchObject({ codigo: 'CORRECCION_NO_VALIDA', campo: 'lineas' });
    // Solo el número corregido y la cuenta de «Cambiar cuenta» sí van juntas.
    const negativa = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { lineas: [{ descripcion: 'x', base: -200, tipoIva: 21 }], total: -242 } });
    expect(negativa.status).toBe(400);
    expect(negativa.body.details).toMatchObject({ codigo: 'IMPORTE_NEGATIVO', campo: 'correcciones.lineas.0.base' });
  });

  it('el número corregido con la cuenta de «Cambiar cuenta»: 201 con la cuenta elegida', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, lineas: [{ cuenta: '705' }], correcciones: { numero: 'F2026/0106' } });
    expect(r.status).toBe(201);
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
    expect(f.lineas.map((l) => l.accountCode)).toEqual(['705']);
  });
});

describe('rectificativas con datos corregidos', () => {
  it('una rectificativa en positivo con las bases corregidas en negativo: por diferencias sin preguntar el signo', async () => {
    const data = await leer('resultado-rectificativa', E, { rectificativa: true });
    expect(data.ingreso.rectificativa).toMatchObject({ pideSigno: true, esRectificativaLeida: true, importesNegativos: false });
    const r = await confirmar(E, {
      documentId: data.ingreso.documentId,
      revisado: true,
      rectificativa: { forma: 'I', motivo: 'DEVOLUCION', originales: [{ id: originalA12 }] },
      correcciones: { numero: 'RV-20', lineas: [{ descripcion: 'Devolución', base: -100, tipoIva: 21 }], total: -121 },
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ numeroCompleto: 'RV-20', esRectificativa: true, total: -121, corregida: true });
    const f = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: r.body.data.facturaId }, include: { lineas: true } });
    expect(f).toMatchObject({ tipoRectificativa: 'I', facturaOriginalId: originalA12, customerId: clientes[E] });
    // Sin cuenta elegida, la de la original para su tipo de IVA.
    expect(f.lineas.map((l) => [Number(l.baseLine), l.accountCode])).toEqual([[-100, '705']]);
  });

  it('por sustitución sin la original en la app: los importes de la original y las líneas corregidas', async () => {
    const data = await leer('resultado-rectificativa', SIN_ORIGINAL, { rectificativa: true });
    const r = await confirmar(SIN_ORIGINAL, {
      documentId: data.ingreso.documentId,
      revisado: true,
      rectificativa: {
        forma: 'S',
        motivo: 'ERROR',
        explicacion: 'Precio corregido',
        originales: [{ numero: 'A-2025-50', fecha: '2025-11-05' }],
        importesOriginales: [{ tipoIva: 21, base: 350, cuota: 73.5 }],
      },
      correcciones: { numero: 'RV-21', lineas: [{ descripcion: 'Folletos', base: 300, tipoIva: 21 }], total: 363 },
    });
    expect(r.status).toBe(201);
    // Corregida 300 + 63 menos la original 350 + 73,50 (baja: no toca el 303 de la gestoría).
    expect(r.body.data).toMatchObject({ esRectificativa: true, total: -60.5, corregida: true });
  });
});

describe('lo que no se admite', () => {
  it('un documento del lector antiguo (/extraer-ia, sin lectura): CORRECCIONES_SIN_LECTURA', async () => {
    const data = await leer('resultado-simple');
    const doc = await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } });
    const antiguo = await prisma.incomeReaderDocument.create({
      data: {
        companyId: E,
        sourceType: 'EXTRACTOR_IA',
        originalFileName: 'antigua.pdf',
        mimeType: 'application/pdf',
        fileSize: 10,
        storagePath: doc.storagePath,
        status: 'READY_FOR_VERIFICATION',
        parsedData: doc.parsedData as never,
      },
    });
    const r = await confirmar(E, { documentId: antiguo.id, correcciones: { numero: 'F2026/0107' } });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ codigo: 'CORRECCIONES_SIN_LECTURA', campo: 'correcciones' });
  });

  it('solo con permiso de lectura de ventas: 403', async () => {
    const data = await leer('resultado-simple');
    const r = await confirmar(E, { documentId: data.ingreso.documentId, correcciones: { numero: 'F2026/0108' } }, 'solo-lectura');
    expect(r.status).toBe(403);
  });
});
