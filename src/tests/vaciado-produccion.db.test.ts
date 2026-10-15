/**
 * Vaciado de produccion de punta a punta, con el script de verdad
 * (scripts/vaciar-produccion.sh) contra una base LOCAL de usar y tirar:
 * simulacion, cancelar sin la frase, copia + borrado + comprobacion + acceso,
 * la prueba de acceso con la base caida (sin ensenar la conexion), una
 * restauracion cortada a medias y como se sale, restaurar la copia, volver a
 * vaciar y empezar de cero con la API (la primera factura sale A-1), subir solo
 * los ficheros, la parada por VERI*FACTU, la parada con una base de otra
 * version (tambien si solo le sobra una columna) y con la de otra aplicacion.
 *
 * El vaciado BORRA LA BASE ENTERA: este test solo corre si DATABASE_URL apunta
 * a una base cuyo nombre empieza por «conta_vaciar» (por ejemplo
 * conta_vaciar_a, creada con prisma db push). Con cualquier otra base (el CI,
 * las de otras pruebas) se salta. Crea y borra ademas <base>_sinmarcas.
 *
 *   DATABASE_URL=mysql://root@127.0.0.1:3397/conta_vaciar_a npx jest vaciado-produccion.db --runInBand
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, promises as fsp, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { crearCliente, contarTodas } from '../services/vaciadoProduccion/bd';
import { clasificarTablas, id } from '../services/vaciadoProduccion/tablas';
import { main } from '../services/vaciadoProduccion/cli';
import { leerManifiesto } from '../services/vaciadoProduccion/copia';
import { crearDatosVaciado, SECRETO_PASS_PRUEBA, SECRETO_PFX_PRUEBA, type DatosVaciado } from './vaciado-datos';
import { hoyEspana } from '../utils/fechas';

const URL_BD = process.env.DATABASE_URL ?? '';
const NOMBRE_BD = (() => {
  try {
    return new URL(URL_BD).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();
const ACTIVO = /^conta_vaciar/.test(NOMBRE_BD);
const d = ACTIVO ? describe : describe.skip;
const RAIZ = path.resolve(__dirname, '..', '..');
const MINUTOS = 60_000;

const tablas = clasificarTablas().tablas;
const destino = new Map(tablas.map((t) => [t.nombre, t.destino]));

function bash(): string {
  if (process.platform !== 'win32') return 'bash';
  return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => existsSync(p)) ?? 'bash';
}

const barras = (p: string) => p.split(path.sep).join('/');

let trabajo = '';
let almacen = '';
let copias = '';
let envProd = '';
let db: PrismaClient;
let datos: DatosVaciado;
let antes: Map<string, number>;
let ficherosAntes: string[] = [];
let salidas = 0;

/** Lanza el script como lo haria el usuario en Git Bash, con lo tecleado en `entrada`. */
function lanzar(args: string[], entrada: string, env: Record<string, string> = {}): { codigo: number | null; salida: string } {
  const entorno: NodeJS.ProcessEnv = { ...process.env, ENV_PROD: envProd, VACIADO_ALMACEN_DISCO: almacen, COPIA_DIR: copias, ...env };
  delete entorno.BLOB_READ_WRITE_TOKEN;
  delete entorno.ENV_BLOB;
  const r = spawnSync(bash(), ['scripts/vaciar-produccion.sh', ...args], { cwd: RAIZ, input: entrada, env: entorno, encoding: 'utf8', timeout: 15 * MINUTOS, maxBuffer: 64 * 1024 * 1024 });
  const salida = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Para leer lo que ve el usuario: VACIADO_SALIDAS=<carpeta> guarda cada salida.
  if (process.env.VACIADO_SALIDAS) {
    writeFileSync(path.join(process.env.VACIADO_SALIDAS, `${String(++salidas).padStart(2, '0')}${(args[0] ?? '--simular').replace(/[^a-z]/g, '')}.txt`), salida);
  }
  // Nunca se escribe la URL de la base.
  expect(salida).not.toContain('mysql://');
  expect(salida).not.toContain('127.0.0.1');
  return { codigo: r.status, salida };
}

async function listarAlmacen(): Promise<string[]> {
  const out: string[] = [];
  const recorrer = async (dir: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const r = path.join(dir, e.name);
      if (e.isDirectory()) await recorrer(r);
      else out.push(barras(path.relative(almacen, r)));
    }
  };
  await recorrer(almacen);
  return out.sort();
}

