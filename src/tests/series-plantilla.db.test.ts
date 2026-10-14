/**
 * Plantilla de cada serie (Configuracion > Series), sobre BD real.
 *
 *  - Automatica por el codigo: la serie A de una empresa espanola que
 *    repercute el IEEPNR usa la plantilla A; la B, la B (ceramica); la C, la C
 *    (servicios); R, P y RT, la estandar. En una espanola que no repercute el
 *    IEEPNR, la A sigue con la estandar. En una de EE. UU., la A y la B pasan a
 *    la estandar (son solo para Espana) y la C sigue con la C.
 *  - Serie C: se crea sola en todas las empresas (las de antes y las nuevas),
 *    activa, sin ser la predeterminada y con su propia numeracion.
 *  - GET /series/plantillas: el catalogo, con la A y la B no disponibles fuera
 *    de Espana y las series que usan cada una sin elegirla.
 *  - POST y PUT con plantillas y observaciones por defecto (400 con su campo).
 *  - Permisos: la lista la ve el contable; cambiarla, solo quien factura.
 *  - serieCompatible: a que serie van duplicar y pasar a factura con envases,
 *    con ceramica o con descuento por linea.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import seriesRoutes from '../routes/series.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { crearSerie, listarSeries, serieCompatible, serieParaEnvases } from '../services/series.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';

const SUFIJO = Date.now();
const ES = `series-plant-es-${SUFIJO}`;
const US = `series-plant-us-${SUFIJO}`;
/** Espanola que no repercute el IEEPNR (no vende envases) ni vende ceramica. */
const ES_SIN = `series-plant-sin-${SUFIJO}`;
/** Empresa de antes, con sus series y sin la C (la C llega al listar). */
const VIEJA = `series-plant-vieja-${SUFIJO}`;
/** Empresa que ya usaba el codigo C para sus proformas. */
const CON_C = `series-plant-conc-${SUFIJO}`;

