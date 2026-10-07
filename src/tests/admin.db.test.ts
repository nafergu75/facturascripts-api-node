/**
 * Modo administrador global sobre BD real: empresas, usuarios, accesos por
 * empresa y protecciones (no quitarse el permiso a uno mismo, no dejar la
 * plataforma sin administrador, 403 para quien no lo es).
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 *
 * Crea administradores globales: solo corre en CI o contra una BD local
 * (127.0.0.1 / localhost), nunca contra una BD en la nube aunque DATABASE_URL
 * apunte a ella. Las contrasenas se generan en cada ejecucion y al terminar se
 * borra todo lo creado.
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { randomBytes } from 'crypto';
import request from 'supertest';
import { app } from '../app';
import { prisma } from '../config/database';
import { authService } from '../services/auth.service';
import { actualizarUsuario } from '../services/admin.service';
import { hashPassword } from '../utils/password';
import { controlCif } from '../utils/nif';

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
/** Contrasenas de usar y tirar: nunca escritas en el codigo. */
const nuevaContrasena = () => randomBytes(18).toString('base64url');
const CONTRASENA = nuevaContrasena();
const NUEVA = nuevaContrasena();

let adminA: { id: string; email: string };
let tokenA: string;
let empresaId: string;
let usuarioId: string;
let emailUsuario: string;
const usuariosCreados: string[] = [];
const empresasCreadas: string[] = [];

/** CIF valido y distinto en cada ejecucion: la BD local puede tener ya empresas reales. */
function cifDePrueba(letra: 'A' | 'B'): string {
  const siete = String(randomBytes(4).readUInt32BE(0) % 10_000_000).padStart(7, '0');
  return `${letra}${siete}${controlCif(siete).cifra}`;
}

const tokenDe = (userId: string, email: string, extra: Partial<Parameters<typeof authService.generateToken>[0]> = {}) =>
  authService.generateToken({ userId, email, roles: [], companies: [], ...extra });

const como = (token: string) => ({
  get: (ruta: string) => request(app).get(ruta).set('Authorization', `Bearer ${token}`),
  post: (ruta: string, body: object = {}) => request(app).post(ruta).set('Authorization', `Bearer ${token}`).send(body),
  put: (ruta: string, body: object = {}) => request(app).put(ruta).set('Authorization', `Bearer ${token}`).send(body),
  patch: (ruta: string, body: object = {}) => request(app).patch(ruta).set('Authorization', `Bearer ${token}`).send(body),
  delete: (ruta: string) => request(app).delete(ruta).set('Authorization', `Bearer ${token}`),
});

