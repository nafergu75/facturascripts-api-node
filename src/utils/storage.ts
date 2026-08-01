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
 * `putObject` devuelve una REFERENCIA opaca: URL pública (Blob) o ruta relativa
 * (local). Guárdala en BD tal cual; `getObject` sabe leer ambas. Las rutas
 * locales antiguas siguen funcionando (compatibilidad hacia atrás).
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
      access: 'public',
      contentType,
      token: BLOB_TOKEN,
      addRandomSuffix: false,
    });
    return res.url; // URL pública del objeto
  }

  const ruta = path.join(process.cwd(), 'storage', key);
  await fsp.mkdir(path.dirname(ruta), { recursive: true });
  await fsp.writeFile(ruta, data);
  return path.join('storage', key).split(path.sep).join('/'); // ruta relativa
}

export async function getObject(ref: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(ref)) {
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`No se pudo leer el objeto (${r.status}): ${ref}`);
    return Buffer.from(await r.arrayBuffer());
  }
  return fsp.readFile(path.join(process.cwd(), ref));
}
