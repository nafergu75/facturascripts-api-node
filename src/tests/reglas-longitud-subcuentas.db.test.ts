/**
 * Longitud de las subcuentas de clientes y proveedores (Configuracion): se
 * cambia mientras no haya ninguna asignada; despues, 409. La 465 de nominas
 * usa la longitud fijada.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { cambiarLongitudSubcuentas, estadoLongitudSubcuentas, guardarReglas, obtenerReglas } from '../services/reglasContables.service';
import { crearClienteConSubcuenta } from '../services/terceros/subcuentas';
import { longitudCuentasEmpresa } from '../services/nominas/plan';

const EMPRESA = `longsub-${Date.now()}`;

beforeAll(async () => {
  await prisma.company.create({ data: { id: EMPRESA, name: 'Longitud SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
});

describe('longitud de las subcuentas', () => {
  it('sin nada: 8, sin guardar y sin bloquear', async () => {
    expect(await estadoLongitudSubcuentas(EMPRESA)).toMatchObject({ longitud: 8, guardada: false, bloqueada: false, motivo: null, minimo: 7, maximo: 10 });
  });

  it('fuera de 7 a 10: 400', async () => {
    await expect(cambiarLongitudSubcuentas(EMPRESA, 6)).rejects.toMatchObject({ statusCode: 400 });
    await expect(cambiarLongitudSubcuentas(EMPRESA, 11)).rejects.toMatchObject({ statusCode: 400 });
    await expect(cambiarLongitudSubcuentas(EMPRESA, 'ocho')).rejects.toMatchObject({ statusCode: 400 });
    await expect(guardarReglas(EMPRESA, { longitudSubcuentas: 5 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('sin subcuentas asignadas se cambia, y la 465 de nominas la sigue', async () => {
    expect(await cambiarLongitudSubcuentas(EMPRESA, '10')).toMatchObject({ longitud: 10, guardada: true, bloqueada: false });
    expect((await obtenerReglas(EMPRESA)).longitudSubcuentas).toBe(10);
    expect(await longitudCuentasEmpresa(EMPRESA)).toBe(10);
    expect(await cambiarLongitudSubcuentas(EMPRESA, 9)).toMatchObject({ longitud: 9 });
  });

  it('con un cliente con subcuenta: 409 al cambiarla (tambien por PUT de reglas); la misma se acepta', async () => {
    const c = await crearClienteConSubcuenta({ companyId: EMPRESA, nombreFiscal: 'Bloquea SL', nifCif: 'B15151515' });
    expect(c.subcuenta430).toBe('430000001');
    expect(await estadoLongitudSubcuentas(EMPRESA)).toMatchObject({ longitud: 9, bloqueada: true });
    await expect(cambiarLongitudSubcuentas(EMPRESA, 8)).rejects.toMatchObject({
      statusCode: 409,
      message: 'La longitud de las subcuentas ya no se puede cambiar: hay clientes o proveedores con subcuenta asignada.',
    });
    await expect(guardarReglas(EMPRESA, { longitudSubcuentas: 8 })).rejects.toMatchObject({ statusCode: 409 });
    expect(await cambiarLongitudSubcuentas(EMPRESA, 9)).toMatchObject({ longitud: 9 });
  });
});
