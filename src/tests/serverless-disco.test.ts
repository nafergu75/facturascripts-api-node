// En Vercel el sistema de ficheros es de solo lectura salvo /tmp.
//
// Regresion: request-logger y import.routes hacian mkdirSync en process.cwd()
// AL CARGAR EL MODULO. Con las variables de entorno ya configuradas, la funcion
// moria al arrancar (EROFS) antes de atender ninguna peticion.
import os from 'os';
import path from 'path';

describe('rutas escribibles', () => {
  const vercelAntes = process.env.VERCEL;
  afterEach(() => {
    if (vercelAntes === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercelAntes;
    jest.resetModules();
  });

  it('en Vercel usa el directorio temporal; en local, el del proyecto', () => {
    const { dirEscribible } = require('../utils/paths');
    process.env.VERCEL = '1';
    expect(dirEscribible('uploads', 'imports')).toBe(path.join(os.tmpdir(), 'uploads', 'imports'));
    delete process.env.VERCEL;
    expect(dirEscribible('uploads', 'imports')).toBe(path.join(process.cwd(), 'uploads', 'imports'));
  });
});

describe('request-logger en Vercel', () => {
  const vercelAntes = process.env.VERCEL;
  afterEach(() => {
    if (vercelAntes === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercelAntes;
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('no toca el disco: ni al cargar ni al registrar una peticion', () => {
    process.env.VERCEL = '1';
    const fs = require('fs');
    const mkdir = jest.spyOn(fs, 'mkdirSync');
    const append = jest.spyOn(fs, 'appendFileSync');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const { requestLoggerMiddleware } = require('../middleware/request-logger.middleware');
    const res: { statusCode: number; send: (d: unknown) => unknown } = { statusCode: 200, send: (d) => d };
    requestLoggerMiddleware({ method: 'GET', path: '/health', params: {} } as never, res as never, () => undefined);
    res.send('ok');

    expect(mkdir).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"path":"/health"'));
  });
});
