/**
 * Permisos de lo que viene con «Traer la contabilidad de 2026», por la API:
 *  - facturas de 2026 pendientes: Ventas ve las de cobro, Compras las de
 *    pago, Tesoreria y Contabilidad las dos; cobrar, pagar, anular y casar
 *    con el banco piden tesoreria:write;
 *  - inmovilizado: leer con contabilidad:read y cambiar con contabilidad:write;
 *  - deshacer: la vista previa con contabilidad:read; deshacer, el
 *    administrador de la empresa.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { errorMiddleware } from '../middleware/error.middleware';
import arranqueRoutes from '../routes/arranque.routes';
import bancosRoutes from '../routes/bancos.routes';
import inmovilizadoRoutes from '../routes/inmovilizado.routes';
import periodosRoutes from '../routes/periodos.routes';
import { AJUSTES_A, ficherosEmpresaA } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga } from './fixtures/arranque/importar';

const E = `arr-perm-${Date.now()}`;

function app(permisos: string[]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-perm', email: 'u@test.local', roles: ['x'], companies: [E], rolesPorEmpresa: { [E]: ['x'] }, permisosPorEmpresa: { [E]: permisos } } as never;
    req.companyId = E;
    next();
  });
  a.use('/arranque', arranqueRoutes);
  a.use('/bancos', bancosRoutes);
  a.use('/inmovilizado', inmovilizadoRoutes);
  a.use('/periodos', periodosRoutes);
  a.use(errorMiddleware);
  return a;
}
const datos = (r: request.Response) => ('data' in r.body ? r.body.data : r.body);
const tipos = (r: request.Response) => [...new Set((datos(r).partidas as Array<{ tipo: string }>).map((p) => p.tipo))].sort();

let cargaId = '';
beforeAll(async () => {
  await empresaDePrueba(E);
  cargaId = (await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A)).r.carga.id;
}, 120_000);

describe('facturas de 2026 pendientes', () => {
  it('cada uno ve el lado que le toca', async () => {
    expect(tipos(await request(app(['ventas:read'])).get('/arranque/partidas'))).toEqual(['COBRO']);
    expect(tipos(await request(app(['compras:read'])).get('/arranque/partidas'))).toEqual(['PAGO']);
    expect(tipos(await request(app(['tesoreria:read'])).get('/arranque/partidas'))).toEqual(['COBRO', 'PAGO']);
    expect(tipos(await request(app(['contabilidad:read'])).get('/arranque/partidas'))).toEqual(['COBRO', 'PAGO']);
    // Pedir el otro lado no lo enseña.
    expect(datos(await request(app(['ventas:read'])).get('/arranque/partidas?tipo=PAGO')).partidas).toEqual([]);
    expect((await request(app(['nominas:read'])).get('/arranque/partidas')).status).toBe(403);
    const pago = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, tipo: 'PAGO' } });
    expect((await request(app(['ventas:read'])).get(`/arranque/partidas/${pago.id}`)).status).toBe(404);
    expect((await request(app(['compras:read'])).get(`/arranque/partidas/${pago.id}`)).status).toBe(200);
  });

  it('cobrar, anular y casar con el banco: tesoreria:write', async () => {
    const beta = await prisma.partidaPendiente.findFirstOrThrow({ where: { companyId: E, numeroDocumento: 'A-2026-002' } });
    expect((await request(app(['ventas:write', 'tesoreria:read'])).post(`/arranque/partidas/${beta.id}/liquidar`).send({ fecha: '2027-01-20', importe: 50 })).status).toBe(403);
    const r = await request(app(['tesoreria:write'])).post(`/arranque/partidas/${beta.id}/liquidar`).send({ fecha: '2027-01-20', importe: 50 });
    expect(r.status).toBe(201);
    expect(datos(r).partida).toMatchObject({ estado: 'PARCIAL', pendiente: 6000 });
    const pagoId = datos(r).liquidacion.id;
    expect((await request(app(['tesoreria:read'])).post(`/arranque/partidas/liquidaciones/${pagoId}/anular`)).status).toBe(403);
    const a = await request(app(['tesoreria:write'])).post(`/arranque/partidas/liquidaciones/${pagoId}/anular`);
    expect(a.status).toBe(200);
    expect(datos(a).partida.estado).toBe('PENDIENTE');

    const banco = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: E } });
    const mov = await prisma.bankMovement.create({ data: { companyId: E, cuentaBancariaId: banco.id, fecha: '2027-01-21', importe: 6050, concepto: 'Transferencia Beta', origen: 'CSV' } });
    expect((await request(app(['tesoreria:read'])).post(`/bancos/movimientos/${mov.id}/conciliar-partida`).send({ partidaId: beta.id })).status).toBe(403);
    expect((await request(app(['tesoreria:write'])).post(`/bancos/movimientos/${mov.id}/conciliar-partida`).send({})).status).toBe(400);
    const c = await request(app(['tesoreria:write'])).post(`/bancos/movimientos/${mov.id}/conciliar-partida`).send({ partidaId: beta.id });
    expect(c.status).toBe(201);
    expect(datos(c).partida.estado).toBe('LIQUIDADA');
  });

  it('con un cobro de 2027, la carga no se deshace (409 con la lista)', async () => {
    const v = await request(app(['contabilidad:read'])).get(`/arranque/2027/cargas/${cargaId}/deshacer`);
    expect(datos(v).puede).toBe(false);
    const d = await request(app(['*'])).delete(`/arranque/2027/cargas/${cargaId}`);
    expect(d.status).toBe(409);
  });
});

describe('inmovilizado', () => {
  it('leer con contabilidad:read; dar de alta y amortizar con contabilidad:write', async () => {
    const l = await request(app(['contabilidad:read'])).get('/inmovilizado');
    expect(l.status).toBe(200);
    expect(datos(l).activos).toHaveLength(2);
    expect((await request(app(['ventas:read'])).get('/inmovilizado')).status).toBe(403);
    const alta = { descripcion: 'Portátil', subcuentaBien: '2170000000', fechaAlta: '2027-01-15', coste: 1200, vidaUtil: 4 };
    expect((await request(app(['contabilidad:read'])).post('/inmovilizado').send(alta)).status).toBe(403);
    expect((await request(app(['contabilidad:write'])).post('/inmovilizado').send(alta)).status).toBe(201);
    expect((await request(app(['contabilidad:read'])).post('/inmovilizado/dotaciones').send({ hasta: '2027-01' })).status).toBe(403);
    const d = await request(app(['contabilidad:write'])).post('/inmovilizado/dotaciones').send({ hasta: '2027-01' });
    expect(d.status).toBe(200);
    expect(datos(d).meses).toHaveLength(1);
  });

  it('al bloquear un mes, avisa (sin frenar) de la amortización que falta hasta ese mes', async () => {
    const contable = app(['contabilidad:read', 'contabilidad:write']);
    const marzo = await request(contable).put('/periodos/3/estado?ejercicio=2027').send({ estado: 'bloqueado' });
    expect(marzo.status).toBe(200);
    expect(datos(marzo).estado).toBe('bloqueado');
    expect(datos(marzo).avisoAmortizacion).toMatch(/^Falta por apuntar la amortización de 2 meses \(de 02\/2027 a 03\/2027\): [\d.,]+\s€\. Calcúlala en Contabilidad > Inmovilizado\.$/);
    const enero = await request(contable).put('/periodos/1/estado?ejercicio=2027').send({ estado: 'bloqueado' });
    expect(datos(enero).avisoAmortizacion).toBeUndefined();
    for (const mes of [1, 3]) await request(contable).put(`/periodos/${mes}/estado?ejercicio=2027`).send({ estado: 'abierto' });
  });
});
