/**
 * Doble candado de VERI*FACTU (config/env.ts, leerVerifactu): solo
 * VERIFACTU_PRODUCCION=si exacto con NODE_ENV=production abre el envio a la
 * AEAT de verdad. Cualquier otro valor lo deja cerrado y avisa.
 */
import { leerVerifactu } from '../config/env';

describe('leerVerifactu', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('«si» con NODE_ENV=production: abierto', () => {
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'production' })).toEqual({ produccion: true });
    expect(error).not.toHaveBeenCalled();
  });

  it('«si» fuera de produccion: cerrado', () => {
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'test' })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: 'si', NODE_ENV: 'development' })).toEqual({ produccion: false });
  });

  it('«SI», « si», «true»...: cerrado y con aviso', () => {
    for (const v of ['SI', ' si', 'si ', 'true', 'sí', '1']) {
      expect(leerVerifactu({ VERIFACTU_PRODUCCION: v, NODE_ENV: 'production' })).toEqual({ produccion: false });
    }
    expect(error).toHaveBeenCalledTimes(6);
  });

  it('sin la variable (o vacia): cerrado, sin aviso', () => {
    expect(leerVerifactu({ NODE_ENV: 'production' })).toEqual({ produccion: false });
    expect(leerVerifactu({ VERIFACTU_PRODUCCION: '', NODE_ENV: 'production' })).toEqual({ produccion: false });
    expect(error).not.toHaveBeenCalled();
  });
});
