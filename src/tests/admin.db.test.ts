/**
 * Modo administrador global sobre BD real: empresas, usuarios, accesos por
 * empresa y protecciones (no quitarse el permiso a uno mismo, no dejar la
 * plataforma sin administrador, 403 para quien no lo es).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { actualizarUsuario } from '../services/admin.service';
import { hashPassword } from '../utils/password';

const SUFIJO = `${Date.now()}`;
const CONTRASENA = 'frase-de-prueba-larga-1';

let adminA: { id: string; email: string };
let tokenA: string;
let empresaId: string;
let usuarioId: string;
let emailUsuario: string;

const tokenDe = (userId: string, email: string, extra: Partial<Parameters<typeof authService.generateToken>[0]> = {}) =>
  authService.generateToken({ userId, email, roles: [], companies: [], ...extra });

const como = (token: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${token}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${token}`).send(body),
  put: (ruta: string, body: object = {}) => request(app).put(ruta).set('Authorization', `Bearer ${token}`).send(body),
  patch: (ruta: string, body: object = {}) => request(app).patch(ruta).set('Authorization', `Bearer ${token}`).send(body),
  delete: (ruta: string) => request(app).delete(ruta).set('Authorization', `Bearer ${token}`),
});

beforeAll(async () => {
  adminA = await prisma.user.create({
    data: { email: `admin-a-${SUFIJO}@test.local`, passwordHash: hashPassword(CONTRASENA), isGlobalAdmin: true },
    select: { id: true, email: true },
  });
  tokenA = tokenDe(adminA.id, adminA.email, { esAdminGlobal: true });
});

describe('Empresas', () => {
  it('crea una empresa y quien la crea queda como administrador de ella', async () => {
    const res = await como(tokenA).post('/admin/empresas', { nombre: '  Admin Test   SL ', codigo: `ADM${SUFIJO}` });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ nombre: 'Admin Test SL', codigo: `ADM${SUFIJO}`, activa: true, usuarios: 1 });
    empresaId = res.body.data.id;

    const m = await prisma.membership.findUnique({ where: { userId_companyId: { userId: adminA.id, companyId: empresaId } } });
    expect(String(m?.role)).toBe('admin');
    // Sin datos de FacturaScripts: nada de credenciales heredadas.
    const c = await prisma.company.findUniqueOrThrow({ where: { id: empresaId } });
    expect(c.fsBaseUrl).toBe('');
    expect(c.fsApiKeyEnc).toBe('');
  });

  it('no deja repetir el codigo ni crear sin nombre', async () => {
    expect((await como(tokenA).post('/admin/empresas', { nombre: 'Otra', codigo: `ADM${SUFIJO}` })).status).toBe(409);
    expect((await como(tokenA).post('/admin/empresas', { nombre: '   ' })).status).toBe(400);
    expect((await como(tokenA).post('/admin/empresas', { nombre: 'Con codigo malo', codigo: "x'; --" })).status).toBe(400);
  });

  it('la lista trae el NIF y el pais de los datos legales y el numero de usuarios', async () => {
    await prisma.legalConfig.create({ data: { companyId: empresaId, denominacion: 'Admin Test SL', nif: 'B99999999', pais: 'PT' } });
    const res = await como(tokenA).get('/admin/empresas');
    expect(res.status).toBe(200);
    const fila = res.body.data.find((e: { id: string }) => e.id === empresaId);
    expect(fila).toMatchObject({ nif: 'B99999999', pais: 'PT', denominacion: 'Admin Test SL', usuarios: 1 });
    expect(fila.creadoEn).toBeDefined();
    expect(JSON.stringify(res.body)).not.toMatch(/fsApiKey/);
  });

  it('renombra y desactiva sin borrar nada', async () => {
    const res = await como(tokenA).patch(`/admin/empresas/${empresaId}`, { nombre: 'Admin Test Renombrada', activa: false });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ nombre: 'Admin Test Renombrada', activa: false });
    const c = await prisma.company.findUniqueOrThrow({ where: { id: empresaId } });
    expect(c.isActive).toBe(false);
    expect(await prisma.membership.count({ where: { companyId: empresaId } })).toBe(1);

    expect((await como(tokenA).patch(`/admin/empresas/${empresaId}`, { activa: true })).status).toBe(200);
    expect((await como(tokenA).patch(`/admin/empresas/${empresaId}`, {})).status).toBe(400);
    expect((await como(tokenA).patch(`/admin/empresas/${empresaId}`, { activa: 'no' })).status).toBe(400);
    expect((await como(tokenA).patch('/admin/empresas/no-existe', { activa: true })).status).toBe(404);
  });
});

describe('Usuarios y accesos', () => {
  it('crea un usuario con acceso a una empresa y nunca devuelve el hash', async () => {
    emailUsuario = `usuario-${SUFIJO}@test.local`;
    const res = await como(tokenA).post('/admin/usuarios', {
      email: `  Usuario-${SUFIJO}@Test.LOCAL `,
      password: CONTRASENA,
      companyId: empresaId,
      rol: 'contable',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: emailUsuario, activo: true, esAdminGlobal: false });
    expect(res.body.data.empresas).toEqual([expect.objectContaining({ companyId: empresaId, rol: 'contable' })]);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|frase-de-prueba/);
    usuarioId = res.body.data.id;

    // Puede entrar con la contrasena inicial y ve la empresa.
    const login = await authService.login({ email: emailUsuario, password: CONTRASENA });
    expect(login.user.companies).toContain(empresaId);
  });

  it('valida email, contrasena, rol, empresa y duplicados', async () => {
    const base = { email: `otro-${SUFIJO}@test.local`, password: CONTRASENA };
    expect((await como(tokenA).post('/admin/usuarios', { ...base, password: 'corta' })).status).toBe(400);
    expect((await como(tokenA).post('/admin/usuarios', { ...base, email: 'no-es-email' })).status).toBe(400);
    expect((await como(tokenA).post('/admin/usuarios', { ...base, companyId: empresaId, rol: 'tesoreria' })).status).toBe(400);
    expect((await como(tokenA).post('/admin/usuarios', { ...base, rol: 'contable' })).status).toBe(400);
    expect((await como(tokenA).post('/admin/usuarios', { ...base, companyId: 'no-existe' })).status).toBe(404);
    expect((await como(tokenA).post('/admin/usuarios', { email: emailUsuario, password: CONTRASENA })).status).toBe(409);
    expect(await prisma.user.count({ where: { email: base.email } })).toBe(0);
  });

  it('cambia el rol, quita el acceso y lo vuelve a dar', async () => {
    const ruta = `/admin/usuarios/${usuarioId}/empresas/${empresaId}`;
    const cambio = await como(tokenA).put(ruta, { rol: 'ventas' });
    expect(cambio.status).toBe(200);
    expect(cambio.body.data).toMatchObject({ rol: 'ventas', rolAnterior: 'contable' });
    expect(String((await prisma.membership.findUnique({ where: { userId_companyId: { userId: usuarioId, companyId: empresaId } } }))?.role)).toBe('ventas');

    expect((await como(tokenA).put(ruta, { rol: 'tesoreria' })).status).toBe(400);

    expect((await como(tokenA).delete(ruta)).status).toBe(200);
    expect(await prisma.membership.findUnique({ where: { userId_companyId: { userId: usuarioId, companyId: empresaId } } })).toBeNull();
    expect((await como(tokenA).delete(ruta)).status).toBe(404);

    const otraVez = await como(tokenA).put(ruta, { rol: 'solo-lectura' });
    expect(otraVez.status).toBe(200);
    expect(otraVez.body.data).toMatchObject({ rol: 'solo_lectura', rolAnterior: null });

    expect((await como(tokenA).put(`/admin/usuarios/no-existe/empresas/${empresaId}`, { rol: 'ventas' })).status).toBe(404);
    expect((await como(tokenA).put(`/admin/usuarios/${usuarioId}/empresas/no-existe`, { rol: 'ventas' })).status).toBe(404);
  });

  it('la lista de usuarios trae sus empresas con el rol y sin hash', async () => {
    const res = await como(tokenA).get('/admin/usuarios');
    expect(res.status).toBe(200);
    const fila = res.body.data.find((u: { id: string }) => u.id === usuarioId);
    expect(fila.empresas).toEqual([expect.objectContaining({ companyId: empresaId, rol: 'solo_lectura', nombre: 'Admin Test Renombrada' })]);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
  });

  it('restablece la contrasena y desactiva / reactiva', async () => {
    const nueva = 'otra-frase-distinta-2';
    expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { nuevaContrasena: 'corta' })).status).toBe(400);
    expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { nuevaContrasena: nueva })).status).toBe(200);
    await expect(authService.login({ email: emailUsuario, password: CONTRASENA })).rejects.toMatchObject({ statusCode: 401 });
    await expect(authService.login({ email: emailUsuario, password: nueva })).resolves.toBeDefined();

    expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { activo: false })).body.data.activo).toBe(false);
    await expect(authService.login({ email: emailUsuario, password: nueva })).rejects.toMatchObject({ statusCode: 401 });
    expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { activo: true })).body.data.activo).toBe(true);
    expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, {})).status).toBe(400);
  });

  it('cada cambio queda en la auditoria, sin la contrasena', async () => {
    const logs = await prisma.auditLog.findMany({ where: { userId: adminA.id } });
    const acciones = new Set(logs.map((l) => l.action));
    for (const a of ['CREATE_EMPRESA', 'UPDATE_EMPRESA', 'CREATE_USUARIO', 'CAMBIAR_ROL_EMPRESA', 'QUITAR_USUARIO_EMPRESA', 'ASIGNAR_USUARIO_EMPRESA', 'UPDATE_USUARIO']) {
      expect(acciones).toContain(a);
    }
    expect(JSON.stringify(logs)).not.toMatch(/frase/);
  });
});

describe('Protecciones', () => {
  it('nadie se quita a si mismo el modo administrador ni se desactiva', async () => {
    expect((await como(tokenA).patch(`/admin/usuarios/${adminA.id}`, { esAdminGlobal: false })).status).toBe(400);
    expect((await como(tokenA).patch(`/admin/usuarios/${adminA.id}`, { activo: false })).status).toBe(400);
    const a = await prisma.user.findUniqueOrThrow({ where: { id: adminA.id } });
    expect(a.isGlobalAdmin).toBe(true);
    expect(a.isActive).toBe(true);
  });

  it('se puede nombrar a otro administrador y quitarselo; con el token viejo ya no entra', async () => {
    const b = await como(tokenA).post('/admin/usuarios', { email: `admin-b-${SUFIJO}@test.local`, password: CONTRASENA, esAdminGlobal: true });
    expect(b.status).toBe(201);
    const idB = b.body.data.id as string;
    const tokenB = tokenDe(idB, b.body.data.email, { esAdminGlobal: true });
    expect((await como(tokenB).get('/admin/empresas')).status).toBe(200);

    const quitar = await como(tokenA).patch(`/admin/usuarios/${idB}`, { esAdminGlobal: false });
    expect(quitar.status).toBe(200);
    expect(quitar.body.data.esAdminGlobal).toBe(false);
    // El token de B aun dice esAdminGlobal, pero la BD ya no: 403 al momento.
    expect((await como(tokenB).get('/admin/empresas')).status).toBe(403);
  });

  it('no deja la plataforma sin ningun administrador global activo', async () => {
    const otros = await prisma.user.count({ where: { isGlobalAdmin: true, isActive: true, id: { not: adminA.id } } });
    // En CI la base esta vacia y A es el unico administrador. En una base con
    // mas administradores no se puede comprobar sin tocarlos, y no se tocan.
    if (otros > 0) return;
    await expect(actualizarUsuario('actor-externo', adminA.id, { esAdminGlobal: false })).rejects.toMatchObject({ statusCode: 409 });
    await expect(actualizarUsuario('actor-externo', adminA.id, { activo: false })).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: adminA.id } })).isGlobalAdmin).toBe(true);
  });

  it('un usuario que no es administrador global recibe 403 aunque sea admin de una empresa', async () => {
    const t = tokenDe(usuarioId, emailUsuario, { roles: ['admin'], rolesPorEmpresa: { [empresaId]: ['admin'] }, companies: [empresaId] });
    expect((await como(t).get('/admin/empresas')).status).toBe(403);
    expect((await como(t).get('/admin/usuarios')).status).toBe(403);
    expect((await como(t).post('/admin/empresas', { nombre: 'Intrusa' })).status).toBe(403);
    expect((await como(t).patch(`/admin/usuarios/${usuarioId}`, { esAdminGlobal: true })).status).toBe(403);
    expect((await como(t).put(`/admin/usuarios/${usuarioId}/empresas/${empresaId}`, { rol: 'admin' })).status).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: usuarioId } })).isGlobalAdmin).toBe(false);
  });
});