let rol = 'admin';
const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: `u-${rol}`, roles: [rol], rolesPorEmpresa: { [req.params.companyId]: [rol] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/series', seriesRoutes);
app.use(errorMiddleware);

type SerieResp = {
  id: string;
  codigo: string;
  descripcion: string;
  tipoDocumento: string;
  activa: boolean;
  porDefecto: boolean;
  plantilla: string;
  plantillaElegida: string | null;
  observacionesDefecto: string | null;
  numeroSiguiente: number;
};
const listar = async (empresa = ES): Promise<SerieResp[]> => (await request(app).get(`/companies/${empresa}/series`)).body.data;
const deCodigo = async (codigo: string, empresa = ES) => (await listar(empresa)).find((s) => s.codigo === codigo)!;

beforeAll(async () => {
  for (const [id, name] of [
    [ES, 'Series Plantilla SL'],
    [US, 'Series Template Inc'],
    [ES_SIN, 'Series Sin Envases SL'],
    [VIEJA, 'Series Vieja SL'],
    [CON_C, 'Series Con C SL'],
  ]) {
    await prisma.company.create({ data: { id, name, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  await prisma.legalConfig.create({ data: { companyId: US, denominacion: 'Series Template Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
  // Primero las series de siempre (A, R y P) y la C: la semilla solo se crea en un tipo sin series.
  await guardarAjustesFacturacion(ES, 'u-test', { ieepnrRepercute: true, vendeCeramica: true });
  await listarSeries(ES);
  await listarSeries(US);
  await listarSeries(ES_SIN);
  await crearSerie(ES, { codigo: 'B', descripcion: 'Ceramica', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  await crearSerie(ES, { codigo: 'RT', descripcion: 'Tickets', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true });
  // Una empresa de antes: sus series A, R y P, sin la C.
  for (const [codigo, tipoDocumento] of [['A', 'FACTURA'], ['R', 'RECTIFICATIVA'], ['P', 'PROFORMA']]) {
    await prisma.invoiceSeries.create({ data: { companyId: VIEJA, codigo, descripcion: codigo, tipoDocumento, activa: true, porDefecto: true, ultimoNumero: 7 } });
  }
  await prisma.invoiceSeries.create({ data: { companyId: CON_C, codigo: 'C', descripcion: 'Proformas C', tipoDocumento: 'PROFORMA', activa: true, porDefecto: true } });
});

describe('plantilla automatica', () => {
  it('empresa espanola que repercute el IEEPNR y vende ceramica: la A usa la A, la B la B y la C la C; R, P y RT, la estandar', async () => {
    const series = await listar();
    const por = Object.fromEntries(series.map((s) => [s.codigo, [s.plantilla, s.plantillaElegida]]));
    expect(por).toMatchObject({
      A: ['A', null],
      B: ['B', null],
      C: ['C', null],
      R: ['default', null],
      P: ['default', null],
      RT: ['default', null],
    });
  });

  it('empresa de EE. UU.: la A y la B quedan en la estandar; la C sigue con la C', async () => {
    expect(await deCodigo('A', US)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
    expect(await deCodigo('C', US)).toMatchObject({ plantilla: 'C', plantillaElegida: null });
    await crearSerie(US, { codigo: 'B', descripcion: 'Second line', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
    expect(await deCodigo('B', US)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
  });

  it('empresa espanola que no repercute el IEEPNR: la A sigue con la estandar; al marcarlo pasa a la A, y al quitarlo vuelve', async () => {
    expect(await deCodigo('A', ES_SIN)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
    await guardarAjustesFacturacion(ES_SIN, 'u-test', { ieepnrRepercute: true });
    expect(await deCodigo('A', ES_SIN)).toMatchObject({ plantilla: 'A', plantillaElegida: null });
    await guardarAjustesFacturacion(ES_SIN, 'u-test', { ieepnrRepercute: false });
    expect(await deCodigo('A', ES_SIN)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
    // Elegida a mano, la A se queda aunque no lo repercuta.
    const a = await deCodigo('A', ES_SIN);
    expect((await request(app).put(`/companies/${ES_SIN}/series/${a.id}`).send({ plantilla: 'A' })).body.data).toMatchObject({ plantilla: 'A', plantillaElegida: 'A' });
    await request(app).put(`/companies/${ES_SIN}/series/${a.id}`).send({ plantilla: null });
  });

  it('empresa espanola que no vende ceramica: su serie B sigue con la estandar; al marcarlo pasa a la B, y al quitarlo vuelve', async () => {
    const SIN_CER = `series-plant-sincer-${SUFIJO}`;
    await prisma.company.create({ data: { id: SIN_CER, name: 'Series Sin Ceramica SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await listarSeries(SIN_CER);
    await crearSerie(SIN_CER, { codigo: 'B', descripcion: 'Segunda linea', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
    expect(await deCodigo('B', SIN_CER)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
    await guardarAjustesFacturacion(SIN_CER, 'u-test', { vendeCeramica: true });
    expect(await deCodigo('B', SIN_CER)).toMatchObject({ plantilla: 'B', plantillaElegida: null });
    await guardarAjustesFacturacion(SIN_CER, 'u-test', { vendeCeramica: false });
    expect(await deCodigo('B', SIN_CER)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
    // Elegida a mano, la B se queda aunque no lo diga.
    const b = await deCodigo('B', SIN_CER);
    expect((await request(app).put(`/companies/${SIN_CER}/series/${b.id}`).send({ plantilla: 'B' })).body.data).toMatchObject({ plantilla: 'B', plantillaElegida: 'B' });
    // En una empresa extranjera la casilla no se guarda: su serie B sigue con la estandar.
    await guardarAjustesFacturacion(US, 'u-test', { vendeCeramica: true });
    expect(await deCodigo('B', US)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
  });

  it('el filtro por tipo tambien la trae', async () => {
    const res = await request(app).get(`/companies/${ES}/series?tipoDocumento=PROFORMA`);
    expect(res.body.data[0]).toMatchObject({ codigo: 'P', plantilla: 'default', plantillaElegida: null });
  });
});

describe('serie C', () => {
  it('una empresa nueva tiene A (predeterminada), C, R y P; la C de facturas, activa, sin ser la predeterminada', async () => {
    const series = await listar(ES_SIN);
    expect(series.map((s) => s.codigo).sort()).toEqual(['A', 'C', 'P', 'R']);
    expect(series.find((s) => s.codigo === 'A')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: true, activa: true });
    expect(series.find((s) => s.codigo === 'C')).toMatchObject({
      tipoDocumento: 'FACTURA',
      descripcion: 'Prestaciones de servicios',
      activa: true,
      porDefecto: false,
      plantilla: 'C',
      plantillaElegida: null,
      numeroSiguiente: 1,
    });
  });

  it('una empresa de antes la recibe al listar, con su numeracion desde 1 y sin tocar la de la A', async () => {
    expect(await prisma.invoiceSeries.count({ where: { companyId: VIEJA, codigo: 'C' } })).toBe(0);
    const series = await listar(VIEJA);
    expect(series.find((s) => s.codigo === 'C')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: false, activa: true, numeroSiguiente: 1 });
    expect(series.find((s) => s.codigo === 'A')).toMatchObject({ porDefecto: true, numeroSiguiente: 8 });
    // Idempotente: no se crea otra ni cambia nada al volver a listar.
    await listar(VIEJA);
    expect(await prisma.invoiceSeries.count({ where: { companyId: VIEJA, codigo: 'C' } })).toBe(1);
    expect(await prisma.invoiceSeries.count({ where: { companyId: VIEJA } })).toBe(4);
  });

  it('si el codigo C ya es otra serie (aqui, de proformas), no se crea ni se toca', async () => {
    const series = await listar(CON_C);
    const c = series.filter((s) => s.codigo === 'C');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ tipoDocumento: 'PROFORMA', descripcion: 'Proformas C', plantilla: 'C' });
    // Sus facturas tienen igual la A.
    expect(series.find((s) => s.codigo === 'A')).toMatchObject({ tipoDocumento: 'FACTURA', porDefecto: true });
  });

  it('crear otra serie C a mano: 409', async () => {
    const res = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'C', descripcion: 'Servicios', tipoDocumento: 'FACTURA', plantilla: 'C' });
    expect(res.status).toBe(409);
  });
});

describe('GET /series/plantillas', () => {
  type Item = { id: string; disponible: boolean; automaticaSerieA: boolean; seriesAutomaticas: string[] };
  it('catalogo completo; la A y la B no disponibles en una empresa extranjera', async () => {
    const es = (await request(app).get(`/companies/${ES}/series/plantillas`)).body.data;
    expect(es.map((p: Item) => [p.id, p.disponible])).toEqual([['default', true], ['A', true], ['B', true], ['C', true]]);
    expect(es[2]).toEqual({
      id: 'B',
      nombre: 'Plantilla B (cerámica)',
      descripcion: 'Palets, cajas, m², piezas, formato, calidad, peso, obra y cargo de palets, como la factura NZ013_2026',
      envases: false,
      ceramica: true,
      descuento: false,
      calculoIva: 'tipo',
      soloEmpresaEspanola: true,
      disenada: true,
      disponible: true,
      automaticaSerieA: false,
      seriesAutomaticas: ['B'],
    });
    expect(es[1]).toMatchObject({ id: 'A', envases: true, ceramica: false, descuento: false, disponible: true, automaticaSerieA: true, seriesAutomaticas: ['A'] });
    const us = (await request(app).get(`/companies/${US}/series/plantillas`)).body.data;
    expect(us.map((p: Item) => [p.id, p.disponible])).toEqual([['default', true], ['A', false], ['B', false], ['C', true]]);
    expect(us.map((p: Item) => [p.id, p.seriesAutomaticas])).toEqual([['default', ['A', 'B']], ['A', []], ['B', []], ['C', ['C']]]);
    // La automatica de la serie A: la A si se repercute el IEEPNR; la de la B, la B si se vende ceramica; si no, la estandar.
    const sin = (await request(app).get(`/companies/${ES_SIN}/series/plantillas`)).body.data;
    expect(sin.filter((p: Item) => p.automaticaSerieA).map((p: Item) => p.id)).toEqual(['default']);
    expect(sin.map((p: Item) => [p.id, p.seriesAutomaticas])).toEqual([['default', ['A', 'B']], ['A', []], ['B', []], ['C', ['C']]]);
  });

  it('la ven el contable, el comercial y el de solo lectura', async () => {
    for (const r of ['contable', 'ventas', 'solo_lectura']) {
      rol = r;
      expect((await request(app).get(`/companies/${ES}/series/plantillas`)).status).toBe(200);
    }
    rol = 'admin';
  });
});

describe('POST y PUT con plantilla', () => {
  it('PUT cambia la plantilla elegida; null vuelve a la automatica', async () => {
    const a = await deCodigo('A');
    let res = await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: 'default' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ codigo: 'A', plantilla: 'default', plantillaElegida: 'default' });
    const b = await deCodigo('B');
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ plantilla: 'A' });
    expect(res.body.data).toMatchObject({ codigo: 'B', plantilla: 'A', plantillaElegida: 'A' });
    res = await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: null });
    expect(res.body.data).toMatchObject({ plantilla: 'A', plantillaElegida: null });
    // Sin el campo, no se toca.
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ descripcion: 'Ceramica y materiales' });
    expect(res.body.data).toMatchObject({ plantilla: 'A', plantillaElegida: 'A', descripcion: 'Ceramica y materiales' });
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ plantilla: null });
    expect(res.body.data).toMatchObject({ plantilla: 'B', plantillaElegida: null });
  });

  it('POST crea la serie con su plantilla (la B, en otra serie)', async () => {
    const res = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'B2', descripcion: 'Ceramica obra', tipoDocumento: 'FACTURA', plantilla: 'B' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ codigo: 'B2', plantilla: 'B', plantillaElegida: 'B' });
    // Sin elegirla, una serie de otro codigo usa la estandar.
    const otra = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'B3', descripcion: 'Otra', tipoDocumento: 'FACTURA', activa: false });
    expect(otra.body.data).toMatchObject({ plantilla: 'default', plantillaElegida: null });
  });

  it('una plantilla que no existe: 400 PLANTILLA_NO_VALIDA en el campo plantilla', async () => {
    const a = await deCodigo('A');
    for (const plantilla of ['X', 'a', 7, 'B2']) {
      const res = await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla });
      expect([res.status, res.body.details]).toEqual([400, { codigo: 'PLANTILLA_NO_VALIDA', campo: 'plantilla' }]);
    }
    const res = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'D', tipoDocumento: 'FACTURA', plantilla: 'Z' });
    expect([res.status, res.body.details]).toEqual([400, { codigo: 'PLANTILLA_NO_VALIDA', campo: 'plantilla' }]);
    expect(await prisma.invoiceSeries.count({ where: { companyId: ES, codigo: 'D' } })).toBe(0);
  });

  it('la A y la B en una empresa extranjera: 400 PLANTILLA_SOLO_ESPANA', async () => {
    const a = await deCodigo('A', US);
    for (const plantilla of ['A', 'B']) {
      const res = await request(app).put(`/companies/${US}/series/${a.id}`).send({ plantilla });
      expect([res.status, res.body.details]).toEqual([400, { codigo: 'PLANTILLA_SOLO_ESPANA', campo: 'plantilla' }]);
      expect(String(res.body.message ?? res.body.error)).toContain(`plantilla ${plantilla}`);
    }
    // La C si se puede.
    const ok = await request(app).put(`/companies/${US}/series/${a.id}`).send({ plantilla: 'C' });
    expect(ok.body.data).toMatchObject({ plantilla: 'C', plantillaElegida: 'C' });
  });

  it('el contable no la cambia (403); el comercial si', async () => {
    const a = await deCodigo('A');
    rol = 'contable';
    expect((await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: 'default' })).status).toBe(403);
    rol = 'ventas';
    expect((await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: null })).status).toBe(200);
    rol = 'admin';
  });
});