describeBd('modo administrador global (BD real)', () => {
  beforeAll(async () => {
    adminA = await prisma.user.create({
      data: { email: `admin-a-${SUFIJO}@test.local`, passwordHash: hashPassword(CONTRASENA), isGlobalAdmin: true },
      select: { id: true, email: true },
    });
    usuariosCreados.push(adminA.id);
    tokenA = tokenDe(adminA.id, adminA.email, { esAdminGlobal: true });
  });

  // Nada de lo creado se queda en la BD, y menos un administrador global activo.
  afterAll(async () => {
    const otros = await prisma.user.findMany({ where: { email: { endsWith: `-${SUFIJO}@test.local` } }, select: { id: true } });
    const ids = Array.from(new Set([...usuariosCreados, ...otros.map((u) => u.id)]));
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { isActive: false, isGlobalAdmin: false } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } }); // sus accesos se borran en cascada
    const empresas = [...(empresaId ? [empresaId] : []), ...empresasCreadas];
    if (empresas.length) {
      await prisma.legalConfig.deleteMany({ where: { companyId: { in: empresas } } });
      await prisma.company.deleteMany({ where: { id: { in: empresas } } });
    }
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

  describe('Alta con los datos de la empresa', () => {
    const NIF_SA = cifDePrueba('A');
    const DENOMINACION = `Biosoluciones Test ${SUFIJO}, S.A.`;
    const DATOS_SA = {
      denominacion: DENOMINACION,
      tipoSociedad: 'SA',
      pais: 'ES',
      nif: NIF_SA,
      domicilioSocial: 'Paseo Sierra de Espadán 6',
      codigoPostal: '46120',
      municipio: 'Alboraya',
      provincia: 'Valencia',
      telefono: '+34 960 00 00 00',
      email: 'administracion@ejemplo.es',
      web: 'www.ejemplo.es',
    };
    const REGISTRO = ['Registro Mercantil (provincia)', 'Tomo', 'Folio', 'Hoja', 'Inscripción'];
    const NIF_SLU = cifDePrueba('B');
    let idSa: string;
    let idSlu: string;

    it('crea la empresa, el acceso de administrador y sus datos legales; sin Registro Mercantil queda pendiente', async () => {
      // El NIF escrito en minusculas y con guion: se guarda normalizado.
      const res = await como(tokenA).post('/admin/empresas', { datos: { ...DATOS_SA, nif: `${NIF_SA[0].toLowerCase()}-${NIF_SA.slice(1)}` } });
      expect(res.status).toBe(201);
      idSa = res.body.data.id;
      empresasCreadas.push(idSa);
      expect(res.body.data).toMatchObject({ nombre: DENOMINACION, denominacion: DENOMINACION, nif: NIF_SA, pais: 'ES', usuarios: 1, completo: false });
      expect(res.body.data.pendientes).toEqual(REGISTRO);

      const legal = await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: idSa } });
      expect(legal).toMatchObject({
        ...DATOS_SA,
        nif: NIF_SA,
        registroMercantilProvincia: null,
        registroTomo: null,
        obligaLibroSocios: true,
        obligaLibroContratos: false,
      });
      const m = await prisma.membership.findUnique({ where: { userId_companyId: { userId: adminA.id, companyId: idSa } } });
      expect(String(m?.role)).toBe('admin');

      // Al entrar en la empresa, la app ve lo que falta y lo pide.
      const cfg = await como(tokenA).get(`/companies/${idSa}/legal-config`);
      expect(cfg.status).toBe(200);
      expect(cfg.body.data).toMatchObject({ completo: false, pendientes: REGISTRO });
    });

    it('no deja dar de alta otra empresa con el mismo NIF, aunque se escriba distinto, y no deja nada a medias', async () => {
      const copia = `Copia ${SUFIJO}, S.A.`;
      const res = await como(tokenA).post('/admin/empresas', { datos: { ...DATOS_SA, denominacion: copia, nif: `ES ${NIF_SA}` } });
      expect(res.status).toBe(409);
      expect(res.body.details).toEqual({ campo: 'nif' });
      expect(res.body.message).toContain(DENOMINACION);
      expect(await prisma.company.count({ where: { name: copia } })).toBe(0);
      expect(await prisma.legalConfig.count({ where: { denominacion: copia } })).toBe(0);
    });

    it('un CIF con el digito de control mal se rechaza sin crear nada', async () => {
      const malo = `${NIF_SA.slice(0, 8)}${(Number(NIF_SA[8]) + 1) % 10}`;
      const nombre = `Control malo ${SUFIJO}, S.A.`;
      const res = await como(tokenA).post('/admin/empresas', { datos: { ...DATOS_SA, denominacion: nombre, nif: malo } });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ campo: 'nif' });
      expect(await prisma.company.count({ where: { name: nombre } })).toBe(0);
    });

    it('con el Registro Mercantil y nombre corto propio queda completa; la unipersonal lleva libro de contratos', async () => {
      const res = await como(tokenA).post('/admin/empresas', {
        nombre: `Center ${SUFIJO}`,
        datos: {
          denominacion: `Center Test ${SUFIJO}, S.L.U.`,
          tipoSociedad: 'SLU',
          nif: NIF_SLU,
          domicilioSocial: 'Calle de Ejemplo 1',
          codigoPostal: '46001',
          municipio: 'Valencia',
          provincia: 'Valencia',
          registroMercantilProvincia: 'Valencia',
          registroTomo: '1234',
          registroFolio: '56',
          registroHoja: 'V-78901',
          registroInscripcion: '1ª',
        },
      });
      expect(res.status).toBe(201);
      idSlu = res.body.data.id;
      empresasCreadas.push(idSlu);
      expect(res.body.data).toMatchObject({ nombre: `Center ${SUFIJO}`, pais: 'ES', completo: true, pendientes: [] });
      const legal = await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: res.body.data.id } });
      expect(legal).toMatchObject({ registroHoja: 'V-78901', obligaLibroSocios: true, obligaLibroContratos: true });
    });

    it('al editar sus datos: el NIF de otra empresa no, la forma tiene que cuadrar y los libros se recalculan', async () => {
      const datosSlu = `/companies/${idSlu}/legal-config`;
      const duplicado = await como(tokenA).put(datosSlu, { tipoSociedad: 'SA', nif: NIF_SA });
      expect(duplicado.status).toBe(409);
      expect(duplicado.body.details).toEqual({ campo: 'nif' });
      expect(duplicado.body.message).toContain(DENOMINACION);
      expect(await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: idSlu } })).toMatchObject({ nif: NIF_SLU, tipoSociedad: 'SLU' });

      // La S.A. no puede pasar a S.L. con su CIF de A.
      const forma = await como(tokenA).put(`/companies/${idSa}/legal-config`, { tipoSociedad: 'SL' });
      expect(forma.status).toBe(400);
      expect(forma.body.details).toEqual({ campo: 'tipoSociedad' });

      // SLU -> SL: deja de llevar el libro de contratos con el socio unico.
      const sl = await como(tokenA).put(datosSlu, { tipoSociedad: 'SL' });
      expect(sl.status).toBe(200);
      expect(sl.body.data).toMatchObject({ tipoSociedad: 'SL', obligaLibroSocios: true, obligaLibroContratos: false });

      // Su propio NIF, escrito de otra forma, no es un duplicado.
      const mismo = await como(tokenA).put(datosSlu, { nif: `ES ${NIF_SLU}` });
      expect(mismo.status).toBe(200);
      expect(mismo.body.data.nif).toBe(NIF_SLU);
    });

    it('una empresa extranjera no necesita provincia ni Registro Mercantil', async () => {
      const res = await como(tokenA).post('/admin/empresas', {
        datos: {
          denominacion: `Lisboa Test ${SUFIJO}, Lda.`,
          tipoSociedad: 'OTRA',
          pais: 'PT',
          nif: `PT${SUFIJO}`,
          domicilioSocial: 'Rua Augusta 1',
          codigoPostal: '1100-048',
          municipio: 'Lisboa',
        },
      });
      expect(res.status).toBe(201);
      empresasCreadas.push(res.body.data.id);
      expect(res.body.data).toMatchObject({ pais: 'PT', completo: true });
      const legal = await prisma.legalConfig.findUniqueOrThrow({ where: { companyId: res.body.data.id } });
      expect(legal).toMatchObject({ pais: 'PT', provincia: null, obligaLibroSocios: false, obligaLibroContratos: false });
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
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/);
      expect(JSON.stringify(res.body)).not.toContain(CONTRASENA);
      usuarioId = res.body.data.id;
      usuariosCreados.push(usuarioId);

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
      const nueva = NUEVA;
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
      expect(JSON.stringify(logs)).not.toContain(CONTRASENA);
      expect(JSON.stringify(logs)).not.toContain(NUEVA);
    });
  });

  describe('Sesiones abiertas: los cambios surten efecto sin esperar a que caduque el token', () => {
    it('quitar el acceso a una empresa se la cierra al momento; darlo, se la abre', async () => {
      const { token } = await authService.login({ email: emailUsuario, password: NUEVA });
      expect((await como(token).get(`/companies/${empresaId}`)).status).toBe(200);

      expect((await como(tokenA).delete(`/admin/usuarios/${usuarioId}/empresas/${empresaId}`)).status).toBe(200);
      expect((await como(token).get(`/companies/${empresaId}`)).status).toBe(403);

      expect((await como(tokenA).put(`/admin/usuarios/${usuarioId}/empresas/${empresaId}`, { rol: 'solo_lectura' })).status).toBe(200);
      expect((await como(token).get(`/companies/${empresaId}`)).status).toBe(200);
    });

    it('restablecer la contrasena cierra sus sesiones, tambien la renovacion con el refresh token', async () => {
      const login = await authService.login({ email: emailUsuario, password: NUEVA });
      const otra = nuevaContrasena();
      expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { nuevaContrasena: otra })).status).toBe(200);
      expect((await como(login.token).get(`/companies/${empresaId}`)).status).toBe(401);
      await expect(authService.refresh(login.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

      // Con la contrasena nueva entra sin problema.
      const otraVez = await authService.login({ email: emailUsuario, password: otra });
      expect((await como(otraVez.token).get(`/companies/${empresaId}`)).status).toBe(200);
    });

    it('desactivarlo le echa al momento', async () => {
      const t = tokenDe(usuarioId, emailUsuario, { companies: [empresaId] });
      expect((await como(t).get(`/companies/${empresaId}`)).status).toBe(200);
      expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { activo: false })).status).toBe(200);
      expect((await como(t).get(`/companies/${empresaId}`)).status).toBe(401);
      expect((await como(tokenA).patch(`/admin/usuarios/${usuarioId}`, { activo: true })).status).toBe(200);
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
      usuariosCreados.push(idB);
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
});
