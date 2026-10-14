/**
 * Conexion y consultas de solo lectura del vaciado de produccion: cliente
 * propio (una sola conexion), comprobacion de que la base es la esperada y
 * recuentos por tabla y por empresa.
 *
 * Nunca se escribe la URL de la base: los mensajes de error pasan por
 * `ocultador`, que tapa la URL, el usuario, la contrasena y el servidor.
 */
import { PrismaClient } from '@prisma/client';
import { id, type Tabla } from './tablas';

/**
 * Una sola conexion (asi un SET de sesion vale para las consultas siguientes)
 * y tiempo para que TiDB despierte (tarda mas de 5 s).
 */
export function urlDelScript(url: string): string {
  let u = url.trim();
  const sep = () => (u.includes('?') ? '&' : '?');
  if (!/[?&]connection_limit=/.test(u)) u += `${sep()}connection_limit=1`;
  else u = u.replace(/([?&]connection_limit=)\d+/, '$11');
  if (!/[?&]connect_timeout=/.test(u)) u += `${sep()}connect_timeout=30`;
  if (!/[?&]pool_timeout=/.test(u)) u += `${sep()}pool_timeout=60`;
  return u;
}

export function crearCliente(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: urlDelScript(url) } }, log: [] });
}

/**
 * Funcion que tapa en un texto la URL de la base y sus piezas (contrasena,
 * usuario, servidor) y cualquier otro secreto que se le pase.
 */
export function ocultador(url: string | undefined, otros: Array<string | undefined> = []): (texto: string) => string {
  const secretos = new Set<string>();
  const anadir = (s: string | undefined | null) => {
    if (s && s.length >= 4) {
      secretos.add(s);
      try {
        const d = decodeURIComponent(s);
        if (d.length >= 4) secretos.add(d);
      } catch {
        // ignorar: no estaba codificado
      }
    }
  };
  if (url) {
    anadir(url);
    try {
      const u = new URL(url);
      anadir(u.password);
      anadir(u.username);
      anadir(u.hostname);
      anadir(u.host);
    } catch {
      // URL rara: se tapa entera y basta
    }
  }
  for (const o of otros) anadir(o);
  const lista = [...secretos].sort((a, b) => b.length - a.length);
  return (texto: string) => {
    let r = String(texto).replace(/mysql:\/\/\S+/gi, '[URL oculta]');
    for (const s of lista) r = r.split(s).join('***');
    return r;
  };
}

/** Numero de una celda de COUNT(*) (llega como BigInt). */
export const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export interface EstadoBase {
  base: string;
  version: string;
  esTidb: boolean;
  tablasEnBase: number;
  faltanTablas: string[];
  faltanColumnas: string[];
  sobranTablas: string[];
  /** Existe _prisma_migrations (en produccion no: se creo con db push). */
  conMigraciones: boolean;
}

/**
 * Comprueba que la base tiene el esquema de esta version: todas las tablas y
 * columnas del modelo, y ninguna tabla que esta version no conozca (salvo
 * _prisma_migrations). Si falta algo, la base es de otra version (o es otra
 * base): el script se para. Nombres sin distinguir mayusculas (MariaDB en
 * Windows los guarda en minusculas).
 */
