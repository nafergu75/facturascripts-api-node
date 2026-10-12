/**
 * Configuración > Usuarios: rutas por empresa (/companies/:companyId/usuarios),
 * sobre BD real.
 *
 * El administrador de la empresa (o el global) da de alta usuarios, da acceso a
 * un correo que ya existe, cambia rol y permisos, genera una contraseña
 * provisional nueva y quita el acceso. Lo que se prueba es lo que tiene que
 * aguantar un intento de saltárselo:
 * - el administrador de una empresa no actúa en otra;
 * - no toca al administrador global ni da el modo administrador global;
 * - no cambia la contraseña de quien también entra en empresas que no administra;
 * - una empresa no se queda sin administrador;
 * - todo queda en AuditLog y la contraseña solo sale una vez, en la respuesta.
 *
 * Crea un administrador global: solo corre en CI o contra una BD local. Las
 * contraseñas se generan en cada ejecución y al terminar se borra lo creado.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService, huellaContrasena } from '../services/auth.service';
import { areasDePerfil, permisosDeAreas, type Areas } from '../services/rbac.service';
import { DIAS_CONTRASENA_PROVISIONAL, hashPassword, verifyPassword } from '../utils/password';

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
const CONTRASENA = randomBytes(18).toString('base64url');
const correo = (n: string) => `${n}-${SUFIJO}@test.local`;

/** Contable sin Nóminas ni Compras: un acceso a medida. */
const A_MEDIDA: Areas = { ventas: 'ver', compras: 'ninguno', contabilidad: 'modificar', tesoreria: 'ver', impuestos: 'modificar', nominas: 'ninguno' };

