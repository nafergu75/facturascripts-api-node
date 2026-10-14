/**
 * Ordenes del vaciado de produccion. No se lanzan a mano: las llama
 * scripts/vaciar-produccion.sh, que lee la base de ENV_PROD sin ensenarla y
 * hace las preguntas (administradores, frase de confirmacion, contrasena).
 *
 *   simular    [--plan F] [--conservar id,id]  ensena lo que se borraria
 *   borrar     --conservar id,id --copia DIR [--plan F]  copia, borra y comprueba
 *   comprobar  [--plan F] [--copia DIR]        comprobacion final
 *   acceso                                     prueba a entrar (VACIADO_EMAIL, VACIADO_CLAVE)
 *   restaurar  --copia DIR                     vuelve a meter una copia
 *
 * Variables: DATABASE_URL (obligatoria), BLOB_READ_WRITE_TOKEN (ficheros en
 * Vercel Blob), VACIADO_ALMACEN_DISCO (solo pruebas: carpeta storage/ local),
 * VACIADO_COMMIT (version del codigo, para el manifiesto).
 *
 * Codigos de salida: 0 bien, 1 error, 2 uso, 3 parada de seguridad (no se ha
 * borrado nada), 4 la comprobacion no cuadra.
 */
import { randomBytes, randomUUID } from 'crypto';
import * as http from 'http';
import { existsSync, promises as fsp } from 'fs';
import type { AddressInfo } from 'net';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';
import { clasificarTablas } from './tablas';
import { contarTodas, crearCliente, ocultador, plural } from './bd';
import { almacenBlob, almacenDisco, esDeLaApp, sinAlmacen, type Almacen } from './almacen';
import { hacerCopia, leerManifiesto, restaurarCopia, type Manifiesto } from './copia';
import { ACCION_RESTAURADO, comprobar, informeSimulacion, leerUsuarios, simular, vaciar, type Contexto } from './vaciado';

export const SALIDA = { BIEN: 0, ERROR: 1, USO: 2, PARADA: 3, NO_CUADRA: 4 } as const;

type Escribir = (...lineas: string[]) => void;

interface Opciones {
  plan?: string;
  conservar?: string[];
  copia?: string;
}

function leerOpciones(args: string[]): Opciones | string {
  const o: Opciones = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const valor = args[i + 1];
    if ((a === '--plan' || a === '--conservar' || a === '--copia') && (valor === undefined || valor.startsWith('--'))) return `Falta el valor de ${a}.`;
    if (a === '--plan') o.plan = args[++i];
    else if (a === '--copia') o.copia = args[++i];
    else if (a === '--conservar') o.conservar = args[++i].split(',').map((x) => x.trim()).filter(Boolean);
    else return `Opción desconocida: ${a}`;
  }
  return o;
}

export function elegirAlmacen(env: NodeJS.ProcessEnv): Almacen {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (token) return almacenBlob(token);
  const disco = env.VACIADO_ALMACEN_DISCO?.trim();
  if (disco) return almacenDisco(disco);
  return sinAlmacen('no hay clave de Vercel Blob (BLOB_READ_WRITE_TOKEN), así que los ficheros guardados se quedan como están.');
}

