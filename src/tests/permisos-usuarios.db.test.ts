/**
 * Permisos a medida por usuario y empresa, y contraseña provisional (BD real).
 *
 * Lo que se prueba aquí es lo que tiene que aguantar un intento de saltárselo:
 * escalar privilegios por el cuerpo de la petición o tocando la columna a mano,
 * que un administrador de empresa gestione usuarios, o usar la app con la
 * contraseña provisional sin cambiarla antes.
 *
 * Crea un administrador global: solo corre en CI o contra una BD local. Las
 * contraseñas se generan en cada ejecución y al terminar se borra lo creado.
 * Límite de /auth/cambiar-contrasena (10/min por IP): aquí hay 5 llamadas.
 */
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService, huellaContrasena } from '../services/auth.service';
import { controlCif } from '../utils/nif';
import { authMiddleware } from '../middleware/auth.middleware';
import { construirContexto } from '../services/carmen/contexto';
import { areasDePerfil, permisosDeAreas, type Areas } from '../services/rbac.service';
import { DIAS_CONTRASENA_PROVISIONAL, hashPassword, MENSAJE_PROVISIONAL_CADUCADA, verifyPassword } from '../utils/password';
import type { AuthUser } from '../types/express';

function hostDeLaBd(): string {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
}
const BD_DE_PRUEBAS = process.env.CI === 'true' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostDeLaBd());
const describeBd = BD_DE_PRUEBAS ? describe : describe.skip;

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const nuevaContrasena = () => randomBytes(18).toString('base64url');
const CONTRASENA = nuevaContrasena();
const CODIGO = 'CAMBIO_CONTRASENA_OBLIGATORIO';

const NADA: Areas = { ventas: 'ninguno', compras: 'ninguno', contabilidad: 'ninguno', tesoreria: 'ninguno', impuestos: 'ninguno', nominas: 'ninguno' };
const TODO: Areas = { ventas: 'modificar', compras: 'modificar', contabilidad: 'modificar', tesoreria: 'modificar', impuestos: 'modificar', nominas: 'modificar' };
const CONTABLE = areasDePerfil('contable')!;