const como = (token: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${token}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${token}`).send(body),
  put: (ruta: string, body: object = {}) => request(app).put(ruta).set('Authorization', `Bearer ${token}`).send(body),
  delete: (ruta: string) => request(app).delete(ruta).set('Authorization', `Bearer ${token}`),
});

const tokenDe = async (userId: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, passwordHash: true, isGlobalAdmin: true } });
  return authService.generateToken({ userId, email: u.email, roles: [], companies: [], esAdminGlobal: u.isGlobalAdmin, huellaContrasena: huellaContrasena(u.passwordHash) });
};

type Rol = 'admin' | 'contable' | 'ventas' | 'solo_lectura';
type Usuario = { id: string; email: string };

/** Usuario con contraseña propia (no provisional) y sus accesos. */
async function usuario(nombre: string, accesos: Array<[string, Rol]>, extra: { isGlobalAdmin?: boolean } = {}): Promise<Usuario> {
  return prisma.user.create({
    data: {
      email: correo(nombre),
      passwordHash: hashPassword(CONTRASENA),
      isGlobalAdmin: extra.isGlobalAdmin ?? false,
      memberships: { create: accesos.map(([companyId, role]) => ({ companyId, role })) },
    },
    select: { id: true, email: true },
  });
}

const acceso = (userId: string, companyId: string) =>
  prisma.membership.findUnique({ where: { userId_companyId: { userId, companyId } }, select: { role: true, permisosPersonalizados: true } });

const auditoria = (action: string, resourceId: string) =>
  prisma.auditLog.findMany({ where: { action, resourceId }, orderBy: { timestamp: 'desc' } });

let A: string;
let B: string;
let C: string;
let G: Usuario;
let adminA: Usuario;
let adminB: Usuario;
let contableA: Usuario;
let soloA: Usuario;
let enAyB: Usuario;
let soloB: Usuario;
let globalEnA: Usuario;
let huerfano: Usuario;
let adminAyLectorB: Usuario;
let tokenG: string;
let tokenAdminA: string;
let tokenAdminB: string;
let tokenContableA: string;

describeBd('Configuración > Usuarios, por empresa (BD real)', () => {
  beforeAll(async () => {
    const empresa = async (n: string) =>
      (await prisma.company.create({ data: { name: `Usuarios ${n} ${SUFIJO}`, fsBaseUrl: '', fsApiKeyEnc: '', isActive: true }, select: { id: true } })).id;
    A = await empresa('A');
    B = await empresa('B');
    C = await empresa('C');
    G = await usuario('g', [], { isGlobalAdmin: true });
    adminA = await usuario('admin-a', [[A, 'admin']]);
    adminB = await usuario('admin-b', [[B, 'admin']]);
    contableA = await usuario('contable-a', [[A, 'contable']]);
    soloA = await usuario('solo-a', [[A, 'ventas']]);
    enAyB = await usuario('en-a-y-b', [[A, 'contable'], [B, 'contable']]);
    soloB = await usuario('solo-b', [[B, 'solo_lectura']]);
    globalEnA = await usuario('global-en-a', [[A, 'admin']], { isGlobalAdmin: true });
    // Cuenta que existe pero hoy no entra en ninguna empresa (alta global «Sin empresa por ahora»).
    huerfano = await usuario('huerfano', []);
    // Administra A y solo consulta B: B no la administra.
    adminAyLectorB = await usuario('admin-a-lector-b', [[A, 'admin'], [B, 'solo_lectura']]);
    tokenG = await tokenDe(G.id);
    tokenAdminA = await tokenDe(adminA.id);
    tokenAdminB = await tokenDe(adminB.id);
    tokenContableA = await tokenDe(contableA.id);
  });

  afterAll(async () => {
    const usuarios = await prisma.user.findMany({ where: { email: { endsWith: `-${SUFIJO}@test.local` } }, select: { id: true } });
    const ids = usuarios.map((u) => u.id);
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false, isGlobalAdmin: false } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { companyId: { in: [A, B, C] } }, { resourceId: { in: ids } }] } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.company.deleteMany({ where: { id: { in: [A, B, C] } } });
  });

  describe('Quién puede entrar', () => {
    it('quien no es administrador de la empresa recibe un 403 en todas las rutas', async () => {
      const t = como(tokenContableA);
      expect((await t.get(`/companies/${A}/usuarios`)).status).toBe(403);
      expect((await t.get(`/companies/${A}/usuarios/catalogo`)).status).toBe(403);
      expect((await t.post(`/companies/${A}/usuarios/comprobar-correo`, { email: correo('x') })).status).toBe(403);
      expect((await t.post(`/companies/${A}/usuarios`, { nombre: 'Xx Yy', email: correo('x'), rol: 'ventas' })).status).toBe(403);
      expect((await t.put(`/companies/${A}/usuarios/${soloA.id}`, { rol: 'contable' })).status).toBe(403);
      expect((await t.post(`/companies/${A}/usuarios/${soloA.id}/contrasena-provisional`)).status).toBe(403);
      expect((await t.delete(`/companies/${A}/usuarios/${soloA.id}`)).status).toBe(403);
      expect(await acceso(soloA.id, A)).toMatchObject({ role: 'ventas' });
    });

    it('el administrador de una empresa no actúa en otra', async () => {
      const t = como(tokenAdminA);
      expect((await t.get(`/companies/${B}/usuarios`)).status).toBe(403);
      expect((await t.post(`/companies/${B}/usuarios`, { nombre: 'Intruso Uno', email: correo('intruso'), rol: 'admin' })).status).toBe(403);
      expect((await t.put(`/companies/${B}/usuarios/${soloB.id}`, { rol: 'admin' })).status).toBe(403);
      expect((await t.post(`/companies/${B}/usuarios/${soloB.id}/contrasena-provisional`)).status).toBe(403);
      expect((await t.delete(`/companies/${B}/usuarios/${soloB.id}`)).status).toBe(403);
      expect(await prisma.user.count({ where: { email: correo('intruso') } })).toBe(0);
      expect(await acceso(soloB.id, B)).toMatchObject({ role: 'solo_lectura' });
    });

    it('desde su empresa no puede tocar a un usuario que solo está en otra (404)', async () => {
      const t = como(tokenAdminA);
      expect((await t.put(`/companies/${A}/usuarios/${soloB.id}`, { rol: 'admin' })).status).toBe(404);
      expect((await t.post(`/companies/${A}/usuarios/${soloB.id}/contrasena-provisional`)).status).toBe(404);
      expect((await t.delete(`/companies/${A}/usuarios/${soloB.id}`)).status).toBe(404);
      expect(await acceso(soloB.id, A)).toBeNull();
    });

    it('el catálogo de permisos es el de la administración global', async () => {
      const res = await como(tokenAdminA).get(`/companies/${A}/usuarios/catalogo`);
      expect(res.status).toBe(200);
      expect(res.body.data.perfiles.map((p: { rol: string }) => p.rol)).toEqual(['admin', 'contable', 'ventas', 'solo_lectura']);
      expect(res.body.data.areas).toHaveLength(6);
    });
  });

  describe('Lista', () => {
    it('enseña solo a los de esa empresa, con estado, permisos y último acceso, sin hashes', async () => {
      await prisma.auditLog.create({ data: { userId: soloA.id, action: 'LOGIN', resourceType: 'AUTH', resourceId: soloA.id, timestamp: new Date('2026-10-01T08:00:00Z') } });
      await prisma.auditLog.create({ data: { userId: soloA.id, action: 'LOGIN', resourceType: 'AUTH', resourceId: soloA.id, timestamp: new Date('2026-10-05T09:30:00Z') } });
      const res = await como(tokenAdminA).get(`/companies/${A}/usuarios`);
      expect(res.status).toBe(200);
      const emails = res.body.data.map((u: { email: string }) => u.email);
      expect(emails).toEqual(expect.arrayContaining([adminA.email, contableA.email, soloA.email, enAyB.email, globalEnA.email]));
      expect(emails).not.toContain(soloB.email);
      expect(emails).not.toContain(adminB.email);
      const fila = res.body.data.find((u: { email: string }) => u.email === soloA.email);
      expect(fila).toMatchObject({
        userId: soloA.id,
        rol: 'ventas',
        personalizado: false,
        areas: areasDePerfil('ventas'),
        activo: true,
        estado: 'activo',
        ultimoAcceso: '2026-10-05T09:30:00.000Z',
        puedes: { editarAcceso: true, nuevaContrasena: true, quitarAcceso: true, datosPersonales: true },
      });
      expect(res.body.data.find((u: { email: string }) => u.email === adminB.email)).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|contrasenaProvisional"/);
    });

    it('dice lo que el administrador de empresa no puede hacer con cada uno', async () => {
      const res = await como(tokenAdminA).get(`/companies/${A}/usuarios`);
      const de = (email: string) => res.body.data.find((u: { email: string }) => u.email === email);
      // El administrador global: ni tocarlo.
      expect(de(globalEnA.email)).toMatchObject({
        esAdminGlobal: true,
        puedes: { editarAcceso: false, nuevaContrasena: false, quitarAcceso: false, datosPersonales: false },
      });
      // También entra en B, que no administra: ni su contraseña ni sus datos.
      expect(de(enAyB.email).puedes).toEqual({ editarAcceso: true, nuevaContrasena: false, quitarAcceso: true, datosPersonales: false });
      // Uno mismo: su contraseña la cambia en «Cambiar contraseña»; su nombre, sí.
      expect(de(adminA.email).puedes).toMatchObject({ nuevaContrasena: false, datosPersonales: true });
    });

    it('el administrador global ve las de cualquier empresa y puede con todos', async () => {
      const res = await como(tokenG).get(`/companies/${B}/usuarios`);
      expect(res.status).toBe(200);
      const de = (email: string) => res.body.data.find((u: { email: string }) => u.email === email);
      expect(de(enAyB.email).puedes).toEqual({ editarAcceso: true, nuevaContrasena: true, quitarAcceso: true, datosPersonales: true });
      // Último administrador de B: no se le puede quitar el acceso.
      expect(de(adminB.email).puedes.quitarAcceso).toBe(false);
    });
  });

  describe('Alta', () => {
    let nuevo: { id: string; contrasena: string };

    it('avisa si el correo ya tiene usuario y si ya entra en esta empresa', async () => {
      const t = como(tokenAdminA);
      const comprobar = async (email: string) => (await t.post(`/companies/${A}/usuarios/comprobar-correo`, { email })).body.data;
      expect(await comprobar(correo('nadie'))).toEqual({ existe: false, yaTieneAcceso: false, soloAdminGlobal: false });
      expect(await comprobar(`  ${soloB.email.toUpperCase()} `)).toEqual({ existe: true, yaTieneAcceso: false, soloAdminGlobal: false });
      expect(await comprobar(soloA.email)).toEqual({ existe: true, yaTieneAcceso: true, soloAdminGlobal: false });
      // Ni el administrador global ni una cuenta sin empresas se reciben desde aquí.
      expect(await comprobar(G.email)).toEqual({ existe: true, yaTieneAcceso: false, soloAdminGlobal: true });
      expect(await comprobar(huerfano.email)).toEqual({ existe: true, yaTieneAcceso: false, soloAdminGlobal: true });
      // El administrador global sí puede.
      expect((await como(tokenG).post(`/companies/${A}/usuarios/comprobar-correo`, { email: huerfano.email })).body.data).toEqual({
        existe: true,
        yaTieneAcceso: false,
        soloAdminGlobal: false,
      });
      expect((await t.post(`/companies/${A}/usuarios/comprobar-correo`, { email: 'no-es-un-correo' })).status).toBe(400);
    });

    it('da de alta un usuario nuevo con permisos a medida y su contraseña provisional, una vez', async () => {
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios`, {
        nombre: '  Lucía   Pérez Gómez ',
        email: `  ${correo('nueva').toUpperCase()} `,
        telefono: '+34 600 11 22 33',
        rol: 'contable',
        areas: A_MEDIDA,
      });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { usuario: u, contrasenaProvisional, usuarioNuevo } = res.body.data;
      expect(usuarioNuevo).toBe(true);
      expect(typeof contrasenaProvisional).toBe('string');
      expect(contrasenaProvisional).toHaveLength(16);
      expect(u).toMatchObject({
        nombre: 'Lucía Pérez Gómez',
        email: correo('nueva'),
        telefono: '+34 600 11 22 33',
        rol: 'contable',
        personalizado: true,
        areas: A_MEDIDA,
        estado: 'contrasena_pendiente',
        esAdminGlobal: false,
      });
      nuevo = { id: u.userId, contrasena: contrasenaProvisional };

      const bd = await prisma.user.findUniqueOrThrow({ where: { id: nuevo.id } });
      expect(bd.isGlobalAdmin).toBe(false);
      expect(bd.debeCambiarContrasena).toBe(true);
      expect(bd.passwordHash).not.toContain(contrasenaProvisional);
      expect(verifyPassword(contrasenaProvisional, bd.passwordHash)).toBe(true);
      const dias = (bd.contrasenaProvisionalHasta!.getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(DIAS_CONTRASENA_PROVISIONAL - 0.01);
      expect(dias).toBeLessThanOrEqual(DIAS_CONTRASENA_PROVISIONAL);
      expect((await acceso(nuevo.id, A))?.permisosPersonalizados).toEqual(permisosDeAreas(A_MEDIDA));

      const [log] = await auditoria('CREATE_USUARIO', nuevo.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
      expect(JSON.stringify(log.meta)).not.toContain(contrasenaProvisional);

      // La lista no la repite.
      const lista = await como(tokenAdminA).get(`/companies/${A}/usuarios`);
      expect(JSON.stringify(lista.body)).not.toContain(contrasenaProvisional);
    });

    it('el usuario nuevo entra, tiene que cambiar la contraseña y luego solo ve lo permitido', async () => {
      const login = await authService.login({ email: correo('nueva'), password: nuevo.contrasena });
      const bloqueado = await como(login.token).get(`/companies/${A}/clientes`);
      expect(bloqueado.status).toBe(403);
      expect(bloqueado.body.details).toEqual({ codigo: 'CAMBIO_CONTRASENA_OBLIGATORIO' });
      const propia = randomBytes(18).toString('base64url');
      const cambio = await como(login.token).post('/auth/cambiar-contrasena', { actual: nuevo.contrasena, nueva: propia });
      expect(cambio.status).toBe(200);
      const t = como(cambio.body.data.token);
      // Ventas: ver sí, modificar no; Nóminas: nada; y nada de usuarios.
      expect((await t.get(`/companies/${A}/clientes`)).status).toBe(200);
      expect((await t.post(`/companies/${A}/clientes`, { nombre: 'No debería' })).status).toBe(403);
      expect((await t.get(`/companies/${A}/empleados`)).status).toBe(403);
      expect((await t.get(`/companies/${A}/usuarios`)).status).toBe(403);
    });

    it('con un correo que ya existe no crea otro usuario: le da acceso a esta empresa', async () => {
      const antes = await prisma.user.findUniqueOrThrow({ where: { id: soloB.id }, select: { passwordHash: true, nombre: true } });
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios`, { nombre: 'Otro Nombre', email: ` ${soloB.email.toUpperCase()}`, rol: 'solo_lectura' });
      expect(res.status).toBe(200);
      expect(res.body.data.usuarioNuevo).toBe(false);
      expect(res.body.data.contrasenaProvisional).toBeUndefined();
      expect(res.body.data.usuario).toMatchObject({ userId: soloB.id, rol: 'solo_lectura', estado: 'activo' });
      expect(await prisma.user.count({ where: { email: soloB.email } })).toBe(1);
      // Ni la contraseña ni su nombre: es el mismo usuario, que ya tenía los suyos.
      const despues = await prisma.user.findUniqueOrThrow({ where: { id: soloB.id }, select: { passwordHash: true, nombre: true } });
      expect(despues).toEqual(antes);
      expect(await acceso(soloB.id, A)).toMatchObject({ role: 'solo_lectura' });
      expect(await acceso(soloB.id, B)).toMatchObject({ role: 'solo_lectura' });
      const [log] = await auditoria('ASIGNAR_USUARIO_EMPRESA', soloB.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
    });

    it('si ya entra en esta empresa, 409: se cambia con «Editar acceso»', async () => {
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios`, { nombre: 'Ana Ventas', email: soloA.email, rol: 'admin' });
      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ codigo: 'YA_TIENE_ACCESO', userId: soloA.id });
      expect(await acceso(soloA.id, A)).toMatchObject({ role: 'ventas' });
    });

    it('no admite el modo administrador global, una contraseña escrita ni otra empresa en el cuerpo', async () => {
      const t = como(tokenAdminA);
      const base = { nombre: 'Pepe Pérez', email: correo('colado'), rol: 'ventas' };
      for (const extra of [{ esAdminGlobal: true }, { password: 'una-contrasena-larga' }, { companyId: B }, { permisos: ['*'] }]) {
        const res = await t.post(`/companies/${A}/usuarios`, { ...base, ...extra });
        expect(res.status).toBe(400);
        expect(res.body.details).toEqual({ campo: Object.keys(extra)[0] });
      }
      expect(await prisma.user.count({ where: { email: correo('colado') } })).toBe(0);
    });

    it('pide el nombre del usuario nuevo y valida rol, áreas y teléfono', async () => {
      const t = como(tokenAdminA);
      const base = { nombre: 'Pepe Pérez', email: correo('colado'), rol: 'ventas' };
      const casos: Array<[object, string]> = [
        [{ nombre: undefined }, 'nombre'],
        [{ nombre: ' a ' }, 'nombre'],
        [{ rol: 'superadmin' }, 'rol'],
        [{ areas: { ventas: 'todo' } }, 'areas'],
        [{ rol: 'admin', areas: A_MEDIDA }, 'areas'],
        [{ telefono: 'llámame' }, 'telefono'],
        [{ email: 'sin-arroba' }, 'email'],
      ];
      for (const [cambio, campo] of casos) {
        const res = await t.post(`/companies/${A}/usuarios`, { ...base, ...cambio });
        expect(res.status).toBe(400);
        expect(res.body.details).toMatchObject({ campo });
      }
      expect(await prisma.user.count({ where: { email: correo('colado') } })).toBe(0);
    });

    it('no da acceso al administrador global desde una empresa', async () => {
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios`, { nombre: 'Global', email: G.email, rol: 'solo_lectura' });
      expect(res.status).toBe(403);
      expect(await acceso(G.id, A)).toBeNull();
    });

    it('una cuenta sin ninguna empresa solo la recibe el administrador global: así nadie se queda con ella', async () => {
      const antes = await prisma.user.findUniqueOrThrow({ where: { id: huerfano.id }, select: { passwordHash: true } });
      // Si la recibiera, pasaría a estar «solo en sus empresas» y podría cambiarle la contraseña.
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios`, { email: huerfano.email, rol: 'solo_lectura' });
      expect(res.status).toBe(403);
      expect(res.body.message).toContain('no entra en ninguna empresa');
      expect(await acceso(huerfano.id, A)).toBeNull();
      expect(await auditoria('ASIGNAR_USUARIO_EMPRESA', huerfano.id)).toHaveLength(0);
      expect((await como(tokenAdminA).post(`/companies/${A}/usuarios/${huerfano.id}/contrasena-provisional`)).status).toBe(404);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: huerfano.id }, select: { passwordHash: true } })).toEqual(antes);

      // El administrador global sí le da acceso; y desde ahí sigue la regla de siempre.
      const global = await como(tokenG).post(`/companies/${A}/usuarios`, { email: huerfano.email, rol: 'solo_lectura' });
      expect(global.status).toBe(200);
      expect(global.body.data).toMatchObject({ usuarioNuevo: false, usuario: { userId: huerfano.id, rol: 'solo_lectura' } });
      const [log] = await auditoria('ASIGNAR_USUARIO_EMPRESA', huerfano.id);
      expect(log).toMatchObject({ userId: G.id, companyId: A });
    });
  });

  describe('Editar acceso', () => {
    it('cambia rol y permisos y lo deja en AuditLog', async () => {
      const res = await como(tokenAdminA).put(`/companies/${A}/usuarios/${soloA.id}`, { rol: 'contable', areas: A_MEDIDA });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ userId: soloA.id, rol: 'contable', personalizado: true, areas: A_MEDIDA });
      const [log] = await auditoria('CAMBIAR_ROL_EMPRESA', soloA.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
      expect(log.meta).toMatchObject({ rolAnterior: 'ventas', rol: 'contable' });

      const vuelta = await como(tokenAdminA).put(`/companies/${A}/usuarios/${soloA.id}`, { rol: 'contable', areas: null });
      expect(vuelta.body.data).toMatchObject({ personalizado: false, areas: areasDePerfil('contable') });
      expect(await auditoria('CAMBIAR_PERMISOS_EMPRESA', soloA.id)).toHaveLength(1);
    });

    it('cambia el nombre y el teléfono de quien solo entra en sus empresas', async () => {
      const res = await como(tokenAdminA).put(`/companies/${A}/usuarios/${soloA.id}`, { rol: 'contable', nombre: 'Ana López', telefono: '960 000 000' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ nombre: 'Ana López', telefono: '960 000 000' });
      const [log] = await auditoria('UPDATE_USUARIO', soloA.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
      expect(log.meta).toMatchObject({ nombre: 'Ana López', telefono: '960 000 000' });
    });

    it('no cambia los datos personales de quien también entra en otras empresas', async () => {
      const res = await como(tokenAdminA).put(`/companies/${A}/usuarios/${enAyB.id}`, { rol: 'contable', nombre: 'Cambiado' });
      expect(res.status).toBe(403);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: enAyB.id } })).nombre).toBeNull();
      // Su acceso a esta empresa, sí.
      expect((await como(tokenAdminA).put(`/companies/${A}/usuarios/${enAyB.id}`, { rol: 'ventas' })).status).toBe(200);
      expect(await acceso(enAyB.id, B)).toMatchObject({ role: 'contable' });
    });

    it('sus propios datos sí, aunque también entre en empresas que no administra', async () => {
      const t = como(await tokenDe(adminAyLectorB.id));
      const lista = await t.get(`/companies/${A}/usuarios`);
      const yo = lista.body.data.find((u: { userId: string }) => u.userId === adminAyLectorB.id);
      expect(yo.puedes).toMatchObject({ nuevaContrasena: false, datosPersonales: true });
      const res = await t.put(`/companies/${A}/usuarios/${adminAyLectorB.id}`, { rol: 'admin', nombre: 'Marta Ruiz', telefono: '961 111 111' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ nombre: 'Marta Ruiz', telefono: '961 111 111', rol: 'admin' });
      expect(await acceso(adminAyLectorB.id, B)).toMatchObject({ role: 'solo_lectura' });
      // Los de otro que también entra en B, no.
      expect((await t.put(`/companies/${A}/usuarios/${enAyB.id}`, { rol: 'ventas', nombre: 'No' })).status).toBe(403);
    });

    it('no toca al administrador global ni admite el modo administrador global', async () => {
      const t = como(tokenAdminA);
      expect((await t.put(`/companies/${A}/usuarios/${globalEnA.id}`, { rol: 'solo_lectura' })).status).toBe(403);
      expect((await t.delete(`/companies/${A}/usuarios/${globalEnA.id}`)).status).toBe(403);
      expect((await t.post(`/companies/${A}/usuarios/${globalEnA.id}/contrasena-provisional`)).status).toBe(403);
      expect(await acceso(globalEnA.id, A)).toMatchObject({ role: 'admin' });
      const res = await t.put(`/companies/${A}/usuarios/${soloA.id}`, { rol: 'contable', esAdminGlobal: true });
      expect(res.status).toBe(400);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: soloA.id } })).isGlobalAdmin).toBe(false);
    });
  });

  describe('Último administrador', () => {
    let unico: Usuario;
    let tokenUnico: string;
    let otro: Usuario;

    beforeAll(async () => {
      unico = await usuario('unico-c', [[C, 'admin']]);
      otro = await usuario('otro-c', [[C, 'contable']]);
      tokenUnico = await tokenDe(unico.id);
    });

    it('nadie se quita el último acceso de administrador de una empresa', async () => {
      const t = como(tokenUnico);
      const bajar = await t.put(`/companies/${C}/usuarios/${unico.id}`, { rol: 'contable' });
      expect(bajar.status).toBe(409);
      expect(bajar.body.details).toMatchObject({ codigo: 'ULTIMO_ADMIN_EMPRESA' });
      expect((await t.delete(`/companies/${C}/usuarios/${unico.id}`)).status).toBe(409);
      // Tampoco el administrador global, desde aquí: antes hay que nombrar a otro.
      expect((await como(tokenG).delete(`/companies/${C}/usuarios/${unico.id}`)).status).toBe(409);
      expect(await acceso(unico.id, C)).toMatchObject({ role: 'admin' });
    });

    it('con otro administrador en la empresa, sí puede dejarlo', async () => {
      const t = como(tokenUnico);
      expect((await t.put(`/companies/${C}/usuarios/${otro.id}`, { rol: 'admin' })).status).toBe(200);
      expect((await t.put(`/companies/${C}/usuarios/${unico.id}`, { rol: 'contable' })).status).toBe(200);
      // Ya no es administrador: fuera de la gestión de usuarios.
      expect((await t.get(`/companies/${C}/usuarios`)).status).toBe(403);
    });

    it('dos administradores que se quitan el acceso el uno al otro a la vez no dejan la empresa sin ninguno', async () => {
      const D = (await prisma.company.create({ data: { name: `Usuarios D ${SUFIJO}`, fsBaseUrl: '', fsApiKeyEnc: '', isActive: true }, select: { id: true } })).id;
      try {
        const x = await usuario('x-d', [[D, 'admin']]);
        const y = await usuario('y-d', [[D, 'admin']]);
        const [rx, ry] = await Promise.all([
          como(await tokenDe(x.id)).delete(`/companies/${D}/usuarios/${y.id}`),
          como(await tokenDe(y.id)).delete(`/companies/${D}/usuarios/${x.id}`),
        ]);
        expect([rx.status, ry.status].sort()).toEqual([200, 409].sort());
        expect(await prisma.membership.count({ where: { companyId: D, role: 'admin' } })).toBe(1);
      } finally {
        await prisma.auditLog.deleteMany({ where: { companyId: D } });
        await prisma.company.delete({ where: { id: D } });
      }
    });

    it('un administrador desactivado no cuenta como administrador de la empresa', async () => {
      const dormido = await usuario('dormido-c', [[C, 'admin']]);
      await prisma.user.update({ where: { id: dormido.id }, data: { isActive: false } });
      // En C quedan «otro» (activo) y «dormido» (desactivado): «otro» no puede irse.
      expect((await como(tokenG).delete(`/companies/${C}/usuarios/${otro.id}`)).status).toBe(409);
      // Al desactivado sí se le puede quitar.
      expect((await como(tokenG).delete(`/companies/${C}/usuarios/${dormido.id}`)).status).toBe(200);
    });
  });

  describe('Nueva contraseña provisional', () => {
    it('la genera, la enseña una vez y obliga a cambiarla; queda en AuditLog sin la contraseña', async () => {
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios/${soloA.id}/contrasena-provisional`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { contrasenaProvisional, contrasenaProvisionalHasta, estado } = res.body.data;
      expect(contrasenaProvisional).toHaveLength(16);
      expect(estado).toBe('contrasena_pendiente');
      expect(new Date(contrasenaProvisionalHasta).getTime()).toBeGreaterThan(Date.now() + (DIAS_CONTRASENA_PROVISIONAL - 1) * 86_400_000);
      const bd = await prisma.user.findUniqueOrThrow({ where: { id: soloA.id } });
      expect(bd.debeCambiarContrasena).toBe(true);
      expect(verifyPassword(contrasenaProvisional, bd.passwordHash)).toBe(true);
      expect(verifyPassword(CONTRASENA, bd.passwordHash)).toBe(false);
      const [log] = await auditoria('UPDATE_USUARIO', soloA.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
      expect(log.meta).toMatchObject({ contrasenaRestablecida: true, contrasenaGenerada: true });
      expect(JSON.stringify(log.meta)).not.toContain(contrasenaProvisional);
      const lista = await como(tokenAdminA).get(`/companies/${A}/usuarios`);
      expect(JSON.stringify(lista.body)).not.toContain(contrasenaProvisional);
      expect(lista.body.data.find((u: { userId: string }) => u.userId === soloA.id).estado).toBe('contrasena_pendiente');
    });

    it('caducada, la lista lo dice', async () => {
      await prisma.user.update({ where: { id: soloA.id }, data: { contrasenaProvisionalHasta: new Date(Date.now() - 1000) } });
      const lista = await como(tokenAdminA).get(`/companies/${A}/usuarios`);
      expect(lista.body.data.find((u: { userId: string }) => u.userId === soloA.id).estado).toBe('contrasena_caducada');
    });

    it('no la cambia a quien también entra en empresas que no administra', async () => {
      const antes = (await prisma.user.findUniqueOrThrow({ where: { id: enAyB.id } })).passwordHash;
      const res = await como(tokenAdminA).post(`/companies/${A}/usuarios/${enAyB.id}/contrasena-provisional`);
      expect(res.status).toBe(403);
      expect(res.body.data).toBeUndefined();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: enAyB.id } })).passwordHash).toBe(antes);
      // El administrador global sí.
      const global = await como(tokenG).post(`/companies/${A}/usuarios/${enAyB.id}/contrasena-provisional`);
      expect(global.status).toBe(200);
      expect(global.body.data.contrasenaProvisional).toHaveLength(16);
    });

    it('la propia no: se cambia en «Cambiar contraseña»', async () => {
      expect((await como(tokenAdminA).post(`/companies/${A}/usuarios/${adminA.id}/contrasena-provisional`)).status).toBe(400);
    });
  });

  describe('Quitar acceso', () => {
    it('quita el acceso a esta empresa sin borrar el usuario y lo deja en AuditLog', async () => {
      const res = await como(tokenAdminA).delete(`/companies/${A}/usuarios/${soloB.id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ userId: soloB.id, companyId: A, quitado: true });
      expect(await acceso(soloB.id, A)).toBeNull();
      expect(await acceso(soloB.id, B)).toMatchObject({ role: 'solo_lectura' });
      expect(await prisma.user.count({ where: { id: soloB.id } })).toBe(1);
      const [log] = await auditoria('QUITAR_USUARIO_EMPRESA', soloB.id);
      expect(log).toMatchObject({ userId: adminA.id, companyId: A });
      expect((await como(tokenAdminA).delete(`/companies/${A}/usuarios/${soloB.id}`)).status).toBe(404);
    });

    it('el administrador de otra empresa sigue sin poder tocarlo en la suya', async () => {
      // adminB no entra en A.
      expect((await como(tokenAdminB).delete(`/companies/${A}/usuarios/${contableA.id}`)).status).toBe(403);
      expect(await acceso(contableA.id, A)).toMatchObject({ role: 'contable' });
    });
  });

  describe('Comprobar correos', () => {
    it('tiene un límite por usuario: no sirve para repasar listas de correos', async () => {
      const adminC = await usuario('admin-c', [[C, 'admin']]);
      const t = como(await tokenDe(adminC.id));
      for (let i = 0; i < 60; i++) {
        expect((await t.post(`/companies/${C}/usuarios/comprobar-correo`, { email: correo(`lista-${i}`) })).status).toBe(200);
      }
      const res = await t.post(`/companies/${C}/usuarios/comprobar-correo`, { email: correo('lista-60') });
      expect(res.status).toBe(429);
      expect(res.body.message).toContain('demasiados correos');
      // Es por usuario: el de otra empresa sigue pudiendo.
      expect((await como(tokenAdminA).post(`/companies/${A}/usuarios/comprobar-correo`, { email: correo('otro') })).status).toBe(200);
    });
  });
});
