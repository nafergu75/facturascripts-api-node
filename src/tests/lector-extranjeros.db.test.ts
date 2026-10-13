/**
 * Lectores de ventas y de gastos con clientes y proveedores de fuera de
 * España (queja del usuario del 13-10-2026: «cuando la factura es
 * intracomunitaria o de un país tercero, al no tener NIF impide registrarla»).
 *
 *  - La persona dice antes de subir la factura de dónde es el tercero
 *    (origenTercero/paisTercero en la subida) y eso manda en las validaciones.
 *  - Después de leer se puede cambiar (POST /lecturas/:id/origen-tercero):
 *    se vuelve a validar sin leer otra vez la factura.
 *  - Un tercero de fuera sin número fiscal queda en «revisar», no en error, y
 *    su identificación extranjera no se valida como NIF español. Uno de
 *    España sin NIF sigue dando error.
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

import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import gastosRoutes from '../routes/gastos-extractor.routes';
import ingresosRoutes from '../routes/ingresos-extractor.routes';
import clientesRoutes from '../routes/clientes.routes';
import proveedoresRoutes from '../routes/proveedores.routes';
import { _reiniciarPausa } from '../services/lectura/azure-di.client';
import { exigirPlanAnteriorAntesDeAlta } from '../services/terceros/planAnteriorAlta';
import { aceptado, CLAVE, ENDPOINT, fixtureAzure, NIF_EMISOR, NIF_EMPRESA, respuesta } from './fixtures/azure-di';

const BASE = `lector-extranjeros-${Date.now()}`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\nfactura');
const FALTA_NIF_CLIENTE = 'Falta el NIF del cliente: es obligatorio en una factura de ingreso.';

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
  // Si se pregunta a la IA por un dato que falta, no contesta: se queda lo leido.
  crear.mockRejectedValue(Object.assign(new Error('x'), { status: 529 }));
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
/** Una empresa nueva para cada caso (la misma factura no sale repetida). */
async function empresa(nif: string): Promise<string> {
  const id = `${BASE}-${++n}`;
  await prisma.company.create({ data: { id, name: `Empresa ${n}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Empresa ${n} SL`, nif } });
  await exigirPlanAnteriorAntesDeAlta(id, true, 'test');
  return id;
}

type Campos = Record<string, unknown>;
/** resultado-simple con los cambios en sus campos (Customer* en ventas, Vendor* en gastos). */
function fixture(cambiar: (campos: Campos) => void): Record<string, unknown> {
  const f = fixtureAzure<{ analyzeResult: { documents: Array<{ fields: Campos }> } }>('resultado-simple');
  cambiar(f.analyzeResult.documents[0].fields);
  return f;
}
const texto = (v: string) => ({ type: 'string', valueString: v, content: v, confidence: 0.92 });
const direccion = (countryRegion: string, city = 'Ciudad') => ({
  type: 'address',
  valueAddress: { road: 'Calle Principal', houseNumber: '1', postalCode: '10001', city, countryRegion },
  content: `Calle Principal 1, 10001 ${city}`,
  confidence: 0.9,
});

type Lector = 'gastos-extractor' | 'ingresos-extractor';
/** Sube la factura (con de dónde es el tercero, si se da) y la lee con Azure simulado. */
async function leer(E: string, lector: Lector, f: Record<string, unknown>, origen?: { origenTercero: string; paisTercero?: string }): Promise<Record<string, any>> {
  let pet = request(app(E)).post(`/${lector}/lecturas`);
  if (origen) {
    pet = pet.field('origenTercero', origen.origenTercero);
    if (origen.paisTercero) pet = pet.field('paisTercero', origen.paisTercero);
  }
  const p = await pet.attach('archivo', PDF, 'factura.pdf');
  expect(p.status).toBe(202);
  const id = p.body.data.lecturaId;
  await prisma.lecturaDocumento.update({ where: { id }, data: { azureProximaConsulta: new Date(Date.now() - 1000) } });
  colaGet.push(() => respuesta(f, 200));
  const r = await request(app(E)).get(`/${lector}/lecturas/${id}`);
  expect(r.status).toBe(200);
  expect(r.body.data.estado).toBe('LISTA');
  return r.body.data;
}

