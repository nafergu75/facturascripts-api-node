/**
 * Series de numeracion sobre BD real: estados imposibles, tipos sin documento,
 * creacion silenciosa por errata y permisos de lectura.
 *
 * Antes actualizarSerie dejaba marcar como predeterminada una serie inactiva,
 * desactivar la predeterminada y dejar las facturas sin serie activa;
 * obtenerOCrearSerie creaba una serie ACTIVA con cualquier codigo tecleado; se
 * aceptaban PEDIDO, ALBARAN y PRESUPUESTO; y el contable recibia un 403 al
 * listar las series.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import seriesRoutes from '../routes/series.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { codigoSerieTickets, listarSeries, normalizarCodigoSerie, obtenerOCrearSerieHistorica, obtenerOCrearSerieTickets } from '../services/series.service';

const COMPANY_ID = `series-test-${Date.now()}`;
let customerId: string;

/** App con la ruta de series y el rol indicado en la empresa. */
function appCon(rol: string) {
  const app = express();
  app.use(express.json());
  app.use('/companies/:companyId', (req, _res, next) => {
    req.user = { userId: `u-${rol}`, roles: [rol], rolesPorEmpresa: { [COMPANY_ID]: [rol] } } as never;
    req.companyId = req.params.companyId;
    next();
  });
  app.use('/companies/:companyId/series', seriesRoutes);
  app.use(errorMiddleware);
  return app;
}
const admin = appCon('admin');
const ruta = `/companies/${COMPANY_ID}/series`;
const serie = async (codigo: string) => prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId: COMPANY_ID, codigo } } });
const put = (codigo: string, body: object) => serie(codigo).then((s) => request(admin).put(`${ruta}/${s.id}`).send(body));

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY_ID, name: 'Series Test SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY_ID, denominacion: 'Series Test SL', nif: 'B11000000' } });
  customerId = (await prisma.customer.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Cliente Series SL', nifCif: 'B12000000' } })).id;
  await listarSeries(COMPANY_ID); // semilla: A y C (facturas), R (rectificativas), P (proformas)
});

describe('permisos', () => {
  it('el contable puede ver las series (contabilidad:read) pero no cambiarlas', async () => {
    const contable = appCon('contable');
    const res = await request(contable).get(ruta);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { codigo: string }) => s.codigo)).toEqual(expect.arrayContaining(['A', 'R', 'P']));
    expect((await request(contable).post(ruta).send({ codigo: 'X', tipoDocumento: 'FACTURA' })).status).toBe(403);
  });

  it('ventas y solo lectura tambien las ven', async () => {
    expect((await request(appCon('ventas')).get(ruta)).status).toBe(200);
    expect((await request(appCon('solo_lectura')).get(ruta)).status).toBe(200);
  });
});

describe('crear serie', () => {
  it('tipos sin documento detras (ALBARAN, PEDIDO, PRESUPUESTO): 400', async () => {
    for (const tipoDocumento of ['ALBARAN', 'PEDIDO', 'PRESUPUESTO']) {
      const res = await request(admin).post(ruta).send({ codigo: 'Z1', tipoDocumento });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ campo: 'tipoDocumento' });
    }
    expect((await request(admin).get(`${ruta}?tipoDocumento=ALBARAN`)).status).toBe(400);
  });

  it('codigo con ñ, con € o de 11 caracteres: 400', async () => {
    for (const codigo of ['AÑO', 'E€', 'ABCDEFGHIJK']) {
      const res = await request(admin).post(ruta).send({ codigo, tipoDocumento: 'FACTURA' });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ campo: 'codigo' });
    }
  });

  it('predeterminada y desactivada a la vez: 400', async () => {
    const res = await request(admin).post(ruta).send({ codigo: 'Z2', tipoDocumento: 'FACTURA', porDefecto: true, activa: false });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ campo: 'porDefecto' });
  });

  it('crea B activa (no predeterminada); repetirla da 409', async () => {
    const res = await request(admin).post(ruta).send({ codigo: 'b', descripcion: 'Segunda', tipoDocumento: 'FACTURA' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ codigo: 'B', activa: true, porDefecto: false });
    expect((await request(admin).post(ruta).send({ codigo: 'B', tipoDocumento: 'FACTURA' })).status).toBe(409);
  });
});

