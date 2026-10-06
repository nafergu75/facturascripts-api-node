// Almacenamiento en Vercel Blob.
//
// Regresion: los ficheros (libros oficiales, cuentas anuales, facturas
// archivadas, documentos del lector) se subian con access 'public' y una ruta
// predecible (registro-mercantil/<companyId>/<fyId>/<nombre>): cualquiera que
// adivinara los ids podia descargar la contabilidad sin autenticarse. Ademas,
// sin allowOverwrite, re-subir la misma ruta (p. ej. el resumen mensual) fallaba.
const put = jest.fn(async (pathname: string) => ({ url: `https://store.private.blob.vercel-storage.com/${pathname}` }));
const get = jest.fn();
jest.mock('@vercel/blob', () => ({ put, get }));

process.env.BLOB_READ_WRITE_TOKEN = 'token-de-prueba';

import { getObject, putObject } from '../utils/storage';

function streamDe(texto: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(texto));
      c.close();
    },
  });
}

beforeEach(() => jest.clearAllMocks());

describe('storage en Vercel Blob', () => {
  it('sube en privado y permite sobrescribir la misma ruta', async () => {
    const ref = await putObject('registro-mercantil/1/fy/libro.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(put).toHaveBeenCalledWith(
      'registro-mercantil/1/fy/libro.pdf',
      expect.any(Buffer),
      expect.objectContaining({ access: 'private', allowOverwrite: true, token: 'token-de-prueba' }),
    );
    expect(ref).toContain('libro.pdf');
  });

  it('lee los blobs con el token (get privado), no con un fetch anonimo', async () => {
    get.mockResolvedValue({ statusCode: 200, stream: streamDe('contenido'), headers: new Headers(), blob: {} });
    const fetchEspia = jest.spyOn(global, 'fetch');

    const buf = await getObject('https://store.private.blob.vercel-storage.com/a/b.pdf');

    expect(get).toHaveBeenCalledWith(
      'https://store.private.blob.vercel-storage.com/a/b.pdf',
      expect.objectContaining({ access: 'private', token: 'token-de-prueba' }),
    );
    expect(fetchEspia).not.toHaveBeenCalled();
    expect(buf.toString()).toBe('contenido');
    fetchEspia.mockRestore();
  });

  it('si el blob no existe, lanza un error claro', async () => {
    get.mockResolvedValue(null);
    await expect(getObject('https://store.private.blob.vercel-storage.com/no/existe.pdf')).rejects.toThrow(/no existe/);
  });
});