const validaciones = async (lecturaId: string) =>
  ((await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: lecturaId } })).validaciones ?? []) as Array<{ codigo: string; nivel: string; mensaje: string }>;
const de = <T extends { codigo: string }>(vs: T[], codigo: string): T[] => vs.filter((v) => v.codigo === codigo);

// ---------------------------------------------------------------------------
// Ventas
// ---------------------------------------------------------------------------

describe('lector de ventas con clientes de fuera de España', () => {
  it('cliente francés con NIF-IVA con prefijo: sin nada que revisar del NIF; se da de alta con su país y se registra', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(
      E,
      'ingresos-extractor',
      fixture((c) => {
        c.CustomerName = texto('SOCIETE DUPONT SARL');
        c.CustomerTaxId = texto('FR40303265045');
        c.CustomerAddress = direccion('FRA', 'Paris');
      }),
      { origenTercero: 'UE', paisTercero: 'FR' },
    );
    expect(de(await validaciones(data.lecturaId), 'NIF_RECEPTOR')).toEqual([]);
    expect(data.lectura.tercero).toMatchObject({ tipo: 'cliente', eleccion: { origen: 'UE', pais: 'FR' }, origen: 'UE', pais: 'FR', numeroFiscal: 'NIF-IVA (VAT)', contradiccion: null });
    expect(data.ingreso.errores).toEqual([]);
    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Societe Dupont SARL', nifCif: 'FR40303265045', pais: 'FR' });
    expect(alta.status).toBe(201);
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: alta.body.data.id, revisado: true });
    expect(r.status).toBe(201);
  });

  it('cliente francés con el NIF-IVA leído sin prefijo: revisar, proponiéndolo con FR (también para la ficha del alta)', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(
      E,
      'ingresos-extractor',
      fixture((c) => {
        c.CustomerTaxId = texto('403 032 650 45');
        c.CustomerAddress = direccion('FRA', 'Paris');
      }),
    );
    expect(data.lectura.campos['receptor.nif']).toMatchObject({ estado: 'revisar', sugerencia: 'FR40303265045', codigos: ['NIF_RECEPTOR'] });
    expect(data.lectura.tercero).toMatchObject({ eleccion: null, origen: 'UE', pais: 'FR', por: 'direccion', nifPropuesto: 'FR40303265045' });
    expect(data.lectura.requiereRevision).toBe(true);
    expect(data.ingreso.errores).toEqual([]);
  });

  it('cliente de la República Dominicana con su RNC: no se valida como NIF español, se llama RNC y se encuentra por él una vez dado de alta', async () => {
    const E = await empresa(NIF_EMISOR);
    const f = fixture((c) => {
      c.CustomerName = texto('DISTRIBUIDORA CARIBE SRL');
      c.CustomerTaxId = texto('1-31-12345-6');
      c.CustomerAddress = direccion('DOM', 'Santo Domingo');
    });
    const data = await leer(E, 'ingresos-extractor', f, { origenTercero: 'FUERA', paisTercero: 'DO' });
    expect(data.ingreso.nifCliente).toBe('131123456');
    expect(de(await validaciones(data.lecturaId), 'NIF_RECEPTOR')).toEqual([]);
    expect(data.lectura.tercero).toMatchObject({ origen: 'FUERA', pais: 'DO', numeroFiscal: 'RNC' });
    expect(data.ingreso.clienteExistente).toBeNull();
    // Alta con su RNC tal como viene (con guiones) y su país.
    const alta = await request(app(E)).post('/clientes').send({ nombreFiscal: 'Distribuidora Caribe SRL', nifCif: '1-31-12345-6', pais: 'DO' });
    expect(alta.status).toBe(201);
    expect(alta.body.data).toMatchObject({ nifCif: '131123456', pais: 'DO' });
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: alta.body.data.id });
    expect(r.status).toBe(201);
    // Otra factura del mismo cliente: se encuentra por su RNC, con su país.
    const otra = await leer(E, 'ingresos-extractor', fixture((c) => {
      c.CustomerTaxId = texto('131-12345-6');
      c.InvoiceId = texto('F2026/0099');
    }));
    expect(otra.ingreso.clienteExistente).toMatchObject({ id: alta.body.data.id, pais: 'DO' });
    // Sin elegir nada: la ficha dice que es de la República Dominicana.
    expect(otra.lectura.tercero).toMatchObject({ origen: 'FUERA', pais: 'DO', por: 'ficha', numeroFiscal: 'RNC' });
    expect(de(await validaciones(otra.lecturaId), 'NIF_RECEPTOR')).toEqual([]);
  });

  it('cliente de EE. UU. sin número: revisar (no error); se registra con el cliente elegido y, sin él, pide darlo de alta', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(
      E,
      'ingresos-extractor',
      fixture((c) => {
        delete c.CustomerTaxId;
        c.CustomerName = texto('ACME TRADING LLC');
        c.CustomerAddress = direccion('USA', 'Miami');
      }),
      { origenTercero: 'FUERA' },
    );
    const nif = de(await validaciones(data.lecturaId), 'NIF_RECEPTOR');
    expect(nif).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/^La factura no lleva el EIN del cliente\./) })]);
    expect(data.lectura.tercero).toMatchObject({ eleccion: { origen: 'FUERA', pais: null }, pais: 'US', numeroFiscal: 'EIN' });
    expect(data.lectura.estado).toBe('revisar');
    expect(data.ingreso.errores).not.toContain(FALTA_NIF_CLIENTE);
    // Sin cliente: el 400 de siempre para darlo de alta, no «falta el NIF».
    const sin = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true });
    expect(sin.status).toBe(400);
    expect(sin.body.details).toMatchObject({ codigo: 'TERCERO_NO_DADO_DE_ALTA', nombre: 'ACME TRADING LLC' });
    const cliente = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Acme Trading LLC', nifCif: '123456789', pais: 'US' } });
    const con = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: cliente.id, revisado: true });
    expect(con.status).toBe(201);
  });

  it('cliente español sin NIF: sigue siendo error y no se registra sin un cliente', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(E, 'ingresos-extractor', fixture((c) => delete c.CustomerTaxId), { origenTercero: 'ES' });
    expect(de(await validaciones(data.lecturaId), 'NIF_RECEPTOR')[0]).toMatchObject({ nivel: 'error', mensaje: expect.stringMatching(/^Falta el NIF del cliente: es obligatorio/) });
    expect(data.lectura.estado).toBe('error');
    const r = await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, revisado: true });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/Falta el NIF del cliente/);
  });

  it('la elección manda sobre lo leído y cambiarla vuelve a validar sin leer otra vez (también el documento que usa el confirmar)', async () => {
    const E = await empresa(NIF_EMISOR);
    const data = await leer(
      E,
      'ingresos-extractor',
      fixture((c) => {
        c.CustomerTaxId = texto('FR40303265045');
        c.CustomerAddress = direccion('FRA', 'Lyon');
      }),
      { origenTercero: 'ES' },
    );
    // De España con un NIF-IVA francés: error, con el aviso que propone cambiarla.
    expect(de(await validaciones(data.lecturaId), 'NIF_RECEPTOR')[0].nivel).toBe('error');
    expect(data.lectura.tercero.contradiccion).toMatchObject({ origen: 'UE', pais: 'FR' });
    expect(data.lectura.estado).toBe('error');
    const doc = async () => (await prisma.incomeReaderDocument.findUniqueOrThrow({ where: { id: data.ingreso.documentId } })).parsedData as { validation: { errors: string[] } };
    expect((await doc()).validation.errors.length).toBeGreaterThan(0);
    await prisma.lecturaDocumento.update({ where: { id: data.lecturaId }, data: { revisada: true } });
    const llamadasAzure = fetchMock.mock.calls.length;

    const c = await request(app(E)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'UE', pais: 'FR' });
    expect(c.status).toBe(200);
    expect(c.body.data).toMatchObject({ estado: 'LISTA', lectura: { estado: 'ok', tercero: { eleccion: { origen: 'UE', pais: 'FR' }, contradiccion: null } } });
    expect(c.body.data.ingreso.errores).toEqual([]);
    // Sin leer otra vez: ni Azure ni la IA.
    expect(fetchMock.mock.calls.length).toBe(llamadasAzure);
    expect(crear).not.toHaveBeenCalled();
    const fila = await prisma.lecturaDocumento.findUniqueOrThrow({ where: { id: data.lecturaId } });
    expect(fila).toMatchObject({ estado: 'LISTA', estadoValidacion: 'ok', revisada: false });
    expect((fila.resultado as { origenTercero: unknown }).origenTercero).toEqual({ origen: 'UE', pais: 'FR' });
    expect((await doc()).validation.errors).toEqual([]);
    // El GET da lo mismo.
    const g = await request(app(E)).get(`/ingresos-extractor/lecturas/${data.lecturaId}`);
    expect(g.body.data.lectura.tercero.eleccion).toEqual({ origen: 'UE', pais: 'FR' });

    // Sin elección (null): se deduce otra vez (por el prefijo).
    const auto = await request(app(E)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: null });
    expect(auto.body.data.lectura.tercero).toMatchObject({ eleccion: null, origen: 'UE', por: 'prefijo' });

    // Una elección que no vale: 400 y no cambia nada.
    const mal = await request(app(E)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'UE', pais: 'US' });
    expect(mal.status).toBe(400);
    expect(mal.body.details).toMatchObject({ codigo: 'ORIGEN_TERCERO_NO_VALIDO', campo: 'paisTercero' });

    // Registrada: ya no se puede cambiar. Y una lectura de otra empresa: 404.
    const alta = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Lyon SARL', nifCif: 'FR40303265045', pais: 'FR' } });
    expect((await request(app(E)).post('/ingresos-extractor/confirmar').send({ documentId: data.ingreso.documentId, clienteId: alta.id })).status).toBe(201);
    const tarde = await request(app(E)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'ES' });
    expect(tarde.status).toBe(409);
    const OTRA = await empresa(NIF_EMISOR);
    expect((await request(app(OTRA)).post(`/ingresos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'ES' })).status).toBe(404);
  });

  it('una elección que no vale al subir: 400 sin crear la lectura', async () => {
    const E = await empresa(NIF_EMISOR);
    const p = await request(app(E)).post('/ingresos-extractor/lecturas').field('origenTercero', 'MARTE').attach('archivo', PDF, 'factura.pdf');
    expect(p.status).toBe(400);
    expect(p.body.details).toMatchObject({ codigo: 'ORIGEN_TERCERO_NO_VALIDO' });
    expect(await prisma.lecturaDocumento.count({ where: { companyId: E } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

describe('lector de gastos con proveedores de fuera de España', () => {
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
  // Un proveedor de fuera de España no cobra IVA español: el total va como base, al 0 %.
  const cuerpoFuera = (extra: Record<string, unknown> = {}) =>
    cuerpo({ lineas: [{ descripcion: 'Folletos', cantidad: 1, precioUnitario: 242, tipoIva: 0, tipoRetencion: 0 }], ...extra });

  it('proveedor de un país tercero sin NIF: revisar (no error); dado de alta con su país, se registra', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(
      E,
      'gastos-extractor',
      fixture((c) => {
        delete c.VendorTaxId;
        c.VendorName = texto('GLOBAL PRINT INC');
        c.VendorAddress = direccion('USA', 'Boston');
      }),
      { origenTercero: 'FUERA', paisTercero: 'US' },
    );
    expect(de(await validaciones(data.lecturaId), 'NIF_EMISOR')).toEqual([
      expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/^No se ha podido leer el EIN del proveedor\./) }),
    ]);
    expect(data.lectura.tercero).toMatchObject({ tipo: 'proveedor', origen: 'FUERA', pais: 'US', numeroFiscal: 'EIN' });
    expect(data.lectura.estado).not.toBe('error');
    const alta = await request(app(E)).post('/proveedores').send({ nombreFiscal: 'Global Print Inc', nifCif: '12-3456789', pais: 'US' });
    expect(alta.status).toBe(201);
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpoFuera({ lecturaId: data.lecturaId, revisado: true, proveedor: { id: alta.body.data.id } }));
    expect(r.status).toBe(201);
  });

  it('proveedor español sin NIF: error, como siempre', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(E, 'gastos-extractor', fixture((c) => delete c.VendorTaxId));
    expect(de(await validaciones(data.lecturaId), 'NIF_EMISOR')[0]).toMatchObject({ nivel: 'error', mensaje: 'No se ha podido leer el NIF del proveedor.' });
  });

  it('la elección manda: De fuera de la UE con un NIF español no da error pero avisa; cambiarla vuelve a validar', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(E, 'gastos-extractor', fixture(() => undefined), { origenTercero: 'FUERA' });
    const vs = await validaciones(data.lecturaId);
    expect(de(vs, 'NIF_EMISOR')).toEqual([]);
    expect(de(vs, 'ORIGEN_TERCERO')).toEqual([expect.objectContaining({ nivel: 'revisar' })]);
    expect(data.lectura.tercero.contradiccion).toMatchObject({ origen: 'ES' });
    const c = await request(app(E)).post(`/gastos-extractor/lecturas/${data.lecturaId}/origen-tercero`).send({ origen: 'ES' });
    expect(c.status).toBe(200);
    expect(c.body.data.lectura).toMatchObject({ estado: 'ok', tercero: { eleccion: { origen: 'ES', pais: 'ES' }, contradiccion: null, numeroFiscal: 'NIF' } });
    expect(c.body.data.gasto).toMatchObject({ nifProveedor: NIF_EMISOR });
    expect(de(await validaciones(data.lecturaId), 'ORIGEN_TERCERO')).toEqual([]);
  });

  it('al registrar se vuelve a validar con lo elegido; un proveedor ya dado de alta lo decide su ficha (De España por defecto no lo bloquea)', async () => {
    const E = await empresa(NIF_EMPRESA);
    const data = await leer(
      E,
      'gastos-extractor',
      fixture((c) => {
        c.VendorTaxId = texto('98-7654321');
        c.VendorAddress = direccion('USA', 'Denver');
      }),
      { origenTercero: 'ES' },
    );
    // Sin dar de alta: lo elegido manda y un EIN no es un NIF español.
    expect(de(await validaciones(data.lecturaId), 'NIF_EMISOR')[0].nivel).toBe('error');
    // Elegido un proveedor dado de alta (de EE. UU.): su ficha manda al registrar.
    const prov = await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Rocky Paper Co', nifCif: '987654321', pais: 'US' } });
    const r = await request(app(E)).post('/gastos-extractor/confirmar').send(cuerpoFuera({ lecturaId: data.lecturaId, revisado: true, proveedor: { id: prov.id } }));
    expect(r.status).toBe(201);

    // Otra factura suya, otra vez con De España: sin error en su numero, con el aviso para cambiarlo.
    const otra = await leer(
      E,
      'gastos-extractor',
      fixture((c) => {
        c.VendorTaxId = texto('98-7654321');
        c.VendorAddress = direccion('USA', 'Denver');
        c.InvoiceId = texto('F2026/0013');
      }),
      { origenTercero: 'ES' },
    );
    const vs = await validaciones(otra.lecturaId);
    expect(de(vs, 'NIF_EMISOR')).toEqual([]);
    expect(de(vs, 'ORIGEN_TERCERO')).toEqual([expect.objectContaining({ nivel: 'revisar', mensaje: expect.stringMatching(/^Lo tienes dado de alta como proveedor de Estados Unidos/) })]);
    expect(otra.lectura.tercero).toMatchObject({ origen: 'FUERA', pais: 'US', por: 'ficha', numeroFiscal: 'EIN', contradiccion: { origen: 'FUERA', pais: 'US' } });
    // Cambiada a De fuera de la UE: ya sin aviso.
    const c = await request(app(E)).post(`/gastos-extractor/lecturas/${otra.lecturaId}/origen-tercero`).send({ origen: 'FUERA', pais: 'US' });
    expect(c.body.data.lectura.tercero).toMatchObject({ origen: 'FUERA', pais: 'US', numeroFiscal: 'EIN', contradiccion: null });
    expect(de(await validaciones(otra.lecturaId), 'ORIGEN_TERCERO')).toEqual([]);
  });
});