/** Deja la base de pruebas sin ninguna fila (solo en conta_vaciar*). */
async function limpiarBase(): Promise<void> {
  for (const t of tablas) {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');
      await tx.$executeRawUnsafe(`DELETE FROM ${id(t.nombre)}`);
    });
  }
  await db.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
}

/** La orden acceso en su propio proceso, como la lanza el .sh tras el borrado. */
function acceso(url: string, email: string, clave: string): { codigo: number | null; salida: string } {
  const r = spawnSync(process.execPath, [require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'scripts/vaciar-produccion.ts', 'acceso'], {
    cwd: RAIZ,
    encoding: 'utf8',
    timeout: 5 * MINUTOS,
    env: { ...process.env, DATABASE_URL: url, VACIADO_EMAIL: email, VACIADO_CLAVE: clave, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
  });
  return { codigo: r.status, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function ejecutar(args: string[], url: string): void {
  const r = spawnSync(process.execPath, args, { cwd: RAIZ, env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, encoding: 'utf8', timeout: 10 * MINUTOS });
  if (r.status !== 0) throw new Error(`Falló ${args.join(' ')}: ${(r.stderr || r.stdout || '').slice(-2000)}`);
}

d('vaciado de producción (base local de usar y tirar)', () => {
  beforeAll(async () => {
    trabajo = mkdtempSync(path.join(os.tmpdir(), 'vaciado-'));
    almacen = barras(path.join(trabajo, 'storage'));
    copias = barras(path.join(trabajo, 'copias'));
    envProd = barras(path.join(trabajo, '.env.prod-de-prueba'));
    writeFileSync(envProd, `JWT_SECRET=no-se-usa\nDATABASE_URL=${URL_BD}\n`);
    db = crearCliente(URL_BD);
    await limpiarBase();
    // El seed de la app: empresa 1 y demo@empresa.com (administrador de la empresa, no global).
    ejecutar([require.resolve('ts-node/dist/bin.js'), '--transpile-only', 'prisma/seed.ts'], URL_BD);
    datos = await crearDatosVaciado(almacen);
    antes = await contarTodas(db, tablas);
    ficherosAntes = await listarAlmacen();
  }, 15 * MINUTOS);

  afterAll(async () => {
    await db?.$disconnect();
    if (trabajo) rmSync(trabajo, { recursive: true, force: true });
  });

  it('los datos de prueba llenan TODAS las tablas del esquema', () => {
    const vacias = tablas.filter((t) => !antes.get(t.nombre)).map((t) => t.nombre);
    expect(vacias).toEqual([]);
    expect(antes.get('Company')).toBe(3);
    expect(ficherosAntes).toContain(datos.ficheroAjeno);
  });

  it('VERI*FACTU: hay una factura registrada y la app no deja borrar su registro ni su cadena (el script lo hace con SQL)', async () => {
    const { prisma: deLaApp } = await import('../config/database');
    const registro = await db.verifactuRegistro.findFirstOrThrow({ where: { companyId: '1', entorno: 'PRUEBAS' } });
    const factura = await db.incomeInvoice.findUniqueOrThrow({ where: { id: registro.incomeInvoiceId }, select: { verifactuEstado: true } });
    expect(factura.verifactuEstado).toBe('PENDIENTE');
    await expect(deLaApp.verifactuRegistro.deleteMany({})).rejects.toMatchObject({ statusCode: 409 });
    await expect(deLaApp.verifactuCadena.deleteMany({})).rejects.toMatchObject({ statusCode: 409 });
    await expect(deLaApp.incomeInvoice.delete({ where: { id: registro.incomeInvoiceId } })).rejects.toBeTruthy();
  });

  it('simulación: enseña usuarios, empresas, tablas y ficheros, y no toca nada', async () => {
    const { codigo, salida } = lanzar([], '');
    expect(codigo).toBe(0);
    expect(salida).toContain('SIMULACIÓN (no se borra nada)');
    expect(salida).toMatch(/SE CONSERVA\s+admin\.global@vaciado\.test · administrador global, activo, se le quitan 3 empresas/);
    expect(salida).toMatch(/SE BORRA\s+demo@empresa\.com/);
    expect(salida).toMatch(/SE BORRA\s+contable@vaciado\.test/);
    expect(salida).toContain('EMPRESAS (3) · se borran todas');
    expect(salida).toContain('IFBIOSOLUCIONES SA');
    expect(salida).toContain('NEWZELAND PRUEBAS');
    expect(salida).toMatch(/IncomeInvoice \.+ \d+/);
    expect(salida).toContain('User · se borran: 3 · se quedan: 1');
    expect(salida).toContain('lecturas/');
    expect(salida).toContain('Fuera de las carpetas de la app (no se tocan): 1');
    expect(salida).toContain('declaraciones marcadas como presentadas');
    expect(salida).toContain('Logos de marca y sellos de la plantilla B: 1');
    expect(salida).toContain('VerifactuBitacora · se borran: 2 · se quedan: 2');
    expect(salida).toMatch(/VerifactuRegistro \.+ \d+/);
    expect(salida).toContain('SIMULACIÓN: no se ha borrado nada.');
    expect(await contarTodas(db, tablas)).toEqual(antes);
    expect(await listarAlmacen()).toEqual(ficherosAntes);
  }, 10 * MINUTOS);

  it('sin escribir la frase exacta no se borra nada', async () => {
    for (const frase of ['no', 'borrar todo', 'BORRAR']) {
      const { codigo, salida } = lanzar(['--borrar'], `\n${frase}\n`);
      expect(codigo).toBe(1);
      expect(salida).toContain('Cancelado. No se ha borrado nada.');
    }
    expect(await contarTodas(db, tablas)).toEqual(antes);
    expect(await listarAlmacen()).toEqual(ficherosAntes);
    expect(existsSync(copias)).toBe(false);
  }, 15 * MINUTOS);

  let carpetaCopia = '';

  it('borrar: copia completa, vacía la base y los ficheros, comprueba y deja entrar al administrador', async () => {
    const { codigo, salida } = lanzar(['--borrar'], `\nBORRAR TODO\n${datos.adminClave}\n`);
    expect(salida).toContain('1/4 Copia local completa');
    expect(salida).toContain('VACIADO TERMINADO: la base ha quedado a cero.');
    expect(salida).toContain(`ACCESO CORRECTO: ${datos.adminEmail} entra como administrador global, con 0 empresas.`);
    expect(codigo).toBe(0);

    // La copia: todas las tablas con todas sus filas, y los ficheros de la app.
    const [carpeta] = await fsp.readdir(copias);
    carpetaCopia = path.join(copias, carpeta);
    expect(carpeta).toMatch(/^conta-copia-\d{8}-\d{4}/);
    const m = await leerManifiesto(carpetaCopia);
    expect(m.tablas).toHaveLength(tablas.length);
    for (const t of m.tablas) expect([t.tabla, t.filas]).toEqual([t.tabla, antes.get(t.tabla)]);
    expect(m.ficheros.map((f) => f.clave).sort()).toEqual([...datos.ficheros].sort());
    expect(m.admins.map((a) => a.email)).toEqual([datos.adminEmail]);
    // El certificado de VERI*FACTU va en la copia sin el PFX ni la contraseña (la clave para descifrarlos esta en el mismo ordenador).
    const tCert = m.tablas.find((t) => t.tabla === 'VerifactuCertificado')!;
    const sqlCert = await fsp.readFile(path.join(carpetaCopia, tCert.fichero), 'utf8');
    expect(sqlCert).toContain('IFBIOSOLUCIONES SA');
    expect(sqlCert).not.toContain(SECRETO_PFX_PRUEBA);
    expect(sqlCert).not.toContain(SECRETO_PASS_PRUEBA);
    expect(await fsp.readFile(path.join(carpetaCopia, 'LEEME.txt'), 'utf8')).toContain('No lleva los certificados de VERI*FACTU');

    // La base: lo de las empresas a cero; lo comun, como estaba.
    const despues = await contarTodas(db, tablas);
    for (const t of tablas) {
      if (destino.get(t.nombre) === 'VACIAR') expect([t.nombre, despues.get(t.nombre)]).toEqual([t.nombre, 0]);
      if (destino.get(t.nombre) === 'CONSERVAR') expect([t.nombre, despues.get(t.nombre)]).toEqual([t.nombre, antes.get(t.nombre)]);
    }
    const usuarios = await db.user.findMany({ select: { id: true, email: true, isGlobalAdmin: true } });
    expect(usuarios).toEqual([{ id: datos.adminId, email: datos.adminEmail, isGlobalAdmin: true }]);
    expect(await db.revokedToken.findMany({ select: { userId: true } })).toEqual([{ userId: datos.adminId }]);
    expect((await db.carmenContador.findMany({ select: { clave: true } })).map((c) => c.clave).sort()).toEqual(['global:2026-10', `usuario:${datos.adminId}:2026-10-14`]);
    expect(await db.chartOfAccounts.findMany({ select: { companyId: true, codigo: true } })).toEqual([{ companyId: null, codigo: '700' }]);
    const auditoria = await db.auditLog.findMany({ select: { action: true, companyId: true, userId: true }, orderBy: { timestamp: 'asc' } });
    expect(auditoria.every((a) => a.companyId === null && a.userId === datos.adminId)).toBe(true);
    expect(auditoria.map((a) => a.action).sort()).toEqual(['LOGIN', 'RED_SEGURIDAD_CAMBIADA', 'VACIADO_PRODUCCION']);
    // VERI*FACTU: registros (borrados con SQL), cadena e imagenes a cero; de la bitacora, solo lo de la plataforma.
    expect([despues.get('VerifactuRegistro'), despues.get('VerifactuCadena'), despues.get('ImagenFactura')]).toEqual([0, 0, 0]);
    const bitacora = await db.verifactuBitacora.findMany({ select: { companyId: true, usuarioId: true, tipo: true }, orderBy: { tipo: 'asc' } });
    expect(bitacora).toEqual([
      { companyId: null, usuarioId: datos.adminId, tipo: 'RED_SEGURIDAD' },
      { companyId: null, usuarioId: null, tipo: 'SISTEMA' },
    ]);

    // Los ficheros: solo queda el que no es de la app.
    expect(await listarAlmacen()).toEqual([datos.ficheroAjeno]);
  }, 20 * MINUTOS);

  it('--comprobar: correcta, y se puede repetir', async () => {
    const { codigo, salida } = lanzar(['--comprobar'], '\n');
    expect(salida).toContain('COMPROBACIÓN CORRECTA: la base está a cero.');
    expect(salida).toContain('su primera factura será la A-1');
    expect(salida).toContain('su primera factura será la B-1');
    expect(salida).toContain('Prueba de acceso saltada.');
    expect(codigo).toBe(0);
  }, 10 * MINUTOS);

  it('prueba de acceso: si la base falla no enseña servidor ni usuario, y distingue la contraseña mala', () => {
    const u = new URL(URL_BD);
    u.username = 'usr4AbCd';
    u.password = 'ClaveFalsa99';
    const rechazo = acceso(u.toString(), datos.adminEmail, datos.adminClave);
    // 503 desde el arreglo de la conexion unica (fallo de la base); antes, 500.
    expect(rechazo.salida).toMatch(/la API ha fallado al consultar la base de datos \(respuesta 50[03]\)/);
    expect(rechazo.salida).toContain('ha rechazado el usuario o la contraseña de conexión');
    expect(rechazo.salida).toContain('No es un problema de tu contraseña');
    expect(rechazo.codigo).toBe(1);

    const caida = acceso('mysql://usr4AbCd:ClaveFalsa99@gateway99.eu-central-1.prod.invalid:4000/conta', datos.adminEmail, datos.adminClave);
    expect(caida.salida).toContain('No se ha podido conectar con el servidor de la base de datos');
    expect(caida.codigo).toBe(1);
    for (const s of [rechazo.salida, caida.salida]) {
      expect(s).not.toMatch(/usr4AbCd|ClaveFalsa99|gateway99|127\.0\.0\.1|localhost|mysql:\/\/|Unhandled error|prisma/i);
    }

    const mala = acceso(URL_BD, datos.adminEmail, 'no-es-la-clave');
    expect(mala.salida).toContain('el correo o la contraseña no son correctos');
    expect(mala.salida).not.toContain('No es un problema de tu contraseña');
    expect(mala.codigo).toBe(4);
  }, 10 * MINUTOS);

  it('una restauración cortada a medias dice cómo salir: --borrar y repetir --restaurar con la misma copia', async () => {
    // Copia estropeada: la misma fila de Customer dos veces (clave repetida a mitad de la restauracion).
    const rota = path.join(trabajo, 'copia-rota');
    await fsp.cp(carpetaCopia, rota, { recursive: true });
    const manifiesto = JSON.parse(await fsp.readFile(path.join(rota, 'manifiesto.json'), 'utf8')) as { tablas: Array<{ tabla: string; fichero: string; bytes: number }> };
    const customer = manifiesto.tablas.find((t) => t.tabla === 'Customer')!;
    const fichero = path.join(rota, customer.fichero);
    await fsp.appendFile(fichero, `${(await fsp.readFile(fichero, 'utf8')).split('\n')[0]}\n`);
    customer.bytes = (await fsp.stat(fichero)).size;
    await fsp.writeFile(path.join(rota, 'manifiesto.json'), JSON.stringify(manifiesto));

    const cortada = lanzar(['--restaurar', barras(rota)], 'RESTAURAR COPIA\n');
    expect(cortada.codigo).toBe(1);
    expect(cortada.salida).toContain('LA RESTAURACIÓN SE HA CORTADO A MEDIAS, en la tabla Customer');
    expect(cortada.salida).toContain('bash scripts/vaciar-produccion.sh --borrar');
    expect(cortada.salida).toContain(`--restaurar "${barras(path.resolve(rota))}"`);
    expect(cortada.salida).toContain("Duplicate entry '"); // el motivo, en una línea
    expect(cortada.salida).not.toContain('Invalid `prisma');
    // A medias: lo de antes del corte ya esta (las primeras filas de Customer tambien).
    expect(await db.supplier.count()).toBeGreaterThan(0);
    expect(await db.customer.count()).toBeGreaterThan(0);

    const otraVez = lanzar(['--restaurar', barras(carpetaCopia)], 'RESTAURAR COPIA\n');
    expect(otraVez.codigo).toBe(1);
    expect(otraVez.salida).toContain('La base no está vacía');
    expect(otraVez.salida).toContain('vacía la base con --borrar y repite --restaurar con esta misma copia');

    // La salida: vaciar lo que se ha metido (la restauracion buena es la prueba siguiente).
    const vaciado = lanzar(['--borrar'], '\nBORRAR TODO\n\n');
    expect(vaciado.salida).toContain('VACIADO TERMINADO: la base ha quedado a cero.');
    expect(vaciado.codigo).toBe(0);
    const despues = await contarTodas(db, tablas);
    for (const t of tablas) if (destino.get(t.nombre) === 'VACIAR') expect([t.nombre, despues.get(t.nombre)]).toEqual([t.nombre, 0]);
    expect(await listarAlmacen()).toEqual([datos.ficheroAjeno]);
  }, 20 * MINUTOS);

  it('restaurar la copia lo deja todo como estaba (filas y ficheros)', async () => {
    const cancelado = lanzar(['--restaurar', barras(carpetaCopia)], 'no\n');
    expect(cancelado.codigo).toBe(1);
    const { codigo, salida } = lanzar(['--restaurar', barras(carpetaCopia)], 'RESTAURAR COPIA\n');
    expect(salida).toContain('RESTAURADA:');
    expect(codigo).toBe(0);
    const ahora = await contarTodas(db, tablas);
    for (const t of tablas) {
      // AuditLog suma las marcas del vaciado y de la restauracion y el LOGIN de la prueba de acceso.
      const esperado = (antes.get(t.nombre) ?? 0) + (t.nombre === 'AuditLog' ? 3 : 0);
      expect([t.nombre, ahora.get(t.nombre)]).toEqual([t.nombre, esperado]);
    }
    expect(await listarAlmacen()).toEqual(ficherosAntes);
    const logo = await db.legalConfig.findUnique({ where: { companyId: '1' }, select: { logo: true } });
    expect(Buffer.from(logo!.logo!).toString()).toBe('logo-png');
    // El certificado vuelve sin el PFX ni la contraseña: hay que subirlo otra vez, y la restauracion lo dice.
    const cert = await db.verifactuCertificado.findUniqueOrThrow({ where: { companyId: '1' }, select: { titular: true, pfxEnc: true, passEnc: true } });
    expect(cert).toEqual({ titular: 'IFBIOSOLUCIONES SA', pfxEnc: '', passEnc: '' });
    expect(salida).toContain('Los certificados de VERI*FACTU no iban en la copia: vuelve a subirlos');
  }, 20 * MINUTOS);

  it('vaciar otra vez y empezar de cero con la API: empresa nueva con el mismo NIF, A-1, R-1, P-1 y A-2', async () => {
    const { codigo } = lanzar(['--borrar'], '\nBORRAR TODO\n\n');
    expect(codigo).toBe(0);
    expect(await db.company.count()).toBe(0);

    const { createApp } = await import('../app');
    const app = createApp();
    const login = await request(app).post('/auth/login').send({ email: datos.adminEmail, password: datos.adminClave });
    expect(login.status).toBe(200);
    const auth = { Authorization: `Bearer ${login.body.data.token}` };
    const alta = await request(app)
      .post('/admin/empresas')
      .set(auth)
      .send({
        nombre: 'IFBIOSOLUCIONES',
        datos: { denominacion: 'IFBIOSOLUCIONES SA', nif: 'A10952364', tipoSociedad: 'SA', domicilioSocial: 'Calle Mayor 1', codigoPostal: '46001', municipio: 'Valencia', provincia: 'Valencia' },
      });
    expect([200, 201]).toContain(alta.status);
    const empresa = alta.body.data.id as string;
    const cliente = await request(app).post(`/companies/${empresa}/clientes`).set(auth).send({ nombreFiscal: 'Primer Cliente SL', nifCif: 'B12345674', confirmarSinPlanAnterior: true });
    expect(cliente.status).toBe(201);
    const hoy = hoyEspana();
    const factura = await request(app)
      .post(`/companies/${empresa}/income-invoices`)
      .set(auth)
      .send({ customer: { id: cliente.body.data.id }, fechaEmision: hoy, lineas: [{ descripcion: 'Primera venta', cantidad: 1, precioUnitario: 100, tipoIva: 21 }] });
    expect([200, 201]).toContain(factura.status);
    expect(factura.body.data.invoice.numeroCompleto).toBe('A-1');
    const rectificativa = await request(app)
      .post(`/companies/${empresa}/income-invoices`)
      .set(auth)
      .send({
        customer: {},
        lineas: [{ descripcion: 'Devolución', cantidad: 1, precioUnitario: -10, tipoIva: 21 }],
        rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelve una parte', originales: [{ id: factura.body.data.invoice.id }] },
      });
    expect([200, 201]).toContain(rectificativa.status);
    expect(rectificativa.body.data.invoice.numeroCompleto).toBe('R-1');
    const proforma = await request(app)
      .post(`/companies/${empresa}/income-invoices`)
      .set(auth)
      .send({ proforma: true, customer: { id: cliente.body.data.id }, fechaEmision: hoy, lineas: [{ descripcion: 'Presupuesto', cantidad: 1, precioUnitario: 50, tipoIva: 21 }] });
    expect([200, 201]).toContain(proforma.status);
    expect(proforma.body.data.invoice.numeroCompleto).toBe('P-1');
    const segunda = await request(app)
      .post(`/companies/${empresa}/income-invoices`)
      .set(auth)
      .send({ customer: { id: cliente.body.data.id }, fechaEmision: hoy, lineas: [{ descripcion: 'Segunda venta', cantidad: 1, precioUnitario: 100, tipoIva: 21 }] });
    expect(segunda.body.data.invoice.numeroCompleto).toBe('A-2');
    // Marcar «Vendo cerámica» crea la serie B, desde 1 y sin tocar la numeración de la A.
    const ceramica = await request(app).put(`/companies/${empresa}/ajustes-facturacion`).set(auth).send({ vendeCeramica: true });
    expect([ceramica.status, ceramica.body.data.serieCeramica]).toEqual([200, { codigo: 'B', estado: 'creada', aviso: null }]);
    const series = await request(app).get(`/companies/${empresa}/series?tipoDocumento=FACTURA`).set(auth);
    const porCodigo = Object.fromEntries(
      (series.body.data as Array<{ codigo: string; numeroSiguiente: number; porDefecto: boolean; plantilla: string }>).map((s) => [s.codigo, [s.numeroSiguiente, s.porDefecto, s.plantilla]]),
    );
    expect(porCodigo).toEqual({ A: [3, true, 'default'], B: [1, false, 'B'], C: [1, false, 'C'] });
  }, 20 * MINUTOS);

  it('la copia no se restaura sobre una base que ya tiene empresas', async () => {
    const antesRestaurar = await contarTodas(db, tablas);
    const { codigo, salida } = lanzar(['--restaurar', barras(carpetaCopia)], 'RESTAURAR COPIA\n');
    expect(salida).toContain('La base no está vacía');
    expect(codigo).toBe(1);
    expect(await contarTodas(db, tablas)).toEqual(antesRestaurar);
  }, 10 * MINUTOS);

  it('--restaurar-ficheros sube los ficheros de la copia sin tocar la base (tras restaurar desde TiDB Cloud)', async () => {
    const filasAntes = await contarTodas(db, tablas);
    expect(await listarAlmacen()).toEqual([datos.ficheroAjeno]);
    const cancelado = lanzar(['--restaurar-ficheros', barras(carpetaCopia)], 'no\n');
    expect(cancelado.codigo).toBe(1);
    expect(cancelado.salida).toContain('Cancelado. No se ha subido nada.');
    expect(await listarAlmacen()).toEqual([datos.ficheroAjeno]);

    const { codigo, salida } = lanzar(['--restaurar-ficheros', barras(carpetaCopia)], 'SUBIR FICHEROS\n');
    expect(salida).toContain('La base de datos no se toca.');
    expect(salida).toContain(`FICHEROS RESTAURADOS: ${datos.ficheros.length} subidos`);
    expect(codigo).toBe(0);
    expect(await listarAlmacen()).toEqual(ficherosAntes);

    const repetido = lanzar(['--restaurar-ficheros', barras(carpetaCopia)], 'SUBIR FICHEROS\n');
    expect(repetido.salida).toContain(`0 subidos y ${datos.ficheros.length} ya estaban`);
    expect(repetido.codigo).toBe(0);
    expect(await contarTodas(db, tablas)).toEqual(filasAntes);
  }, 10 * MINUTOS);

  it('se para (sin borrar) si una empresa tiene VERI*FACTU activo', async () => {
    const empresa = (await db.company.findFirstOrThrow({ select: { id: true } })).id;
    await db.verifactuConfig.create({ data: { companyId: empresa, estado: 'ACTIVO', entorno: 'PRODUCCION' } });
    try {
      const lineas: string[] = [];
      const codigo = await main(['simular'], { ...process.env, DATABASE_URL: URL_BD, VACIADO_ALMACEN_DISCO: almacen }, (...l) => lineas.push(...l));
      expect(codigo).toBe(3);
      expect(lineas.join('\n')).toContain('VERI*FACTU activo');
      const antesBorrar = await contarTodas(db, tablas);
      const borrar = await main(['borrar', '--conservar', datos.adminId, '--copia', `${copias}/no-se-crea`], { ...process.env, DATABASE_URL: URL_BD, VACIADO_ALMACEN_DISCO: almacen }, () => undefined);
      expect(borrar).toBe(3);
      expect(await contarTodas(db, tablas)).toEqual(antesBorrar);
      expect(existsSync(`${copias}/no-se-crea`)).toBe(false);
    } finally {
      await db.verifactuConfig.deleteMany({ where: { companyId: empresa } });
    }
  }, 10 * MINUTOS);

  it('se para (sin borrar) si la base no tiene las marcas de esta versión', async () => {
    const nombreB = `${NOMBRE_BD}_sinmarcas`;
    const u = new URL(URL_BD);
    u.pathname = `/${nombreB}`;
    const urlB = u.toString();
    ejecutar([require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--accept-data-loss'], urlB);
    const dbB = crearCliente(urlB);
    const envB = barras(path.join(trabajo, '.env.prod-sin-marcas'));
    writeFileSync(envB, `DATABASE_URL=${urlB}\n`);
    try {
      // Como una version publicada que solo anade una columna: la copia la perderia, asi que se para.
      await dbB.$executeRawUnsafe('ALTER TABLE `Customer` ADD COLUMN `notaProd` VARCHAR(50) NOT NULL');
      const soloColumna = lanzar([], '', { ENV_PROD: envB });
      expect(soloColumna.codigo).toBe(3);
      expect(soloColumna.salida).toContain('La base tiene columnas que esta versión no conoce: Customer.notaProd.');
      expect(soloColumna.salida).not.toContain('ERROR');
      const restaurar = lanzar(['--restaurar', barras(carpetaCopia)], 'RESTAURAR COPIA\n', { ENV_PROD: envB });
      expect(restaurar.codigo).toBe(3);
      expect(restaurar.salida).toContain('No se ha restaurado nada.');
      const comprobarB = lanzar(['--comprobar'], '\n', { ENV_PROD: envB });
      expect(comprobarB.codigo).toBe(3);
      expect(comprobarB.salida).toContain('No se ha comprobado nada.');
      expect(comprobarB.salida).not.toContain('ERROR');

      // Como una base de antes de la ultima version: sin la tabla de rectificadas ni la causa, y con una tabla que esta version no conoce.
      await dbB.$executeRawUnsafe('DROP TABLE `IncomeInvoiceRectificada`');
      await dbB.$executeRawUnsafe('ALTER TABLE `IncomeInvoice` DROP COLUMN `causaRectificacion`');
      await dbB.$executeRawUnsafe('CREATE TABLE `TablaDeOtraVersion` (id INT PRIMARY KEY)');
      await dbB.company.create({ data: { name: 'No se toca', fsBaseUrl: '', fsApiKeyEnc: '' } });

      const sim = lanzar([], '', { ENV_PROD: envB });
      expect(sim.codigo).toBe(3);
      expect(sim.salida).toContain('A la base le faltan tablas de esta versión: IncomeInvoiceRectificada.');
      expect(sim.salida).toContain('IncomeInvoice.causaRectificacion');
      expect(sim.salida).toContain('La base tiene tablas que esta versión no conoce');
      expect(sim.salida).toContain('No se ha borrado nada.');

      const borrar = lanzar(['--borrar'], '\nBORRAR TODO\n', { ENV_PROD: envB });
      expect(borrar.codigo).toBe(3);
      expect(borrar.salida).not.toContain('Para borrar de verdad escribe BORRAR TODO');
      expect(await dbB.company.count()).toBe(1);
    } finally {
      await dbB.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${id(nombreB)}`).catch(() => undefined);
      await dbB.$disconnect();
    }
  }, 15 * MINUTOS);

  it('con la base de otra aplicación se para y lo explica, sin errores técnicos ni tocar nada', async () => {
    const nombreC = `${NOMBRE_BD}_otra`;
    const u = new URL(URL_BD);
    u.pathname = `/${nombreC}`;
    await db.$executeRawUnsafe(`CREATE DATABASE IF NOT EXISTS ${id(nombreC)}`);
    const dbC = crearCliente(u.toString());
    const envC = barras(path.join(trabajo, '.env.prod-otra'));
    writeFileSync(envC, `DATABASE_URL=${u.toString()}\n`);
    try {
      await dbC.$executeRawUnsafe('CREATE TABLE `clientes` (id INT PRIMARY KEY, nombre VARCHAR(50))');
      await dbC.$executeRawUnsafe("INSERT INTO `clientes` VALUES (1, 'No se toca')");

      const sim = lanzar([], '', { ENV_PROD: envC });
      expect(sim.codigo).toBe(3);
      expect(sim.salida).toContain('NO SE PUEDE SEGUIR');
      expect(sim.salida).toContain('La base tiene tablas que esta versión no conoce: clientes.');
      expect(sim.salida).toContain('No se ha borrado nada.');
      const borrar = lanzar(['--borrar'], '\nBORRAR TODO\n', { ENV_PROD: envC });
      expect(borrar.codigo).toBe(3);
      expect(borrar.salida).not.toContain('Para borrar de verdad escribe BORRAR TODO');
      const comprobarC = lanzar(['--comprobar'], '\n', { ENV_PROD: envC });
      expect(comprobarC.codigo).toBe(3);
      for (const s of [sim.salida, borrar.salida, comprobarC.salida]) expect(s).not.toContain('ERROR');
      const [f] = await dbC.$queryRawUnsafe<Array<{ n: unknown }>>('SELECT COUNT(*) AS n FROM `clientes`');
      expect(Number(f.n)).toBe(1);
    } finally {
      await dbC.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${id(nombreC)}`).catch(() => undefined);
      await dbC.$disconnect();
    }
  }, 15 * MINUTOS);
});