describe('observaciones por defecto', () => {
  const TEXTO = 'ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE\r\nEL TRANSPORTE SE FACTURARA APARTE';
  it('PUT las guarda (saltos de linea normalizados), sin el campo no se tocan y null o vacio las quita', async () => {
    const b = await deCodigo('B');
    let res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ observacionesDefecto: `  ${TEXTO}  ` });
    expect(res.body.data.observacionesDefecto).toBe('ESTE PRESUPUESTO NO INCLUYE EL TRANSPORTE\nEL TRANSPORTE SE FACTURARA APARTE');
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ descripcion: 'Ceramica' });
    expect(res.body.data.observacionesDefecto).toContain('TRANSPORTE');
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ observacionesDefecto: '   ' });
    expect(res.body.data.observacionesDefecto).toBeNull();
    await request(app).put(`/companies/${ES}/series/${b.id}`).send({ observacionesDefecto: TEXTO });
    res = await request(app).put(`/companies/${ES}/series/${b.id}`).send({ observacionesDefecto: null });
    expect(res.body.data.observacionesDefecto).toBeNull();
  });

  it('POST las admite; mas de 2.000 caracteres o que no sea texto, 400 en su campo', async () => {
    const res = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'OBS', tipoDocumento: 'FACTURA', observacionesDefecto: 'Portes debidos' });
    expect(res.body.data).toMatchObject({ codigo: 'OBS', observacionesDefecto: 'Portes debidos' });
    for (const observacionesDefecto of ['x'.repeat(2001), 7]) {
      const r = await request(app).put(`/companies/${ES}/series/${res.body.data.id}`).send({ observacionesDefecto });
      expect([r.status, r.body.details?.campo]).toEqual([400, 'observacionesDefecto']);
    }
    const alta = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'OBS2', tipoDocumento: 'FACTURA', observacionesDefecto: 'x'.repeat(2001) });
    expect([alta.status, alta.body.details?.campo]).toEqual([400, 'observacionesDefecto']);
    expect(await prisma.invoiceSeries.count({ where: { companyId: ES, codigo: 'OBS2' } })).toBe(0);
  });
});

