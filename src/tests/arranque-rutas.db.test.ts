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
    // Falta lo que se escribe a mano: el panel lo avisa.
    const aviso = datos(await request(app(['contabilidad:read'])).get('/arranque/aviso'));
    expect(aviso).toMatchObject({ nivel: 'FALTAN_DATOS', total: 4 });
  });

  it('lo que falta se completa después, cada cosa con su permiso, hasta que el panel deja de avisar', async () => {
    const lector = app(['contabilidad:read']);
    const c0 = datos(await request(lector).get('/arranque/2027/comprobaciones'));
    expect(c0).toMatchObject({ nivel: 'FALTAN_DATOS', completado: false, deBorrador: false, carga: { id: cargaId } });
    expect(c0.puntos.filter((p: { nivel: string }) => p.nivel === 'FALTA').map((p: { clave: string }) => p.clave)).toEqual(['bancos:extracto', 'bancos:cuenta', 'iva:303-4t', 'empresa:datos']);
    // Los bancos de la apertura vienen con la respuesta, para completarlos en pantalla.
    expect(c0.bancos).toEqual([expect.objectContaining({ subcuenta: '5720000001', saldoApertura: 18630, saldoExtracto: null, cuenta: null, aceptada: false })]);

    // Bancos: tesorería o contabilidad.
    const bancos = { '5720000001': { saldoExtracto: '18.600,00', nueva: { iban: 'ES91 2100 0418 4502 0005 1332', bancoNombre: 'Sabadell' } } };
    expect((await request(app(['tesoreria:read'])).put('/arranque/2027/bancos').send({ bancos })).status).toBe(403);
    // Con solo Contabilidad no se da de alta una cuenta bancaria (eso es de Tesorería).
    const sinTesoreria = await request(app(['contabilidad:write'])).put('/arranque/2027/bancos').send({ bancos });
    expect(sinTesoreria.status).toBe(403);
    expect(sinTesoreria.body.message).toMatch(/permiso de Tesorería/);
    expect(await prisma.bankAccount.count({ where: { companyId: E } })).toBe(0);
    const b = await request(app(['tesoreria:write'])).put('/arranque/2027/bancos').send({ bancos });
    expect(b.status).toBe(200);
    // 30 € de diferencia con la contabilidad: hay que aceptarlo o revisarlo.
    expect(datos(b).puntos.find((p: { clave: string }) => p.clave === 'bancos:diferencia')).toMatchObject({ nivel: 'FALTA' });
    const cuenta = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: E, subcuentaCodigo: '5720000001' } });
    expect(cuenta).toMatchObject({ iban: 'ES9121000418450200051332', saldoInicial: 18600, fechaSaldoInicial: '2026-12-31', saldoContableInicial: 18630 });
    const b2 = await request(app(['contabilidad:write'])).put('/arranque/2027/bancos').send({ bancos: { '5720000001': { saldoExtracto: 18600, aceptarDiferencia: true } } });
    expect(datos(b2).puntos.find((p: { clave: string }) => p.clave === 'bancos:transito')).toMatchObject({ nivel: 'INFO' });
    expect(datos(b2).bancos).toEqual([expect.objectContaining({ subcuenta: '5720000001', saldoExtracto: 18600, cuenta: 'ES9121000418450200051332', aceptada: true })]);
    expect((await request(app(['contabilidad:write'])).put('/arranque/2027/bancos').send({ bancos: { '5720000009': { saldoExtracto: 1 } } })).status).toBe(400);

    // 303 del 4T: impuestos o contabilidad.
    expect((await request(app(['impuestos:read'])).put('/arranque/2027/datos-fiscales').send({ resultado303T4: 1785 })).status).toBe(403);
    const f = await request(app(['impuestos:write'])).put('/arranque/2027/datos-fiscales').send({ resultado303T4: '1.785,00', basesNegativas: [{ ejercicio: 2024, importe: 500 }] });
    expect(f.status).toBe(200);
    expect(datos(f).puntos.some((p: { clave: string }) => p.clave.startsWith('iva:'))).toBe(false);
    expect(datos(f).datosFiscales).toMatchObject({ resultado303T4: 1785, basesNegativas: [{ ejercicio: 2024, importe: 500 }] });

    // Datos de la empresa: el aviso se acepta con un motivo (solo el administrador).
    expect((await request(app(['contabilidad:write'])).post('/arranque/2027/avisos/empresa:datos/aceptar').send({ motivo: 'Los pongo mañana' })).status).toBe(403);
    expect((await request(app(['*'])).post('/arranque/2027/avisos/empresa:datos/aceptar').send({ motivo: '' })).status).toBe(400);
    expect((await request(app(['*'])).post('/arranque/2027/avisos/no-existe/aceptar').send({ motivo: 'Porque sí' })).status).toBe(404);
    const ac = await request(app(['*'])).post('/arranque/2027/avisos/empresa:datos/aceptar').send({ motivo: 'Los pongo mañana' });
    expect(ac.status).toBe(200);
    expect(datos(ac)).toMatchObject({ nivel: 'CORRECTO', completado: true, aceptados: [{ clave: 'empresa:datos', motivo: 'Los pongo mañana', userId: 'u-rutas' }] });
    expect(datos(await request(lector).get('/arranque/aviso'))).toBeNull();
    expect(await prisma.auditLog.count({ where: { companyId: E, action: 'ARRANQUE_AVISO_ACEPTADO' } })).toBe(1);

    // Series de 2027: con permiso de Ventas.
    expect((await request(lector).post('/arranque/2027/series')).status).toBe(403);
    const s = await request(app(['ventas:write'])).post('/arranque/2027/series');
    expect(s.status).toBe(201);
    expect(datos(s).series).toEqual(['F2027', 'R2027']);
    expect(await prisma.invoiceSeries.findMany({ where: { companyId: E, porDefecto: true }, select: { codigo: true }, orderBy: { codigo: 'asc' } })).toEqual(
      expect.arrayContaining([{ codigo: 'F2027' }, { codigo: 'R2027' }]),
    );

    // 2026 no vuelve a la app con una carga importada.
    expect((await request(app(['contabilidad:write'])).post('/arranque/2027/ejercicios/llevanza')).status).toBe(403);
    expect((await request(app(['*'])).post('/arranque/2027/ejercicios/llevanza')).status).toBe(409);
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
    // Era el unico fichero: el borrador se borra (la pantalla vuelve al principio).
    expect(datos(q)).toEqual({ carga: null, borrada: true });
    expect((await request(escritor).delete(`/arranque/2027/cargas/${carga.id}/ficheros/${sha}`)).status).toBe(404);
  });

  it('deshacer: la vista previa con contabilidad:read; deshacerla, solo el administrador', async () => {
    const lector = app(['contabilidad:read']);
    const v = await request(lector).get(`/arranque/2027/cargas/${cargaId}/deshacer`);
    expect(v.status).toBe(200);
    expect(datos(v)).toMatchObject({ cargaId, puede: true });
    expect(datos(v).acciones.length).toBeGreaterThan(3);
    expect((await request(app(['contabilidad:read', 'contabilidad:write'])).delete(`/arranque/2027/cargas/${cargaId}`)).status).toBe(403);
    const admin = app(['*']);
    expect((await request(admin).delete(`/arranque/2027/cargas/${cargaId}`).send({ borrarFichas: 'todas' })).status).toBe(400);
    const s = await request(admin).delete(`/arranque/2027/cargas/${cargaId}?simular=1`);
    expect(s.status).toBe(200);
    expect((await prisma.cargaArranque.findUniqueOrThrow({ where: { id: cargaId } })).estado).toBe('CONFIRMADA');
    const d = await request(admin).delete(`/arranque/2027/cargas/${cargaId}`).send({ devolverAsientos2026: true });
    expect(d.status).toBe(200);
    expect(datos(d).hecho).toBe('Carga 1 deshecha.');
    expect(datos(await request(lector).get('/arranque/2027')).vigente).toBeNull();
    expect((await request(admin).delete(`/arranque/2027/cargas/${cargaId}`)).status).toBe(409);
  });

  it('una empresa de EE. UU. no trae contabilidad de gestoría española', async () => {
    const r = await request(app(['*'], EXT)).post('/arranque/2027/cargas').attach('archivos', a.plan.contenido, a.plan.nombre);
    expect(r.status).toBe(400);
  });
});
