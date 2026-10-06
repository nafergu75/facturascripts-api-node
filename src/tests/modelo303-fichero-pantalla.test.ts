// El boton "Descargar fichero AEAT" de la pantalla del 303 tiene que dar el
// fichero OFICIAL (diseno de registro), no un resumen legible.
let nif: string | null = 'B12345678';
jest.mock('../config/database', () => ({
  prisma: { legalConfig: { findUnique: jest.fn(async () => ({ nif, denominacion: 'Ejemplo SL' })) } },
}));
jest.mock('../services/facturascripts-client', () => ({ getFsClientForCompany: jest.fn(async () => { throw new Error('sin FS'); }) }));
jest.mock('../services/bancos.service', () => ({ listarCuentasBancarias: jest.fn(async () => []) }));
jest.mock('../services/impuestosCalculo.service', () => {
  const real = jest.requireActual('../services/impuestosCalculo.service');
  return {
    ...real,
    calcularModelo303: jest.fn(async (_c: string, periodo: unknown) =>
      real.agregar303(
        [{ idFactura: '1', tipo: 'venta', cifnif: 'B9', nombreTercero: 'C', fecha: '2026-05-10', operacion: 'interior', lineas: [{ tipoIva: 21, base: 1000, cuota: 210 }] }],
        periodo,
      ),
    ),
  };
});

import { generarTxt303Trimestre } from '../services/impuestosModulo.service';

describe('fichero del 303 desde la pantalla', () => {
  it('es el fichero oficial, con el NIF de los datos de la empresa y el 21 % en [07]-[09]', async () => {
    const r = await generarTxt303Trimestre('e1', 2026, 2);
    expect(r.nombre).toBe('303_2026_2T.txt');
    expect(r.contenido).toContain('<T303');
    expect(r.contenido).toContain('B12345678');
    expect(r.contenido).not.toMatch(/MODELO 303 -|borrador/i); // ya no es el resumen legible
    const pag1 = r.contenido.slice(r.contenido.indexOf('<T30301000>'));
    expect(pag1.slice(325, 342)).toBe('00000000000100000'); // [07] base 1.000,00
  });

  it('sin NIF no se genera y dice donde rellenarlo', async () => {
    nif = null;
    await expect(generarTxt303Trimestre('e1', 2026, 2)).rejects.toThrow(/Falta el NIF.*Registro Mercantil/);
    nif = 'B12345678';
  });
});