describe('serieCompatible', () => {
  it('con envases: la preferida o la predeterminada si admiten envases; si no, la primera con la A; si no hay, 400', async () => {
    expect(await serieParaEnvases(ES, 'A')).toBe('A');
    // La B es de ceramica: va a la predeterminada (A, con la plantilla A).
    expect(await serieParaEnvases(ES, 'B')).toBe('A');
    // Con la A en estandar y la C en la A, va a la C.
    const a = await deCodigo('A');
    const c = await deCodigo('C');
    await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: 'default' });
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: 'A' });
    expect(await serieParaEnvases(ES, 'B')).toBe('C');
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: null });
    await expect(serieParaEnvases(ES, 'B')).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'SIN_SERIE_ENVASES', campo: 'serie' } });
    await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: null });
  });

  it('con ceramica: la preferida o la predeterminada si son de la B; si no, la primera con la B; si no hay, 400 SIN_SERIE_CERAMICA', async () => {
    expect(await serieCompatible(ES, 'FACTURA', 'B', 'ceramica')).toBe('B');
    expect(await serieCompatible(ES, 'FACTURA', 'A', 'ceramica')).toBe('B');
    const b = await deCodigo('B');
    const b2 = await deCodigo('B2');
    await request(app).put(`/companies/${ES}/series/${b.id}`).send({ plantilla: 'default' });
    expect(await serieCompatible(ES, 'FACTURA', 'A', 'ceramica')).toBe('B2');
    await request(app).put(`/companies/${ES}/series/${b2.id}`).send({ plantilla: 'C' });
    await expect(serieCompatible(ES, 'FACTURA', 'A', 'ceramica')).rejects.toMatchObject({
      statusCode: 400,
      details: { codigo: 'SIN_SERIE_CERAMICA', campo: 'serie' },
    });
    await request(app).put(`/companies/${ES}/series/${b.id}`).send({ plantilla: null });
    await request(app).put(`/companies/${ES}/series/${b2.id}`).send({ plantilla: 'B' });
    // Proformas: la P es estandar.
    await expect(serieCompatible(ES, 'PROFORMA', 'P', 'ceramica')).rejects.toMatchObject({ details: { codigo: 'SIN_SERIE_CERAMICA' } });
  });

  it('con descuento: una serie cuya plantilla lo admita (ni la A ni la B); si no hay, 400', async () => {
    // A (plantilla A) es la predeterminada; B y B2, de ceramica; la C (servicios) si lo admite.
    expect(await serieCompatible(ES, 'FACTURA', 'C', 'descuento')).toBe('C');
    expect(await serieCompatible(ES, 'FACTURA', 'B', 'descuento')).toBe('C');
    expect(await serieCompatible(ES, 'FACTURA', 'A', 'descuento')).toBe('C');
    const c = await deCodigo('C');
    const obs = await deCodigo('OBS');
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: 'A' });
    await request(app).put(`/companies/${ES}/series/${obs.id}`).send({ plantilla: 'B' });
    await expect(serieCompatible(ES, 'FACTURA', 'A', 'descuento')).rejects.toMatchObject({
      statusCode: 400,
      details: { codigo: 'SIN_SERIE_DESCUENTO', campo: 'serie' },
    });
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: null });
    await request(app).put(`/companies/${ES}/series/${obs.id}`).send({ plantilla: null });
    // Proformas: la P es estandar.
    expect(await serieCompatible(ES, 'PROFORMA', 'P', 'descuento')).toBe('P');
    await expect(serieCompatible(ES, 'PROFORMA', 'P', 'envases')).rejects.toMatchObject({ details: { codigo: 'SIN_SERIE_ENVASES' } });
  });
});
