/**
 * Candado de VERI*FACTU (config/env.ts, leerVerifactu): solo
 * VERIFACTU_PRODUCCION=si exacto, con NODE_ENV=production y
 * VERCEL_ENV=production, abre el envio a la AEAT de verdad. Cualquier otro
 * valor lo deja cerrado y avisa (las vistas previas de Vercel tambien corren
 * con NODE_ENV=production).
 */
import request from 'supertest';
import { leerVerifactu } from '../config/env';

const PRO = { NODE_ENV: 'production', VERCEL_ENV: 'production' };

describe('leerVerifactu', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('«si» con NODE_ENV=production y VERCEL_ENV=production: abierto', () => {
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', ...PRO })).toEqual({ produccion: true });
    expect(error).not.toHaveBeenCalled();
  });

  it('«si» fuera de produccion: cerrado', () => {
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'test', VERCEL_ENV: 'production' })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'development' })).toEqual({ produccion: false });
  });

  it('«si» en una vista previa de Vercel o fuera de Vercel (NODE_ENV=production): cerrado y con aviso', () => {
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'production', VERCEL_ENV: 'preview' })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'production', VERCEL_ENV: 'development' })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'production' })).toEqual({ produccion: false });
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('«SI», « si», «true»...: cerrado y con aviso', () => {
    for (const v of ['SI', ' si', 'si ', 'true', 'sí', '1']) {
      expect(leerVerifactu({ VERIFACTU_PRODUCCION: v, ...PRO })).toEqual({ produccion: false });
    }
    expect(error).toHaveBeenCalledTimes(6);
  });

  it('sin la variable (o vacia): cerrado, sin aviso', () => {
    expect(leerVerifactu({ ...PRO })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: '', ...PRO })).toEqual({ produccion: false });
    expect(error).not.toHaveBeenCalled();
  });
});

describe('/health', () => {
  const antes = process.env.VERCEL_ENV;
  afterEach(() => {
    if (antes === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = antes;
  });

  it('enseña si el candado esta abierto y el VERCEL_ENV que ve el servidor', async () => {
    process.env.VERCEL_ENV = 'preview';
    const { app } = await import('../app');
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.verifactu).toEqual({ produccion: false, vercelEnv: 'preview' });
  });
});
