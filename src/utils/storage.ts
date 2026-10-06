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