describe('cambiar una serie (PUT)', () => {
  it('(b) desactivar la predeterminada: 409 "Marca antes otra serie como predeterminada"', async () => {
    const res = await put('A', { activa: false });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Marca antes otra serie como predeterminada/);
    expect((await serie('A')).activa).toBe(true);
  });

  it('(b) desmarcar la predeterminada sin elegir otra: 409', async () => {
    expect((await put('A', { porDefecto: false })).status).toBe(409);
    expect((await serie('A')).porDefecto).toBe(true);
  });

  it('(a) marcar como predeterminada una serie desactivada: 409', async () => {
    expect((await put('B', { activa: false })).status).toBe(200);
    const res = await put('B', { porDefecto: true });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/actívala antes/);
    // Activarla y marcarla en la misma peticion si vale.
    expect((await put('B', { activa: true, porDefecto: true })).status).toBe(200);
    expect(await serie('B')).toMatchObject({ activa: true, porDefecto: true });
    expect((await serie('A')).porDefecto).toBe(false);
  });

  it('(c) no deja las facturas sin ninguna serie activa', async () => {
    // Estado de antes de estas reglas: la predeterminada (B) desactivada y A, la unica activa (la C de servicios, tambien desactivada).
    await prisma.invoiceSeries.update({ where: { id: (await serie('B')).id }, data: { activa: false } });
    await prisma.invoiceSeries.update({ where: { id: (await serie('C')).id }, data: { activa: false } });
    const res = await put('A', { activa: false });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/No puede quedar ninguna serie de facturas activa/);
    // Se arregla volviendo a activar B.
    expect((await put('B', { activa: true })).status).toBe(200);
  });

  it('la descripcion se cambia; un valor que no es si/no se rechaza', async () => {
    expect((await put('A', { descripcion: 'Serie antigua' })).body.data.descripcion).toBe('Serie antigua');
    expect((await put('A', { activa: 'no' })).status).toBe(400);
  });

  it('dos cambios a la vez no dejan el tipo sin predeterminada activa', async () => {
    // B es la predeterminada. A la vez: A pasa a predeterminada y B se desactiva.
    const [r1, r2] = await Promise.all([put('A', { porDefecto: true }), put('B', { activa: false })]);
    expect(r1.status).toBe(200);
    expect([200, 409]).toContain(r2.status);
    const facturas = await prisma.invoiceSeries.findMany({ where: { companyId: COMPANY_ID, tipoDocumento: 'FACTURA' } });
    const predeterminadas = facturas.filter((s) => s.porDefecto);
    expect(predeterminadas).toHaveLength(1);
    expect(predeterminadas[0]).toMatchObject({ codigo: 'A', activa: true });
  });
});

