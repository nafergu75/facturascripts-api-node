import { promises as fsp } from 'fs';
import * as path from 'path';

/**
 * Almacenamiento de objetos (PDF/ZIP/imágenes) con DOS backends, elegidos en
 * tiempo de ejecución sin cambiar el código que los consume:
 *
 *  - **Vercel Blob** si existe `BLOB_READ_WRITE_TOKEN` (lo inyecta Vercel al
 *    crear un Blob store). Necesario porque el FS de las funciones serverless es
 *    de solo lectura (salvo /tmp, efímero).
 *  - **Disco local** (carpeta `storage/`) en desarrollo. Comportamiento previo.
 *
 * `putObject` devuelve una REFERENCIA opaca: URL del blob o ruta relativa
 * (local). Guárdala en BD tal cual; `getObject` sabe leer ambas.
 *
 * Los blobs son PRIVADOS: contienen libros oficiales, cuentas anuales y
 * facturas, y sus rutas son predecibles (registro-mercantil/<empresa>/<ejercicio>/...).
 * Solo se leen desde el servidor, con el token, y se sirven a traves de la API
 * tras comprobar el acceso. El store de Vercel Blob debe admitir acceso privado.
 */

const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const usarBlob = !!BLOB_TOKEN;

export async function putObject(
  key: string,
  data: Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  if (usarBlob) {
    const { put } = await import('@vercel/blob');
    const res = await put(key, data, {
      access: 'private',
      contentType,
      token: BLOB_TOKEN,
      addRandomSuffix: false,
      // La misma ruta se reescribe a proposito (p. ej. el resumen mensual de
      // facturas archivadas); sin esto la segunda subida falla.
      allowOverwrite: true,
    });
    return res.url; // referencia; no es accesible sin el token
  }

  const ruta = path.join(process.cwd(), 'storage', key);
  await fsp.mkdir(path.dirname(ruta), { recursive: true });
  await fsp.writeFile(ruta, data);
  return path.join('storage', key).split(path.sep).join('/'); // ruta relativa
}

export async function getObject(ref: string): Promise<Buffer> {
  if (usarBlob && /^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i.test(ref)) {
    const { get } = await import('@vercel/blob');
    const res = await get(ref, { access: 'private', token: BLOB_TOKEN });
    if (!res || res.statusCode !== 200 || !res.stream) throw new Error(`El objeto no existe o no se pudo leer: ${ref}`);
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
  if (/^https?:\/\//i.test(ref)) {
    // Referencias antiguas a URLs publicas.
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`No se pudo leer el objeto (${r.status}): ${ref}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fsp.readFile(path.join(process.cwd(), ref));
}

/**
 * Lee un objeto por su CLAVE (la que se paso a putObject), no por la referencia
 * devuelta. Devuelve null si no existe. Sirve para objetos temporales cuya
 * referencia no se guarda en BD (p. ej. los trozos de una subida grande).
 */
export async function getObjectByKey(key: string): Promise<Buffer | null> {
  if (usarBlob) {
    const { get } = await import('@vercel/blob');
    // useCache false: un trozo reenviado tras un fallo reescribe la misma clave.
    const res = await get(key, { access: 'private', token: BLOB_TOKEN, useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null; // 404 -> null
    return Buffer.from(await new Response(res.stream).arrayBuffer());
  }
  try {
    return await fsp.readFile(path.join(process.cwd(), 'storage', key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Borra objetos por clave. Los que no existen se ignoran. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (usarBlob) {
    const { del } = await import('@vercel/blob');
    // del admite varias rutas por llamada; en tandas para no pasar limites.
    for (let i = 0; i < keys.length; i += 100) await del(keys.slice(i, i + 100), { token: BLOB_TOKEN });
    return;
  }
  for (const key of keys) {
    await fsp.rm(path.join(process.cwd(), 'storage', key), { force: true });
  }
}

/**
 * Borra un objeto por la REFERENCIA que devolvio putObject (URL del blob o ruta
 * relativa 'storage/...'). Una ruta local fuera de storage/ o una URL publica
 * antigua no se tocan.
 */
export async function deleteObject(ref: string): Promise<void> {
  if (/^https?:\/\//i.test(ref)) {
    if (!usarBlob || !/^https:\/\/[^/]+\.blob\.vercel-storage\.com\//i.test(ref)) return;
    const { del } = await import('@vercel/blob');
    await del(ref, { token: BLOB_TOKEN });
    return;
  }
  const normal = path.posix.normalize(ref.replace(/\\/g, '/'));
  if (!normal.startsWith('storage/') || normal.includes('..')) return;
  await fsp.rm(path.join(process.cwd(), normal), { force: true });
}

/** Objetos bajo un prefijo de clave, con su fecha de subida. */
export async function listObjects(prefix: string): Promise<Array<{ key: string; fecha: Date }>> {
  if (usarBlob) {
    const { list } = await import('@vercel/blob');
    const out: Array<{ key: string; fecha: Date }> = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, cursor, limit: 1000, token: BLOB_TOKEN });
      for (const b of r.blobs) out.push({ key: b.pathname, fecha: new Date(b.uploadedAt) });
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out;
  }
  const base = path.join(process.cwd(), 'storage');
  const out: Array<{ key: string; fecha: Date }> = [];
  const recorrer = async (dir: string): Promise<void> => {
    let entradas;
    try {
      entradas = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const ruta = path.join(dir, e.name);
      if (e.isDirectory()) await recorrer(ruta);
      else {
        const key = path.relative(base, ruta).split(path.sep).join('/');
        if (key.startsWith(prefix)) out.push({ key, fecha: (await fsp.stat(ruta)).mtime });
      }
    }
  };
  // Se empieza en la carpeta del prefijo (o su carpeta padre si acaba a medias).
  const dirPrefijo = prefix.endsWith('/') ? prefix : path.posix.dirname(prefix);
  await recorrer(path.join(base, ...dirPrefijo.split('/').filter(Boolean)));
  return out;
}