/** true si `hija` esta dentro de `padre` (o es la misma carpeta). */
export function estaDentro(hija: string, padre: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const h = norm(hija);
  const p = norm(padre);
  return h === p || h.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Carpeta de git (con .git) que contiene `carpeta`, si la hay. */
export function repoQueLaContiene(carpeta: string): string | null {
  let p = path.resolve(carpeta);
  for (;;) {
    if (existsSync(path.join(p, '.git'))) return p;
    const padre = path.dirname(p);
    if (padre === p) return null;
    p = padre;
  }
}

async function escribirPlan(fichero: string, db: PrismaClient, paradas: number): Promise<void> {
  const usuarios = await leerUsuarios(db);
  const lineas = usuarios.filter((u) => u.adminGlobal).map((u) => `ADMIN|${u.id}|${u.email}|${u.activo ? 'si' : 'no'}`);
  lineas.push(`PARADAS|${paradas}`);
  await fsp.writeFile(fichero, `${lineas.join('\n')}\n`, 'utf8');
}

/** Ejecuta una orden. Devuelve el codigo de salida. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env, escribir: Escribir = (...l) => l.forEach((x) => console.log(x))): Promise<number> {
  const [accion, ...resto] = argv;
  const ordenes = ['simular', 'borrar', 'comprobar', 'acceso', 'restaurar'];
  if (!accion || !ordenes.includes(accion)) {
    escribir(`Uso: vaciar-produccion.ts (${ordenes.join(' | ')}) [opciones]. Lánzalo con scripts/vaciar-produccion.sh.`);
    return SALIDA.USO;
  }
  const opciones = leerOpciones(resto);
  if (typeof opciones === 'string') {
    escribir(opciones);
    return SALIDA.USO;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    escribir('Falta DATABASE_URL. Lánzalo con scripts/vaciar-produccion.sh, que la lee de ENV_PROD.');
    return SALIDA.USO;
  }
  const ocultar = ocultador(url, [env.BLOB_READ_WRITE_TOKEN, env.VACIADO_CLAVE]);

  if (accion === 'acceso') return probarAcceso(env, escribir, ocultar);

  const db = crearCliente(url);
  const ctx: Contexto = { db, clasificacion: clasificarTablas(), almacen: elegirAlmacen(env) };
  try {
    switch (accion) {
      case 'simular':
        return await ordenSimular(ctx, opciones, escribir);
      case 'borrar':
        return await ordenBorrar(ctx, opciones, env, escribir, ocultar);
      case 'comprobar':
        return await ordenComprobar(ctx, opciones, escribir);
      default:
        return await ordenRestaurar(ctx, opciones, escribir);
    }
  } catch (e) {
    escribir(`ERROR: ${ocultar(e instanceof Error ? e.message : String(e))}`);
    return SALIDA.ERROR;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

async function ordenSimular(ctx: Contexto, o: Opciones, escribir: Escribir): Promise<number> {
  const s = await simular(ctx, o.conservar);
  for (const l of informeSimulacion(s, ctx.almacen)) escribir(l);
  if (o.plan) await escribirPlan(o.plan, ctx.db, s.paradas.length);
  return s.paradas.length ? SALIDA.PARADA : SALIDA.BIEN;
}

async function ordenBorrar(ctx: Contexto, o: Opciones, env: NodeJS.ProcessEnv, escribir: Escribir, ocultar: (t: string) => string): Promise<number> {
  if (!o.conservar?.length || !o.copia) {
    escribir('borrar necesita --conservar <ids> y --copia <carpeta>.');
    return SALIDA.USO;
  }
  const carpeta = path.resolve(o.copia);
  const repo = estaDentro(carpeta, process.cwd()) ? process.cwd() : repoQueLaContiene(carpeta);
  if (repo) {
    escribir(`La copia no puede ir dentro de una carpeta con git (${repo}): podría acabar subida. Elige otra con COPIA_DIR.`);
    return SALIDA.USO;
  }

  // Otra vez la simulacion: entre la que vio el usuario y ahora puede haber cambiado algo.
  const s = await simular(ctx, o.conservar);
  if (s.paradas.length) {
    for (const p of s.paradas) escribir(`- ${p}`);
    escribir('No se ha borrado nada.');
    return SALIDA.PARADA;
  }
  const objetos = s.objetos?.deLaApp ?? [];

  escribir('', `1/4 Copia local completa en ${carpeta}`);
  let manifiesto: Manifiesto;
  try {
    manifiesto = await hacerCopia({
      db: ctx.db,
      tablas: ctx.clasificacion.tablas,
      almacen: ctx.almacen,
      objetos,
      carpeta,
      base: { nombre: s.estado.base, version: s.estado.version },
      codigo: env.VACIADO_COMMIT || null,
      admins: s.conservados,
      progreso: escribir,
    });
  } catch (e) {
    escribir(`La copia ha fallado: ${ocultar(e instanceof Error ? e.message : String(e))}`);
    escribir('NO SE HA BORRADO NADA.', `Lo que se haya llegado a copiar está en ${carpeta}: lo puedes borrar.`);
    return SALIDA.ERROR;
  }
  const filasCopia = manifiesto.tablas.reduce((a, t) => a + t.filas, 0);
  escribir(`    Copia hecha y comprobada: ${plural(filasCopia, 'fila', 'filas')} de ${manifiesto.tablas.length} tablas y ${plural(manifiesto.ficheros.length, 'fichero', 'ficheros')}.`);

  escribir('', '2/4 Compruebo que nada ha cambiado desde la copia');
  const ahora = await contarTodas(ctx.db, ctx.clasificacion.tablas);
  const cambiadas = manifiesto.tablas.filter((t) => ahora.get(t.tabla) !== t.filas).map((t) => `${t.tabla} (${t.filas} → ${ahora.get(t.tabla)})`);
  if (ctx.almacen.tipo !== 'ninguno') {
    const claves = new Set((await ctx.almacen.listar()).filter((x) => esDeLaApp(x.clave)).map((x) => x.clave));
    const copiadas = new Set(manifiesto.ficheros.map((f) => f.clave));
    if (claves.size !== copiadas.size || [...claves].some((c) => !copiadas.has(c))) cambiadas.push('ficheros del almacén');
  }
  if (cambiadas.length) {
    escribir(`Han cambiado datos mientras se copiaban: ${cambiadas.join(', ')}.`);
    escribir('NO SE HA BORRADO NADA. Cierra la app (nadie debe usarla) y vuelve a lanzarlo.');
    return SALIDA.ERROR;
  }
  escribir('    Todo igual.');

  escribir('', '3/4 Borrando (tabla a tabla, en lotes)');
  let r: Awaited<ReturnType<typeof vaciar>>;
  try {
    r = await vaciar(ctx, { conservar: s.conservados.map((a) => a.id), objetos, copia: carpeta, progreso: escribir });
  } catch (e) {
    escribir(
      '',
      `EL BORRADO SE HA CORTADO A MEDIAS: ${ocultar(e instanceof Error ? e.message : String(e))}`,
      `La copia completa de antes de borrar está en ${carpeta}.`,
      'Vuelve a lanzar --borrar para terminarlo: seguirá con lo que queda (antes copia lo que quede en otra carpeta).',
      'Si después quieres volver atrás, restaura ESTA copia (la primera) con --restaurar.',
    );
    return SALIDA.ERROR;
  }
  const borradas = [...r.porTabla.values()].reduce((a, n) => a + n, 0);
  escribir(`    Borradas: ${plural(borradas, 'fila', 'filas')} y ${plural(r.ficheros, 'fichero', 'ficheros')}.`);

  escribir('', '4/4 Comprobación final');
  const c = await comprobar(ctx, manifiesto);
  for (const l of c.lineas) escribir(l);
  escribir('', c.ok ? 'VACIADO TERMINADO: la base ha quedado a cero.' : 'ATENCIÓN: el vaciado ha terminado, pero la comprobación no cuadra (mira arriba).');
  escribir(`La copia está en ${carpeta}`);
  // Para la prueba de acceso: los administradores que quedan.
  if (o.plan) await escribirPlan(o.plan, ctx.db, 0);
  return c.ok ? SALIDA.BIEN : SALIDA.NO_CUADRA;
}

async function ordenComprobar(ctx: Contexto, o: Opciones, escribir: Escribir): Promise<number> {
  const manifiesto = o.copia ? await leerManifiesto(o.copia) : null;
  const c = await comprobar(ctx, manifiesto);
  for (const l of c.lineas) escribir(l);
  if (o.plan) await escribirPlan(o.plan, ctx.db, 0);
  escribir('', c.ok ? 'COMPROBACIÓN CORRECTA: la base está a cero.' : 'LA COMPROBACIÓN NO CUADRA (mira arriba).');
  return c.ok ? SALIDA.BIEN : SALIDA.NO_CUADRA;
}

async function ordenRestaurar(ctx: Contexto, o: Opciones, escribir: Escribir): Promise<number> {
  if (!o.copia) {
    escribir('restaurar necesita --copia <carpeta>.');
    return SALIDA.USO;
  }
  const manifiesto = await leerManifiesto(o.copia);
  escribir(`Restaurando la copia del ${manifiesto.creada} (${plural(manifiesto.tablas.reduce((a, t) => a + t.filas, 0), 'fila', 'filas')}, ${plural(manifiesto.ficheros.length, 'fichero', 'ficheros')})`);
  const r = await restaurarCopia({ db: ctx.db, tablas: ctx.clasificacion.tablas, almacen: ctx.almacen, carpeta: o.copia, progreso: escribir });
  const admin = (await leerUsuarios(ctx.db)).find((u) => u.adminGlobal);
  if (admin) {
    await ctx.db.auditLog.create({
      data: {
        id: randomUUID(),
        userId: admin.id,
        companyId: null,
        action: ACCION_RESTAURADO,
        resourceType: 'PLATAFORMA',
        meta: { copiaLocal: path.resolve(o.copia), filas: [...r.filas.values()].reduce((a, n) => a + n, 0), ficheros: r.ficheros },
      },
    });
  }
  // Las tablas que se vaciaron tienen que tener ahora exactamente lo de la copia.
  const ahora = await contarTodas(ctx.db, ctx.clasificacion.tablas);
  const mal = manifiesto.tablas.filter((t) => t.destino === 'VACIAR' && ahora.get(t.tabla) !== t.filas).map((t) => `${t.tabla} (${ahora.get(t.tabla)} de ${t.filas})`);
  for (const a of r.avisos) escribir(`AVISO: ${a}`);
  if (mal.length) {
    escribir(`La restauración no cuadra en: ${mal.join(', ')}.`);
    return SALIDA.NO_CUADRA;
  }
  escribir('', `RESTAURADA: ${plural([...r.filas.values()].reduce((a, n) => a + n, 0), 'fila', 'filas')} y ${plural(r.ficheros, 'fichero', 'ficheros')}.`);
  return SALIDA.BIEN;
}

/** Peticion HTTP local sin conexiones que queden abiertas (fetch deja sockets vivos y Node en Windows falla al salir). */
function peticion(url: string, metodo: 'GET' | 'POST', cabeceras: Record<string, string>, cuerpo?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((ok, ko) => {
    const datos = cuerpo === undefined ? undefined : Buffer.from(JSON.stringify(cuerpo));
    const req = http.request(
      url,
      {
        method: metodo,
        agent: false,
        headers: { Connection: 'close', ...(datos ? { 'Content-Type': 'application/json', 'Content-Length': String(datos.length) } : {}), ...cabeceras },
      },
      (res) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(Buffer.concat(trozos).toString('utf8'));
          } catch {
            // respuesta sin JSON
          }
          ok({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', ko);
    if (datos) req.write(datos);
    req.end();
  });
}

/**
 * Entra con la API de esta copia del codigo contra la misma base: POST
 * /auth/login y GET /auth/me, en un servidor local de usar y tirar. Los tokens
 * se firman con una clave aleatoria de este proceso (no son validos en
 * produccion). El login deja su fila LOGIN en AuditLog, como uno de verdad.
 */
async function probarAcceso(env: NodeJS.ProcessEnv, escribir: Escribir, ocultar: (t: string) => string): Promise<number> {
  const email = env.VACIADO_EMAIL;
  const clave = env.VACIADO_CLAVE;
  if (!email || !clave) {
    escribir('acceso necesita VACIADO_EMAIL y VACIADO_CLAVE.');
    return SALIDA.USO;
  }
  // Antes de cargar la app: su configuracion se lee al importarla.
  process.env.NODE_ENV = 'test'; // sin fichero de peticiones ni registro ruidoso
  process.env.JWT_SECRET = randomBytes(32).toString('hex');
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  delete process.env.VACIADO_CLAVE;
  const { createApp } = await import('../../app');
  const { prisma } = await import('../../config/database');
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await new Promise<void>((ok, ko) => server.once('listening', ok).once('error', ko));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await peticion(`${base}/auth/login`, 'POST', {}, { email, password: clave });
    const token = (login.json.data as { token?: string } | undefined)?.token;
    if (login.status !== 200 || !token) {
      escribir(`NO se ha podido entrar como ${email} (respuesta ${login.status}: ${ocultar(String(login.json.message ?? 'sin mensaje'))}).`);
      escribir('Revisa la contraseña y repite la prueba con --comprobar. Si es la buena y sigue sin dejarte entrar, no des de alta nada todavía: la copia está guardada.');
      return SALIDA.NO_CUADRA;
    }
    const me = await peticion(`${base}/auth/me`, 'GET', { Authorization: `Bearer ${token}` });
    const usuario = (me.json.data as { user?: { esAdminGlobal?: boolean; companies?: string[] } } | undefined)?.user;
    if (me.status !== 200 || usuario?.esAdminGlobal !== true) {
      escribir(`Se entra como ${email}, pero /auth/me responde ${me.status}${usuario?.esAdminGlobal === false ? ' y no es administrador global' : ''}.`);
      return SALIDA.NO_CUADRA;
    }
    escribir(`ACCESO CORRECTO: ${email} entra como administrador global, con ${usuario.companies?.length ?? 0} empresas.`);
    return SALIDA.BIEN;
  } catch (e) {
    escribir(`ERROR al probar el acceso: ${ocultar(e instanceof Error ? e.message : String(e))}`);
    return SALIDA.ERROR;
  } finally {
    server.closeAllConnections();
    await new Promise((ok) => server.close(() => ok(undefined)));
    await prisma.$disconnect().catch(() => undefined);
  }
}