describe('alta de facturas y series', () => {
  const linea = { descripcion: 'Servicio', cantidad: 1, precioUnitario: 100, tipoIva: 21 };

  it('una serie que no existe es un 400 y no se crea ninguna serie', async () => {
    const antes = await prisma.invoiceSeries.count({ where: { companyId: COMPANY_ID } });
    const error = await incomeInvoicesService
      .crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie: 'ERRATA', fechaEmision: '2026-02-01', lineas: [linea] })
      .catch((e) => e);
    expect(error).toMatchObject({ statusCode: 400, details: { campo: 'serie' } });
    expect(error.message).toMatch(/^La serie ERRATA no existe/);
    await expect(
      incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie: 'NOPE', fechaEmision: '2026-02-01', lineas: [linea], proforma: true }),
    ).rejects.toThrow(/La serie NOPE no existe/);
    expect(await prisma.invoiceSeries.count({ where: { companyId: COMPANY_ID } })).toBe(antes);
  });

  it('el codigo se busca tambien en mayusculas', async () => {
    const f = await incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie: 'a', fechaEmision: '2026-02-02', lineas: [linea] });
    expect(f.numeroCompleto).toMatch(/^A-\d+$/);
  });

  it('el lector crea la serie de la factura leida, normalizada y DESACTIVADA', async () => {
    const f = await incomeInvoicesService.crearIngreso(
      { companyId: COMPANY_ID, customer: { id: customerId }, serie: 'fac/2026', numero: 5, fechaEmision: '2026-02-03', lineas: [linea] },
      { origen: 'lector' },
    );
    expect(f.numeroCompleto).toBe('FAC-2026-5');
    expect(await serie('FAC-2026')).toMatchObject({ activa: false, porDefecto: false, tipoDocumento: 'FACTURA', ultimoNumero: 5 });
    // La siguiente factura leida de esa serie la reutiliza aunque este desactivada.
    const g = await incomeInvoicesService.crearIngreso(
      { companyId: COMPANY_ID, customer: { id: customerId }, serie: 'FAC/2026', numero: 6, fechaEmision: '2026-02-04', lineas: [linea] },
      { origen: 'lector' },
    );
    expect(g.numeroCompleto).toBe('FAC-2026-6');
    // Desde la pantalla, una serie desactivada no se usa.
    await expect(
      incomeInvoicesService.crearIngreso({ companyId: COMPANY_ID, customer: { id: customerId }, serie: 'FAC-2026', fechaEmision: '2026-02-05', lineas: [linea] }),
    ).rejects.toThrow(/La serie FAC-2026 está desactivada/);
  });

  it('normalizarCodigoSerie', () => {
    expect(normalizarCodigoSerie('fac/2026')).toBe('FAC-2026');
    expect(normalizarCodigoSerie(' Año 2026 ')).toBe('ANO-2026');
    expect(normalizarCodigoSerie('FACTURAS-EMITIDAS')).toBe('FACTURAS-E');
    expect(normalizarCodigoSerie('ABCDEFGHI/J')).toBe('ABCDEFGHI');
    expect(normalizarCodigoSerie('///')).toBe('');
  });
});

