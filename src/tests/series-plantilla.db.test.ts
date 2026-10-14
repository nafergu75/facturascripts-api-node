/**
 * Plantilla de cada serie (Configuracion > Series), sobre BD real.
 *
 *  - Automatica: la serie A de una empresa espanola usa la plantilla A; B, R,
 *    P y RT, la estandar; en una empresa de EE. UU., todas la estandar.
 *  - GET /series/plantillas: el catalogo, con la A no disponible fuera de Espana.
 *  - POST y PUT con plantillas validas y no validas (400 con su campo).
 *  - Permisos: la lista la ve el contable; cambiarla, solo quien factura.
 *  - serieParaEnvases: a que serie van duplicar y pasar a factura con envases.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import seriesRoutes from '../routes/series.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { crearSerie, listarSeries, serieParaEnvases } from '../services/series.service';

const SUFIJO = Date.now();
const ES = `series-plant-es-${SUFIJO}`;
const US = `series-plant-us-${SUFIJO}`;

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

type SerieResp = { id: string; codigo: string; plantilla: string; plantillaElegida: string | null };
const listar = async (empresa = ES): Promise<SerieResp[]> => (await request(app).get(`/companies/${empresa}/series`)).body.data;
const deCodigo = async (codigo: string, empresa = ES) => (await listar(empresa)).find((s) => s.codigo === codigo)!;

beforeAll(async () => {
  for (const [id, name] of [[ES, 'Series Plantilla SL'], [US, 'Series Template Inc']]) {
    await prisma.company.create({ data: { id, name, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  await prisma.legalConfig.create({ data: { companyId: US, denominacion: 'Series Template Inc', nif: '12-3456789', pais: 'US', monedaCuenta: 'USD' } });
  // Primero las series de siempre (A, R y P): la semilla solo se crea en un tipo sin series.
  await listarSeries(ES);
  await listarSeries(US);
  await crearSerie(ES, { codigo: 'B', descripcion: 'Ceramica', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  await crearSerie(ES, { codigo: 'RT', descripcion: 'Tickets', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true });
});

describe('plantilla automatica', () => {
  it('empresa espanola: la A usa la plantilla A; B, R, P y RT la estandar', async () => {
    const series = await listar();
    const por = Object.fromEntries(series.map((s) => [s.codigo, [s.plantilla, s.plantillaElegida]]));
    expect(por).toMatchObject({ A: ['A', null], B: ['default', null], R: ['default', null], P: ['default', null], RT: ['default', null] });
  });

  it('empresa de EE. UU.: la A queda en la estandar', async () => {
    expect(await deCodigo('A', US)).toMatchObject({ plantilla: 'default', plantillaElegida: null });
  });

  it('el filtro por tipo tambien la trae', async () => {
    const res = await request(app).get(`/companies/${ES}/series?tipoDocumento=PROFORMA`);
    expect(res.body.data[0]).toMatchObject({ codigo: 'P', plantilla: 'default', plantillaElegida: null });
  });
});

describe('GET /series/plantillas', () => {
  it('catalogo completo; la A no disponible en una empresa extranjera', async () => {
    const es = (await request(app).get(`/companies/${ES}/series/plantillas`)).body.data;
    expect(es.map((p: { id: string; disponible: boolean }) => [p.id, p.disponible])).toEqual([['default', true], ['A', true], ['B', true], ['C', true]]);
    expect(es[1]).toEqual({
      id: 'A',
      nombre: 'Plantilla A (envases)',
      descripcion: 'Packs, unidades, kg de plástico e IEEPNR, como la factura NZ004_26',
      envases: true,
      calculoIva: 'tipo',
      soloEmpresaEspanola: true,
      disponible: true,
    });
    const us = (await request(app).get(`/companies/${US}/series/plantillas`)).body.data;
    expect(us.find((p: { id: string }) => p.id === 'A').disponible).toBe(false);
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
    await request(app).put(`/companies/${ES}/series/${b.id}`).send({ plantilla: null });
  });

  it('POST crea la serie con su plantilla', async () => {
    const res = await request(app).post(`/companies/${ES}/series`).send({ codigo: 'C', descripcion: 'Servicios', tipoDocumento: 'FACTURA', plantilla: 'C' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ codigo: 'C', plantilla: 'C', plantillaElegida: 'C' });
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

  it('la A en una empresa extranjera: 400 PLANTILLA_SOLO_ESPANA', async () => {
    const a = await deCodigo('A', US);
    const res = await request(app).put(`/companies/${US}/series/${a.id}`).send({ plantilla: 'A' });
    expect([res.status, res.body.details]).toEqual([400, { codigo: 'PLANTILLA_SOLO_ESPANA', campo: 'plantilla' }]);
    expect(res.body.message ?? res.body.error).toBeTruthy();
    // La B si se puede.
    const ok = await request(app).put(`/companies/${US}/series/${a.id}`).send({ plantilla: 'B' });
    expect(ok.body.data).toMatchObject({ plantilla: 'B', plantillaElegida: 'B' });
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

describe('serieParaEnvases', () => {
  it('la preferida o la predeterminada si admiten envases; si no, la primera con la A; si no hay, 400', async () => {
    expect(await serieParaEnvases(ES, 'A')).toBe('A');
    // La B es estandar: va a la predeterminada (A, con la plantilla A).
    expect(await serieParaEnvases(ES, 'B')).toBe('A');
    // Con la A en estandar y la C en la A, va a la C.
    const a = await deCodigo('A');
    const c = await deCodigo('C');
    await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: 'default' });
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: 'A' });
    expect(await serieParaEnvases(ES, 'B')).toBe('C');
    await request(app).put(`/companies/${ES}/series/${c.id}`).send({ plantilla: 'C' });
    await expect(serieParaEnvases(ES, 'B')).rejects.toMatchObject({ statusCode: 400, details: { codigo: 'SIN_SERIE_ENVASES', campo: 'serie' } });
    await request(app).put(`/companies/${ES}/series/${a.id}`).send({ plantilla: null });
  });
});
