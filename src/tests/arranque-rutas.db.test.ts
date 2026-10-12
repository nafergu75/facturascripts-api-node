/**
 * Rutas de «Traer la contabilidad de 2026» y sus permisos: leer con
 * contabilidad:read, subir y analizar con contabilidad:write, confirmar e
 * importar solo el administrador de la empresa. Ficheros por multipart
 * («archivos») o por subidas en trozos («subidaIds»). Aviso del panel.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import arranqueRoutes from '../routes/arranque.routes';
import puestaEnMarchaRoutes from '../routes/puestaEnMarcha.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { ficherosEmpresaA } from './fixtures/arranque/generar';

const SUFIJO = Date.now();
const E = `arr-rutas-${SUFIJO}`;
const EXT = `arr-rutas-us-${SUFIJO}`;

function app(permisos: string[], empresa = E) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-rutas', email: 'u@test.local', roles: ['x'], companies: [empresa], rolesPorEmpresa: { [empresa]: ['x'] }, permisosPorEmpresa: { [empresa]: permisos } } as never;
    req.companyId = empresa;
    next();
  });
  a.use('/arranque', arranqueRoutes);
  a.use('/puesta-en-marcha', puestaEnMarchaRoutes);
  a.use(errorMiddleware);
  return a;
}

const datos = (r: request.Response) => ('data' in r.body ? r.body.data : r.body);

beforeAll(async () => {
  for (const [id, pais] of [
    [E, 'ES'],
    [EXT, 'US'],
  ]) {
    await prisma.company.create({ data: { id, name: `Rutas ${id}`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Rutas ${id}`, nif: 'B10000000', pais } });
  }
});

describe('rutas y permisos', () => {
  const a = ficherosEmpresaA();
  let cargaId = '';
  let huella = '';

  it('el aviso del panel invita a traer la contabilidad antes de dar de alta terceros; a una empresa de EE. UU., no', async () => {
    const r = await request(app(['contabilidad:read'])).get('/arranque/aviso');
    expect(r.status).toBe(200);
    expect(datos(r)).toMatchObject({ nivel: 'INVITACION', enlace: '/dashboard/contabilidad/arranque' });
    expect(datos(await request(app(['contabilidad:read'], EXT)).get('/arranque/aviso'))).toBeNull();
    expect((await request(app(['ventas:read'])).get('/arranque/aviso')).status).toBe(403);
  });

  it('solo lectura no sube; contabilidad:write sube por multipart y por trozos, y analiza', async () => {
    const lector = app(['contabilidad:read']);
    expect((await request(lector).post('/arranque/2027/cargas').attach('archivos', a.plan.contenido, a.plan.nombre)).status).toBe(403);
    expect((await request(lector).get('/arranque/2027')).status).toBe(200);

    const escritor = app(['contabilidad:read', 'contabilidad:write']);
    // El diario, por trozos (como los ficheros grandes).
    const trozo = await request(escritor)
      .post('/puesta-en-marcha/subidas')
      .field('indice', '0')
      .field('total', '1')
      .field('nombre', a.diario.nombre)
      .field('tamano', String(a.diario.contenido.length))
      .attach('trozo', a.diario.contenido, 'trozo');
    expect(trozo.status).toBe(201);
    const r = await request(escritor)
      .post('/arranque/2027/cargas')
      .field('subidaIds', JSON.stringify([datos(trozo).subidaId]))
      .field('ajustes', JSON.stringify({ resultadoDeclarado: 7200 }))
      .attach('archivos', a.plan.contenido, a.plan.nombre)
      .attach('archivos', a.sumasSaldos.contenido, a.sumasSaldos.nombre)
      .attach('archivos', a.clientes.contenido, a.clientes.nombre)
      .attach('archivos', a.proveedores.contenido, a.proveedores.nombre)
      .attach('archivos', a.cartera.contenido, a.cartera.nombre);
    expect(r.status).toBe(201);
    const d = datos(r);
    expect(d.carga.ficheros).toHaveLength(6);
    // Sin permiso de Ventas ni Compras, las fichas nuevas quedan pendientes.
    expect(d.vista.terceros.resumen).toMatchObject({ crear: 0, pendientes: 6 });
    cargaId = d.carga.id;

    const conAltas = app(['contabilidad:read', 'contabilidad:write', 'ventas:write', 'compras:write']);
    const r2 = await request(conAltas).post(`/arranque/2027/cargas/${cargaId}/analizar`).send({ ajustes: { tipoCarga: 'PROVISIONAL' } });
    expect(r2.status).toBe(200);
    expect(datos(r2).vista.terceros.resumen).toMatchObject({ crear: 6 });
    huella = datos(r2).vista.huella;
    // Un fichero que no es un listado no se admite.
    const raro = await request(escritor).post('/arranque/2027/cargas').attach('archivos', Buffer.from('x'), 'virus.exe');
    expect(raro.status).toBe(400);
    // Solo 2027.
    expect((await request(escritor).get('/arranque/2026')).status).toBe(400);
  });

  it('confirmar e importar es del administrador de la empresa', async () => {
    const escritor = app(['contabilidad:read', 'contabilidad:write', 'ventas:write', 'compras:write']);
    expect((await request(escritor).post(`/arranque/2027/cargas/${cargaId}/confirmar`).send({ huella })).status).toBe(403);
    const admin = app(['*']);
    // El administrador analiza con todos los permisos: el resumen es el mismo que vio quien tenía Ventas y Compras.
    const c = await request(admin).post(`/arranque/2027/cargas/${cargaId}/confirmar`).send({ huella });
    expect(c.status).toBe(200);
    expect((await request(escritor).post(`/arranque/2027/cargas/${cargaId}/aplicar`)).status).toBe(403);
    let terminada = false;
    for (let i = 0; i < 20 && !terminada; i++) {
      const f = await request(admin).post(`/arranque/2027/cargas/${cargaId}/aplicar`);
      expect(f.status).toBe(200);
      terminada = datos(f).terminada;
    }
    expect(terminada).toBe(true);
    const estado = datos(await request(app(['contabilidad:read'])).get('/arranque/2027'));
    expect(estado.vigente).toMatchObject({ id: cargaId, estado: 'CONFIRMADA' });
    expect(estado.llevanzaAnterior).toBe('EXTERNA');
    // Todo correcto: el panel ya no avisa (ni invita).
    expect(datos(await request(app(['contabilidad:read'])).get('/arranque/aviso'))).toBeNull();
  });

  it('quitar un fichero del borrador', async () => {
    const escritor = app(['contabilidad:read', 'contabilidad:write']);
    const r = await request(escritor).post('/arranque/2027/cargas').attach('archivos', a.inmovilizado.contenido, a.inmovilizado.nombre);
    expect(r.status).toBe(201);
    const { carga } = datos(r);
    expect(carga.version).toBe(2);
    const sha = carga.ficheros[0].sha256;
    const q = await request(escritor).delete(`/arranque/2027/cargas/${carga.id}/ficheros/${sha}`);
    expect(q.status).toBe(200);
    expect(datos(q).carga.ficheros).toEqual([]);
    expect((await request(escritor).delete(`/arranque/2027/cargas/${carga.id}/ficheros/${sha}`)).status).toBe(404);
  });

  it('una empresa de EE. UU. no trae contabilidad de gestoría española', async () => {
    const r = await request(app(['*'], EXT)).post('/arranque/2027/cargas').attach('archivos', a.plan.contenido, a.plan.nombre);
    expect(r.status).toBe(400);
  });
});