describe('rectificativas de tickets (RECTIFICATIVA_SIMPLIFICADA)', () => {
  const OTRA = `${COMPANY_ID}-rt`;
  beforeAll(async () => {
    await prisma.company.create({ data: { id: OTRA, name: 'Series Tickets SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  });

  it('no se siembra en todas las empresas: solo A, C, R y P', async () => {
    const series = await listarSeries(OTRA);
    expect(series.map((s) => s.codigo).sort()).toEqual(['A', 'C', 'P', 'R']);
    expect(series.map((s) => s.tipoDocumento).sort()).toEqual(['FACTURA', 'FACTURA', 'PROFORMA', 'RECTIFICATIVA']);
  });

  it('la primera R5 crea la RT activa y predeterminada; la siguiente usa la misma', async () => {
    expect(await codigoSerieTickets(OTRA)).toEqual({ codigo: 'RT', existe: false, desactivada: false });
    const rt = await obtenerOCrearSerieTickets(OTRA);
    expect(rt).toMatchObject({ codigo: 'RT', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true });
    expect((await obtenerOCrearSerieTickets(OTRA)).id).toBe(rt.id);
    expect(await codigoSerieTickets(OTRA)).toEqual({ codigo: 'RT', existe: true, desactivada: false });
  });

  it('si RT es otra serie, crea la RTK', async () => {
    const empresa = `${COMPANY_ID}-rtk`;
    await prisma.company.create({ data: { id: empresa, name: 'Series RTK SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.invoiceSeries.create({ data: { companyId: empresa, codigo: 'RT', descripcion: 'Otra cosa', tipoDocumento: 'FACTURA', activa: true } });
    expect(await codigoSerieTickets(empresa)).toEqual({ codigo: 'RTK', existe: false, desactivada: false });
    expect((await obtenerOCrearSerieTickets(empresa)).codigo).toBe('RTK');
  });

  it('con series de tickets pero todas desactivadas: 400 SERIE_TICKETS_DESACTIVADA', async () => {
    const empresa = `${COMPANY_ID}-rtoff`;
    await prisma.company.create({ data: { id: empresa, name: 'Series RT off SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.invoiceSeries.create({ data: { companyId: empresa, codigo: 'TK', descripcion: 'Tickets', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: false } });
    await expect(obtenerOCrearSerieTickets(empresa)).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'SERIE_TICKETS_DESACTIVADA', campo: 'serie' } });
    // La pantalla lo sabe antes de guardar: existe, pero desactivada (no «se crea al guardar»).
    expect(await codigoSerieTickets(empresa)).toEqual({ codigo: 'TK', existe: true, desactivada: true });
  });

  it('una serie histórica del lector de ese tipo no cuenta: la primera R5 crea la RT (y una histórica RT se salta)', async () => {
    const empresa = `${COMPANY_ID}-rthist`;
    await prisma.company.create({ data: { id: empresa, name: 'Series RT hist SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    const cliente = await prisma.customer.create({ data: { companyId: empresa, nombreFiscal: 'Cliente', nifCif: 'B50000091' } });
    // Dos series históricas de rectificativas de tickets, con una factura leída cada una (numeración del otro programa).
    for (const codigo of ['TKH', 'RT']) {
      await prisma.invoiceSeries.create({ data: { companyId: empresa, codigo, descripcion: `Serie ${codigo} (facturas de otro programa)`, tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: false } });
      await prisma.incomeInvoice.create({
        data: { companyId: empresa, customerId: cliente.id, serie: codigo, numero: 1, numeroCompleto: `${codigo}-1`, fechaEmision: '2026-05-01', fechaVencimiento: '2026-05-01', origen: 'lector', estadoDocumento: 'FINAL', esRectificativa: true, tipoFactura: 'R5' },
      });
    }
    expect(await codigoSerieTickets(empresa)).toEqual({ codigo: 'RTK', existe: false, desactivada: false });
    const rtk = await obtenerOCrearSerieTickets(empresa);
    expect(rtk).toMatchObject({ codigo: 'RTK', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true });
    await prisma.incomeInvoice.deleteMany({ where: { companyId: empresa } });
  });

  it('se puede crear desde Configuración > Series y listar por su tipo', async () => {
    const res = await request(admin).post(ruta).send({ codigo: 'RTX', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', descripcion: 'Tickets' });
    expect(res.status).toBe(201);
    const lista = await request(admin).get(`${ruta}?tipoDocumento=RECTIFICATIVA_SIMPLIFICADA`);
    expect(lista.status).toBe(200);
    expect(lista.body.data.map((s: { codigo: string }) => s.codigo)).toEqual(['RTX']);
  });
});

describe('series históricas del lector que mezclan facturas y rectificativas', () => {
  it('una histórica de facturas sirve para una rectificativa leída solo si se acepta (con aviso); una de la app, nunca', async () => {
    const fv = await obtenerOCrearSerieHistorica(COMPANY_ID, 'FV');
    expect(fv).toMatchObject({ codigo: 'FV', tipoDocumento: 'FACTURA', activa: false });
    await expect(obtenerOCrearSerieHistorica(COMPANY_ID, 'FV', 'RECTIFICATIVA')).rejects.toMatchObject({ statusCode: 409 });
    expect(await obtenerOCrearSerieHistorica(COMPANY_ID, 'FV', 'RECTIFICATIVA', { aceptarOtroTipo: true })).toMatchObject({ codigo: 'FV', mixta: true });
    // A es una serie de la app: 409 aunque se acepte otro tipo.
    await expect(obtenerOCrearSerieHistorica(COMPANY_ID, 'A', 'RECTIFICATIVA', { aceptarOtroTipo: true })).rejects.toMatchObject({ statusCode: 409 });
  });
});