export async function comprobarEsquema(db: PrismaClient, tablas: readonly Pick<Tabla, 'nombre' | 'columnas'>[]): Promise<EstadoBase> {
  const [info] = await db.$queryRawUnsafe<Array<{ base: string | null; version: string }>>('SELECT DATABASE() AS base, VERSION() AS version');
  const filasTablas = await db.$queryRawUnsafe<Array<{ t: string }>>(
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  );
  const filasColumnas = await db.$queryRawUnsafe<Array<{ t: string; c: string }>>(
    'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
  );
  const enBase = new Set(filasTablas.map((f) => String(f.t).toLowerCase()));
  const columnasEnBase = new Set(filasColumnas.map((f) => `${String(f.t).toLowerCase()}.${String(f.c).toLowerCase()}`));
  const delModelo = new Set(tablas.map((t) => t.nombre.toLowerCase()));

  const faltanTablas = tablas.filter((t) => !enBase.has(t.nombre.toLowerCase())).map((t) => t.nombre);
  const faltanColumnas: string[] = [];
  for (const t of tablas) {
    if (!enBase.has(t.nombre.toLowerCase())) continue;
    for (const c of t.columnas) if (!columnasEnBase.has(`${t.nombre.toLowerCase()}.${c.nombre.toLowerCase()}`)) faltanColumnas.push(`${t.nombre}.${c.nombre}`);
  }
  const sobranTablas = filasTablas
    .map((f) => String(f.t))
    .filter((n) => !delModelo.has(n.toLowerCase()) && n.toLowerCase() !== '_prisma_migrations')
    .sort();
  return {
    base: info?.base ?? '',
    version: String(info?.version ?? ''),
    esTidb: /tidb/i.test(String(info?.version ?? '')),
    tablasEnBase: enBase.size,
    faltanTablas,
    faltanColumnas,
    sobranTablas,
    conMigraciones: enBase.has('_prisma_migrations'),
  };
}

export const esquemaCorrecto = (e: EstadoBase): boolean => !e.faltanTablas.length && !e.faltanColumnas.length && !e.sobranTablas.length;

/** Filas de una tabla (todas o las que cumplen la condicion). */
export async function contar(db: PrismaClient, tabla: string, condicion?: { sql: string; params: unknown[] }): Promise<number> {
  const where = condicion ? ` WHERE ${condicion.sql}` : '';
  const [f] = await db.$queryRawUnsafe<Array<{ n: unknown }>>(`SELECT COUNT(*) AS n FROM ${id(tabla)}${where}`, ...(condicion?.params ?? []));
  return num(f?.n);
}

/**
 * Filas por empresa. Clave null: filas sin empresa (o de una empresa que ya no
 * existe). Las tablas que no se pueden repartir por empresa devuelven solo null.
 */
export async function contarPorEmpresa(db: PrismaClient, t: Pick<Tabla, 'nombre' | 'columnaEmpresa' | 'empresaPor'>): Promise<Map<string | null, number>> {
  let filas: Array<{ e: string | null; n: unknown }>;
  if (t.columnaEmpresa) {
    filas = await db.$queryRawUnsafe(`SELECT ${id(t.columnaEmpresa)} AS e, COUNT(*) AS n FROM ${id(t.nombre)} GROUP BY ${id(t.columnaEmpresa)}`);
  } else if (t.empresaPor) {
    const p = t.empresaPor;
    filas = await db.$queryRawUnsafe(
      `SELECT p.${id('companyId')} AS e, COUNT(*) AS n FROM ${id(t.nombre)} h LEFT JOIN ${id(p.padre)} p ON h.${id(p.columna)} = p.${id(p.columnaPadre)} GROUP BY p.${id('companyId')}`,
    );
  } else {
    filas = [{ e: null, n: await contar(db, t.nombre) }];
  }
  const r = new Map<string | null, number>();
  for (const f of filas) {
    const n = num(f.n);
    if (n) r.set(f.e ?? null, (r.get(f.e ?? null) ?? 0) + n);
  }
  return r;
}

/** Filas de todas las tablas (para comparar antes y despues de la copia). */
export async function contarTodas(db: PrismaClient, tablas: readonly Pick<Tabla, 'nombre'>[]): Promise<Map<string, number>> {
  const r = new Map<string, number>();
  for (const t of tablas) r.set(t.nombre, await contar(db, t.nombre));
  return r;
}

/** «1 fila», «3 filas», «1.234 filas». */
export const plural = (n: number, una: string, varias: string): string => `${n.toLocaleString('es-ES')} ${n === 1 ? una : varias}`;