const como = (token: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${token}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${token}`).send(body),
  put: (ruta: string, body: object = {}) => request(app).put(ruta).set('Authorization', `Bearer ${token}`).send(body),
  patch: (ruta: string, body: object = {}) => request(app).patch(ruta).set('Authorization', `Bearer ${token}`).send(body),
});

let G: { id: string; email: string };
let tokenG: string;
let E: string;
let E2: string;
let U: { id: string; email: string };
let contrasenaU = CONTRASENA;
let tokenU: string;
let adminE: { id: string; email: string };

const tokenConHuella = async (userId: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, passwordHash: true, isGlobalAdmin: true } });
  return authService.generateToken({ userId, email: u.email, roles: [], companies: [], esAdminGlobal: u.isGlobalAdmin, huellaContrasena: huellaContrasena(u.passwordHash) });
};

const columnaDe = async (userId: string, companyId: string) =>
  (await prisma.membership.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { permisosPersonalizados: true } }))?.permisosPersonalizados ?? null;

const accesoU = (body: object) => como(tokenG).put(`/admin/usuarios/${U.id}/empresas/${E}`, body);

/** Crea un usuario de prueba con su contraseña (no provisional) y, si se indica, un acceso. */
async function usuarioDePrueba(nombre: string, acceso?: { companyId: string; role: 'admin' | 'contable' | 'ventas' | 'solo_lectura' }) {
  const u = await prisma.user.create({
    data: {
      email: `${nombre}-${SUFIJO}@test.local`,
      passwordHash: hashPassword(CONTRASENA),
      ...(acceso ? { memberships: { create: { companyId: acceso.companyId, role: acceso.role } } } : {}),
    },
    select: { id: true, email: true },
  });
  return u;
}

describeBd('permisos a medida y contraseña provisional (BD real)', () => {
  beforeAll(async () => {
    const empresa = (n: string) =>
      prisma.company.create({ data: { name: `Permisos ${n} ${SUFIJO}`, fsBaseUrl: '', fsApiKeyEnc: '', isActive: true }, select: { id: true } });
    E = (await empresa('E')).id;
    E2 = (await empresa('E2')).id;
    G = await prisma.user.create({
      data: { email: `g-${SUFIJO}@test.local`, passwordHash: hashPassword(CONTRASENA), isGlobalAdmin: true, debeCambiarContrasena: false },
      select: { id: true, email: true },
    });
    tokenG = await tokenConHuella(G.id);
    U = await usuarioDePrueba('u', { companyId: E, role: 'contable' });
    tokenU = (await authService.login({ email: U.email, password: CONTRASENA })).token;
    adminE = await usuarioDePrueba('admin-e', { companyId: E, role: 'admin' });
  });

  afterAll(async () => {
    const usuarios = await prisma.user.findMany({ where: { email: { endsWith: `-${SUFIJO}@test.local` } }, select: { id: true } });
    const ids = usuarios.map((u) => u.id);
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false, isGlobalAdmin: false } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { companyId: { in: [E, E2] } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.customer.deleteMany({ where: { companyId: { in: [E, E2] } } });
    await prisma.company.deleteMany({ where: { id: { in: [E, E2] } } });
  });

  describe('Permisos a medida', () => {
    it('1. guarda la lista canónica y el panel la enseña como personalizada', async () => {
      const areas = { ...CONTABLE, compras: 'ninguno' as const };
      const res = await accesoU({ rol: 'contable', areas });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ rol: 'contable', rolAnterior: 'contable', personalizado: true, areas, areasAnteriores: CONTABLE, cambiado: true });
      expect(await columnaDe(U.id, E)).toEqual(permisosDeAreas(areas));

      const lista = await como(tokenG).get('/admin/usuarios');
      const fila = lista.body.data.find((u: { id: string }) => u.id === U.id);
      expect(fila.debeCambiarContrasena).toBe(false);
      expect(fila.empresas).toEqual([expect.objectContaining({ companyId: E, rol: 'contable', personalizado: true, areas })]);
    });

    it('2. si las áreas coinciden con el perfil, no es personalizado y la columna queda NULL', async () => {
      const res = await accesoU({ rol: 'contable', areas: CONTABLE });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ personalizado: false, areas: CONTABLE });
      expect(await columnaDe(U.id, E)).toBeNull();
    });

    it('3. «Volver al perfil» deja NULL y audita CAMBIAR_PERMISOS_EMPRESA con lo de antes', async () => {
      await accesoU({ rol: 'contable', areas: { ...CONTABLE, nominas: 'ninguno' } });
      const res = await accesoU({ rol: 'contable', areas: null });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ personalizado: false, cambiado: true });
      expect(await columnaDe(U.id, E)).toBeNull();
      const log = await prisma.auditLog.findFirst({ where: { userId: G.id, resourceId: U.id, action: 'CAMBIAR_PERMISOS_EMPRESA' }, orderBy: { timestamp: 'desc' } });
      expect(log?.meta).toMatchObject({ rol: 'contable', personalizado: false, personalizadoAntes: true, areasAnteriores: { ...CONTABLE, nominas: 'ninguno' } });
    });

    it('4. surte efecto en la siguiente petición, con la sesión ya abierta', async () => {
      await accesoU({ rol: 'contable', areas: { ...CONTABLE, compras: 'ninguno' } });
      expect((await como(tokenU).get(`/companies/${E}/expense-invoices`)).status).toBe(403);
      expect((await como(tokenU).get(`/companies/${E}/proveedores`)).status).toBe(200); // lo cubre Ver Contabilidad

      await accesoU({ rol: 'contable', areas: { ...CONTABLE, compras: 'ninguno', contabilidad: 'ninguno' } });
      const sinContabilidad = await como(tokenU).get(`/companies/${E}/proveedores`);
      expect(sinContabilidad.status).toBe(403);
      expect(sinContabilidad.body.message).toBe('No tienes permiso para esto en esta empresa. Si lo necesitas, pídeselo al administrador.');

      await accesoU({ rol: 'contable', areas: null });
      expect((await como(tokenU).get(`/companies/${E}/proveedores`)).status).toBe(200);
    });

    it('5. Modificar implica Ver; las lecturas de otras áreas se cierran', async () => {
      await accesoU({ rol: 'contable', areas: { ...NADA, ventas: 'modificar' } });
      expect((await como(tokenU).get(`/companies/${E}/clientes`)).status).toBe(200);
      expect((await como(tokenU).get(`/companies/${E}/bancos/cuentas`)).status).toBe(200);
      const alta = await como(tokenU).post(`/companies/${E}/clientes`, { nombreFiscal: `Cliente ${SUFIJO}`, nifCif: `B1234567${controlCif('1234567').cifra}` });
      expect(alta.status).not.toBe(403);
      expect(alta.status).toBeLessThan(300);
      expect((await como(tokenU).get(`/companies/${E}/expense-invoices`)).status).toBe(403);
      expect((await como(tokenU).get(`/companies/${E}/movements`)).status).toBe(403);
      await accesoU({ rol: 'contable', areas: null });
    });

    it('6. por el cuerpo no se cuela ningún permiso: claves de más, niveles raros o códigos sueltos', async () => {
      await accesoU({ rol: 'contable', areas: { ...CONTABLE, compras: 'ninguno' } });
      const antes = await columnaDe(U.id, E);
      for (const extra of ['admin', 'configuracion', '*']) {
        const res = await accesoU({ rol: 'contable', areas: { ...CONTABLE, [extra]: 'modificar' } });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ message: 'Las áreas no son válidas.', details: { campo: 'areas' } });
      }
      expect((await accesoU({ rol: 'contable', areas: { ...CONTABLE, ventas: 'todo' } })).status).toBe(400);
      const conCodigos = await accesoU({ rol: 'contable', permisos: ['*'] });
      expect(conCodigos.status).toBe(400);
      expect(conCodigos.body.message).toBe('Datos de entrada invalidos.');
      expect(await columnaDe(U.id, E)).toEqual(antes);
    });

    it('7. el perfil Administrador no se personaliza; pasar a él deja la columna vacía', async () => {
      const conAreas = await accesoU({ rol: 'admin', areas: CONTABLE });
      expect(conAreas.status).toBe(400);
      expect(conAreas.body.details).toEqual({ campo: 'areas' });
      expect(await columnaDe(U.id, E)).not.toBeNull(); // sigue el personalizado del punto 6

      const admin = await accesoU({ rol: 'admin' });
      expect(admin.status).toBe(200);
      expect(admin.body.data).toMatchObject({ rol: 'admin', personalizado: false, areas: null, cambiado: true });
      expect(await columnaDe(U.id, E)).toBeNull();
      expect((await como(tokenU).get(`/companies/${E}/chat-assistant/ajustes`)).status).toBe(200);
      await accesoU({ rol: 'contable' });
    });

    it('8. ninguna personalización da config:write ni admin:empresa', async () => {
      await accesoU({ rol: 'contable', areas: TODO });
      expect((await como(tokenU).post(`/companies/${E}/plantillas`, { nombre: 'x', tipoDocumento: 'factura' })).status).toBe(403);
      expect((await como(tokenU).get(`/companies/${E}/chat-assistant/ajustes`)).status).toBe(403);
    });

    it('9. un admin global con un acceso personalizado mínimo sigue pudiéndolo todo', async () => {
      const res = await como(tokenG).put(`/admin/usuarios/${G.id}/empresas/${E}`, { rol: 'contable', areas: { ...NADA, ventas: 'ver' } });
      expect(res.status).toBe(200);
      expect((await como(tokenG).get(`/companies/${E}/nominas`)).status).toBe(200);
      expect((await como(tokenG).post(`/companies/${E}/plantillas`, {})).status).not.toBe(403);
      const me = await como(tokenG).get('/auth/me');
      expect(me.body.data.user.permisosPorEmpresa[E]).toEqual(['*']);
    });

    it('10. el administrador de una empresa no gestiona usuarios ni permisos, ni los suyos', async () => {
      const t = (await authService.login({ email: adminE.email, password: CONTRASENA })).token;
      const usuariosAntes = await prisma.user.count();
      expect((await como(t).put(`/admin/usuarios/${U.id}/empresas/${E}`, { rol: 'admin' })).status).toBe(403);
      expect((await como(t).put(`/admin/usuarios/${adminE.id}/empresas/${E2}`, { rol: 'admin' })).status).toBe(403);
      expect((await como(t).post('/admin/usuarios', { email: `intruso-${SUFIJO}@test.local` })).status).toBe(403);
      expect((await como(t).patch(`/admin/usuarios/${G.id}`, { activo: false })).status).toBe(403);
      expect((await como(t).get('/admin/permisos/catalogo')).status).toBe(403);
      expect((await como(t).post('/users', { email: `intruso2-${SUFIJO}@test.local`, password: CONTRASENA })).status).toBe(403);
      expect(await prisma.user.count()).toBe(usuariosAntes);
      expect(await prisma.membership.count({ where: { userId: adminE.id, companyId: E2 } })).toBe(0);
      expect(String((await prisma.membership.findUniqueOrThrow({ where: { userId_companyId: { userId: U.id, companyId: E } } })).role)).toBe('contable');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: G.id } })).isActive).toBe(true);
    });

    it('11. un usuario no se da permisos a sí mismo', async () => {
      const antes = await columnaDe(U.id, E);
      expect((await como(tokenU).put(`/admin/usuarios/${U.id}/empresas/${E}`, { rol: 'contable', areas: TODO })).status).toBe(403);
      expect((await como(tokenU).put(`/admin/usuarios/${U.id}/empresas/${E}`, { rol: 'admin' })).status).toBe(403);
      expect(await columnaDe(U.id, E)).toEqual(antes);
    });

    it('12. la columna manipulada a mano solo da códigos de área', async () => {
      await prisma.membership.update({
        where: { userId_companyId: { userId: U.id, companyId: E } },
        data: { permisosPersonalizados: ['*', 'admin:global', 'nominas:read'] },
      });
      const me = await como(tokenU).get('/auth/me');
      expect(me.body.data.user.permisosPorEmpresa[E]).toEqual(['nominas:read']);
      expect((await como(tokenU).post(`/companies/${E}/plantillas`, {})).status).toBe(403);
      expect((await como(tokenU).get(`/companies/${E}/clientes`)).status).toBe(403);
      expect((await como(tokenU).get('/admin/usuarios')).status).toBe(403);
    });

    it('13. una columna con un formato raro deja sin permisos de área (las lecturas abiertas siguen)', async () => {
      await prisma.membership.update({ where: { userId_companyId: { userId: U.id, companyId: E } }, data: { permisosPersonalizados: { a: 1 } } });
      expect((await como(tokenU).get(`/companies/${E}/clientes`)).status).toBe(403);
      expect((await como(tokenU).get(`/companies/${E}/legal-config`)).status).toBe(200);
    });

    it('14. todo sin marcar no se puede guardar', async () => {
      const res = await accesoU({ rol: 'contable', areas: NADA });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ message: 'Marca al menos un permiso, o no le des acceso a la empresa.', details: { campo: 'areas' } });
    });

    it('15. lo personalizado no abre otra empresa', async () => {
      await accesoU({ rol: 'contable', areas: TODO });
      expect((await como(tokenU).get(`/companies/${E2}/clientes`)).status).toBe(403);
    });

    it('16. login, me, refresh y la sesión de Carmen dan el mismo conjunto', async () => {
      const areas = { ...NADA, ventas: 'ver' as const, tesoreria: 'modificar' as const };
      await accesoU({ rol: 'solo_lectura', areas });
      const login = await authService.login({ email: U.email, password: contrasenaU });
      const me = await authService.me(U.id);
      const refresco = await authService.refresh(login.refreshToken);
      const req = { headers: { authorization: `Bearer ${login.token}` }, header: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${login.token}` : undefined) } as unknown as { user?: AuthUser };
      await new Promise((resolve) => authMiddleware(req as never, {} as never, resolve as never));
      const carmen = [...construirContexto(req.user!, E).permisos].sort();

      const esperado = permisosDeAreas(areas);
      expect([...login.user.permisosPorEmpresa[E]].sort()).toEqual(esperado);
      expect([...me.user.permisosPorEmpresa[E]].sort()).toEqual(esperado);
      expect([...refresco.user.permisosPorEmpresa[E]].sort()).toEqual(esperado);
      expect(carmen).toEqual(esperado);
      expect(login.user.personalizadoPorEmpresa[E]).toBe(true);
      tokenU = login.token;
    });

    it('17. un PUT sin cambios no escribe ni audita', async () => {
      const cuerpo = { rol: 'contable', areas: { ...CONTABLE, impuestos: 'ver' } };
      expect((await accesoU(cuerpo)).body.data.cambiado).toBe(true);
      const antes = await prisma.auditLog.count({ where: { userId: G.id, resourceId: U.id } });
      const otraVez = await accesoU(cuerpo);
      expect(otraVez.status).toBe(200);
      expect(otraVez.body.data).toMatchObject({ cambiado: false, personalizado: true });
      expect(await prisma.auditLog.count({ where: { userId: G.id, resourceId: U.id } })).toBe(antes);
    });

    it('18. el catálogo trae las 6 áreas y los 4 perfiles, calculados', async () => {
      const res = await como(tokenG).get('/admin/permisos/catalogo');
      expect(res.status).toBe(200);
      expect(res.body.data.areas.map((a: { clave: string }) => a.clave)).toEqual(['ventas', 'compras', 'contabilidad', 'tesoreria', 'impuestos', 'nominas']);
      expect(res.body.data.niveles).toEqual(['ninguno', 'ver', 'modificar']);
      const perfiles = res.body.data.perfiles as Array<{ rol: string; todo: boolean; areas: Areas | null }>;
      expect(perfiles.map((p) => p.rol)).toEqual(['admin', 'contable', 'ventas', 'solo_lectura']);
      for (const p of perfiles) expect(p.areas).toEqual(areasDePerfil(p.rol));
      expect(perfiles[0]).toMatchObject({ todo: true, areas: null });
    });
  });

  describe('Contraseña provisional', () => {
    let P: { id: string; email: string; provisional: string };

    it('19. el alta sin contraseña la genera y la enseña una sola vez, sin cache', async () => {
      const email = `p-${SUFIJO}@test.local`;
      const res = await como(tokenG).post('/admin/usuarios', { email, companyId: E, rol: 'ventas' });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data).toMatchObject({ email, debeCambiarContrasena: true });
      expect(res.body.data.contrasenaProvisional).toMatch(/^[A-Za-z0-9]{16}$/);
      P = { id: res.body.data.id, email, provisional: res.body.data.contrasenaProvisional };

      const lista = await como(tokenG).get('/admin/usuarios');
      expect(JSON.stringify(lista.body)).not.toContain(P.provisional);
      const logs = await prisma.auditLog.findMany({ where: { resourceId: P.id } });
      expect(logs.map((l) => l.action)).toContain('CREATE_USUARIO');
      expect(JSON.stringify(logs)).not.toContain(P.provisional);
      expect(logs.find((l) => l.action === 'CREATE_USUARIO')?.meta).toMatchObject({ contrasenaProvisional: true, contrasenaGenerada: true });
    });

    it('20. con la contraseña escrita también es provisional y no se repite', async () => {
      const escrita = nuevaContrasena();
      const res = await como(tokenG).post('/admin/usuarios', { email: `escrita-${SUFIJO}@test.local`, password: escrita });
      expect(res.status).toBe(201);
      expect(res.body.data.debeCambiarContrasena).toBe(true);
      expect(res.body.data.contrasenaProvisional).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain(escrita);
    });

    it('21. POST /users sin contraseña: 400 y no crea nada', async () => {
      const email = `sin-${SUFIJO}@test.local`;
      const res = await como(tokenG).post('/users', { email });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Falta la contraseña.');
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('22. con la provisional solo se puede ver /auth/me; tampoco tras refrescar', async () => {
      const login = await authService.login({ email: P.email, password: P.provisional });
      expect(login.user.debeCambiarContrasena).toBe(true);
      const t = login.token;
      const bloqueadas = [
        como(t).get('/companies'),
        como(t).get(`/companies/${E}/clientes`),
        como(t).get(`/companies/${E}/income-invoices/no-existe/pdf`),
        como(t).post(`/companies/${E}/chat-assistant`, { mensaje: 'hola' }),
        como(t).get('/fiscal-years/no-existe/books'),
      ];
      for (const r of await Promise.all(bloqueadas)) {
        expect(`${r.status} ${r.body?.details?.codigo}`).toBe(`403 ${CODIGO}`);
        expect(r.body.message).toBe('Antes de seguir tienes que poner una contraseña tuya.');
      }
      const me = await como(t).get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.user.debeCambiarContrasena).toBe(true);

      const refresco = await authService.refresh(login.refreshToken);
      expect(refresco.user.debeCambiarContrasena).toBe(true);
      const tras = await como(refresco.token).get('/companies');
      expect(`${tras.status} ${tras.body?.details?.codigo}`).toBe(`403 ${CODIGO}`);
    });

    it('23. un admin global provisional tampoco entra al panel ni se salta el cambio', async () => {
      const email = `ag-${SUFIJO}@test.local`;
      const alta = await como(tokenG).post('/admin/usuarios', { email, esAdminGlobal: true });
      expect(alta.status).toBe(201);
      const id = alta.body.data.id as string;
      const t = (await authService.login({ email, password: alta.body.data.contrasenaProvisional })).token;
      const panel = await como(t).get('/admin/empresas');
      expect(`${panel.status} ${panel.body?.details?.codigo}`).toBe(`403 ${CODIGO}`);
      const hashAntes = (await prisma.user.findUniqueOrThrow({ where: { id } })).passwordHash;
      const salto = await como(t).patch(`/admin/usuarios/${id}`, { nuevaContrasena: nuevaContrasena() });
      expect(`${salto.status} ${salto.body?.details?.codigo}`).toBe(`403 ${CODIGO}`);
      const despues = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(despues.debeCambiarContrasena).toBe(true);
      expect(despues.passwordHash).toBe(hashAntes);
    });

    it('24. POST /auth/cambiar-contrasena: errores en 400, éxito con tokens nuevos', async () => {
      const login = await authService.login({ email: P.email, password: P.provisional });
      const mala = await como(login.token).post('/auth/cambiar-contrasena', { actual: 'no-es-la-buena-123', nueva: nuevaContrasena() });
      expect(mala.status).toBe(400);
      expect(mala.body).toMatchObject({ message: 'La contraseña actual no es correcta.', details: { campo: 'actual' } });
      expect((await como(login.token).get('/auth/me')).status).toBe(200); // no es un 401: la sesión sigue

      const deMas = await como(login.token).post('/auth/cambiar-contrasena', { actual: P.provisional, nueva: nuevaContrasena(), userId: G.id });
      expect(deMas.status).toBe(400);

      const propia = nuevaContrasena();
      const ok = await como(login.token).post('/auth/cambiar-contrasena', { actual: P.provisional, nueva: propia });
      expect(ok.status).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      expect(ok.body.data.user.debeCambiarContrasena).toBe(false);
      expect(ok.body.data.token).not.toBe(login.token);
      expect(ok.body.data.refreshToken).not.toBe(login.refreshToken);

      expect((await como(login.token).get(`/companies/${E}/clientes`)).status).toBe(401);
      await expect(authService.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
      expect((await como(ok.body.data.token).get(`/companies/${E}/clientes`)).status).toBe(200);
      await expect(authService.login({ email: P.email, password: P.provisional })).rejects.toMatchObject({ statusCode: 401 });
      expect((await authService.login({ email: P.email, password: propia })).user.debeCambiarContrasena).toBe(false);

      const logs = await prisma.auditLog.findMany({ where: { userId: P.id, action: 'CAMBIAR_CONTRASENA_PROPIA' } });
      expect(logs).toHaveLength(1);
      expect(logs[0].meta).toEqual({ eraProvisional: true });
      const todo = JSON.stringify(await prisma.auditLog.findMany({ where: { OR: [{ userId: P.id }, { resourceId: P.id }] } }));
      expect(todo).not.toContain(P.provisional);
      expect(todo).not.toContain(propia);

      // Validaciones del servicio, sin gastar llamadas HTTP (limite por IP).
      await expect(authService.cambiarContrasena(P.id, propia, propia)).rejects.toMatchObject({ statusCode: 400, details: { campo: 'nueva' } });
      await expect(authService.cambiarContrasena(P.id, propia, 'corta')).rejects.toMatchObject({ statusCode: 400, details: { campo: 'nueva' } });
      await expect(authService.cambiarContrasena(P.id, propia, P.email)).rejects.toMatchObject({ statusCode: 400, details: { campo: 'nueva' } });
      const espia = jest.spyOn(prisma.user, 'updateMany').mockResolvedValueOnce({ count: 0 } as never);
      await expect(authService.cambiarContrasena(P.id, propia, nuevaContrasena())).rejects.toMatchObject({ statusCode: 409 });
      espia.mockRestore();
      expect(verifyPassword(propia, (await prisma.user.findUniqueOrThrow({ where: { id: P.id } })).passwordHash)).toBe(true);
    });

    it('25. sin cambio obligatorio también sirve (lo usará Configuración)', async () => {
      const login = await authService.login({ email: U.email, password: contrasenaU });
      const nueva = nuevaContrasena();
      const res = await como(login.token).post('/auth/cambiar-contrasena', { actual: contrasenaU, nueva });
      expect(res.status).toBe(200);
      expect(res.body.data.user.debeCambiarContrasena).toBe(false);
      contrasenaU = nueva;
      tokenU = res.body.data.token;
      const log = await prisma.auditLog.findFirst({ where: { userId: U.id, action: 'CAMBIAR_CONTRASENA_PROPIA' } });
      expect(log?.meta).toEqual({ eraProvisional: false });
    });

    it('26. restablecer la de otro: provisional, se enseña una vez y cierra sus sesiones', async () => {
      const res = await como(tokenG).patch(`/admin/usuarios/${U.id}`, { restablecerContrasena: true });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body.data.contrasenaProvisional).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(res.body.data.debeCambiarContrasena).toBe(true);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: U.id } })).debeCambiarContrasena).toBe(true);
      expect((await como(tokenU).get(`/companies/${E}/clientes`)).status).toBe(401);
      const log = await prisma.auditLog.findFirst({ where: { userId: G.id, resourceId: U.id, action: 'UPDATE_USUARIO' }, orderBy: { timestamp: 'desc' } });
      expect(log?.meta).toMatchObject({ contrasenaRestablecida: true, contrasenaProvisional: true, contrasenaGenerada: true });
      expect(JSON.stringify(log)).not.toContain(res.body.data.contrasenaProvisional);

      const escrita = nuevaContrasena();
      const otra = await como(tokenG).patch(`/admin/usuarios/${U.id}`, { nuevaContrasena: escrita });
      expect(otra.status).toBe(200);
      expect(otra.body.data.contrasenaProvisional).toBeUndefined();
      expect(JSON.stringify(otra.body)).not.toContain(escrita);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: U.id } })).debeCambiarContrasena).toBe(true);
    });

    it('27. la propia no se cambia desde el panel ni desde /users (sin la actual); pedir las dos cosas es un 400', async () => {
      const hashAntes = (await prisma.user.findUniqueOrThrow({ where: { id: G.id } })).passwordHash;
      const escrita = await como(tokenG).patch(`/admin/usuarios/${G.id}`, { nuevaContrasena: nuevaContrasena() });
      expect(escrita.status).toBe(400);
      expect(escrita.body.message).toBe('Tu propia contraseña cámbiala en «Cambiar contraseña».');
      const antigua = await como(tokenG).put(`/users/${G.id}`, { password: nuevaContrasena() });
      expect(antigua.status).toBe(400);
      expect(antigua.body.message).toBe('Tu propia contraseña cámbiala en «Cambiar contraseña».');
      const g = await prisma.user.findUniqueOrThrow({ where: { id: G.id } });
      expect(g.passwordHash).toBe(hashAntes);
      expect(g.debeCambiarContrasena).toBe(false);
      expect((await como(tokenG).get('/admin/usuarios')).status).toBe(200); // su sesion sigue

      const generar = await como(tokenG).patch(`/admin/usuarios/${G.id}`, { restablecerContrasena: true });
      expect(generar.status).toBe(400);
      expect(generar.body.message).toBe('Tu propia contraseña cámbiala en «Cambiar contraseña».');
      const las2 = await como(tokenG).patch(`/admin/usuarios/${U.id}`, { restablecerContrasena: true, nuevaContrasena: nuevaContrasena() });
      expect(las2.status).toBe(400);
      expect(las2.body.message).toBe('Elige una de las dos: generar una contraseña provisional o escribirla.');
    });

    it('27 bis. exigirCambioContrasena: obliga a cambiar la que ya tiene, sin tocarla ni echarle', async () => {
      const V = await usuarioDePrueba('exigir', { companyId: E, role: 'ventas' });
      const hashAntes = (await prisma.user.findUniqueOrThrow({ where: { id: V.id } })).passwordHash;
      const tokenV = (await authService.login({ email: V.email, password: CONTRASENA })).token;
      expect((await como(tokenV).get(`/companies/${E}/clientes`)).status).toBe(200);

      const res = await como(tokenG).patch(`/admin/usuarios/${V.id}`, { exigirCambioContrasena: true });
      expect(res.status).toBe(200);
      expect(res.body.data.debeCambiarContrasena).toBe(true);
      expect(res.body.data.contrasenaProvisional).toBeUndefined();
      const v = await prisma.user.findUniqueOrThrow({ where: { id: V.id } });
      expect(v.passwordHash).toBe(hashAntes);
      expect(v.debeCambiarContrasena).toBe(true);
      expect(v.contrasenaProvisionalHasta).toBeNull(); // la suya de siempre no caduca

      // Su sesión abierta queda bloqueada (403, no 401) y con su contraseña de siempre entra, provisional.
      const bloqueada = await como(tokenV).get(`/companies/${E}/clientes`);
      expect(`${bloqueada.status} ${bloqueada.body?.details?.codigo}`).toBe(`403 ${CODIGO}`);
      expect((await authService.login({ email: V.email, password: CONTRASENA })).user.debeCambiarContrasena).toBe(true);

      const log = await prisma.auditLog.findFirst({ where: { userId: G.id, resourceId: V.id, action: 'UPDATE_USUARIO' } });
      expect(log?.meta).toEqual({ email: V.email, exigirCambioContrasena: true });

      // Pedirlo otra vez no cambia nada ni deja otra línea en la auditoría.
      expect((await como(tokenG).patch(`/admin/usuarios/${V.id}`, { exigirCambioContrasena: true })).status).toBe(200);
      expect(await prisma.auditLog.count({ where: { userId: G.id, resourceId: V.id, action: 'UPDATE_USUARIO' } })).toBe(1);

      // Para uno mismo, quitarlo, o junto con una contraseña nueva: 400.
      const propio = await como(tokenG).patch(`/admin/usuarios/${G.id}`, { exigirCambioContrasena: true });
      expect(propio.status).toBe(400);
      expect(propio.body.message).toBe('Tu propia contraseña cámbiala en «Cambiar contraseña».');
      expect((await prisma.user.findUniqueOrThrow({ where: { id: G.id } })).debeCambiarContrasena).toBe(false);
      const quitar = await como(tokenG).patch(`/admin/usuarios/${V.id}`, { exigirCambioContrasena: false });
      expect(quitar.status).toBe(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: V.id } })).debeCambiarContrasena).toBe(true);
      const conOtra = await como(tokenG).patch(`/admin/usuarios/${V.id}`, { exigirCambioContrasena: true, restablecerContrasena: true });
      expect(conOtra.status).toBe(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: V.id } })).passwordHash).toBe(hashAntes);
    });

    it('27 ter. la provisional caduca a los 7 días: ni login, ni refresh, ni sesión abierta', async () => {
      const email = `caduca-${SUFIJO}@test.local`;
      const antes = Date.now();
      const alta = await como(tokenG).post('/admin/usuarios', { email, companyId: E, rol: 'contable' });
      expect(alta.status).toBe(201);
      const id = alta.body.data.id as string;
      const provisional = alta.body.data.contrasenaProvisional as string;
      const dias = (new Date(alta.body.data.contrasenaProvisionalHasta).getTime() - antes) / (24 * 60 * 60 * 1000);
      expect(dias).toBeGreaterThanOrEqual(DIAS_CONTRASENA_PROVISIONAL - 0.01);
      expect(dias).toBeLessThan(DIAS_CONTRASENA_PROVISIONAL + 0.01);
      expect(alta.body.data.contrasenaProvisionalCaducada).toBe(false);

      const login = await authService.login({ email, password: provisional });
      // Pasa la fecha (se adelanta a mano en la BD).
      await prisma.user.update({ where: { id }, data: { contrasenaProvisionalHasta: new Date(Date.now() - 1000) } });

      await expect(authService.login({ email, password: provisional })).rejects.toMatchObject({ statusCode: 401, message: MENSAJE_PROVISIONAL_CADUCADA });
      await expect(authService.login({ email, password: 'no-es-la-buena-123' })).rejects.toMatchObject({ statusCode: 401, message: 'Credenciales invalidas.' });
      await expect(authService.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401, message: MENSAJE_PROVISIONAL_CADUCADA });
      const me = await como(login.token).get('/auth/me');
      expect(`${me.status} ${me.body.message}`).toBe(`401 ${MENSAJE_PROVISIONAL_CADUCADA}`);
      const cambio = await como(login.token).post('/auth/cambiar-contrasena', { actual: provisional, nueva: nuevaContrasena() });
      expect(cambio.status).toBe(401);
      await expect(authService.cambiarContrasena(id, provisional, nuevaContrasena())).rejects.toMatchObject({ statusCode: 401 });

      const fila = (await como(tokenG).get('/admin/usuarios')).body.data.find((u: { id: string }) => u.id === id);
      expect(fila).toMatchObject({ debeCambiarContrasena: true, contrasenaProvisionalCaducada: true });

      // El administrador le genera otra: vale 7 días más y con ella pone la suya, que ya no caduca.
      const otra = await como(tokenG).patch(`/admin/usuarios/${id}`, { restablecerContrasena: true });
      expect(otra.status).toBe(200);
      expect(otra.body.data.contrasenaProvisionalCaducada).toBe(false);
      expect(new Date(otra.body.data.contrasenaProvisionalHasta).getTime()).toBeGreaterThan(Date.now());
      const nueva = otra.body.data.contrasenaProvisional as string;
      await authService.login({ email, password: nueva });
      const propia = nuevaContrasena();
      await authService.cambiarContrasena(id, nueva, propia);
      const u = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(u.debeCambiarContrasena).toBe(false);
      expect(u.contrasenaProvisionalHasta).toBeNull();
      expect((await authService.login({ email, password: propia })).user.debeCambiarContrasena).toBe(false);
      const tras = (await como(tokenG).get('/admin/usuarios')).body.data.find((x: { id: string }) => x.id === id);
      expect(tras).toMatchObject({ debeCambiarContrasena: false, contrasenaProvisionalHasta: null, contrasenaProvisionalCaducada: false });
    });

    it('28. la API antigua /users también deja la contraseña provisional', async () => {
      const email = `users-${SUFIJO}@test.local`;
      const alta = await como(tokenG).post('/users', { email, password: nuevaContrasena() });
      expect(alta.status).toBe(201);
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).debeCambiarContrasena).toBe(true);

      await prisma.user.update({ where: { id: adminE.id }, data: { debeCambiarContrasena: false } });
      expect((await como(tokenG).put(`/users/${adminE.id}`, { password: nuevaContrasena() })).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: adminE.id } })).debeCambiarContrasena).toBe(true);
    });
  });
});
