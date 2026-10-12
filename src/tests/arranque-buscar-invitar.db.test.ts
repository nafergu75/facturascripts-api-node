/**
 * Dos detalles de «Traer la contabilidad de 2026»:
 *  - el buscador de «Facturas de 2026 pendientes» encuentra por número de
 *    factura, por nombre o NIF del cliente o proveedor y por subcuenta;
 *  - la invitación del panel solo dice «antes de dar de alta clientes o
 *    proveedores» a una empresa que todavía no tiene ninguno.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { listarPartidas } from '../services/arranque/partidas.service';
import { avisoArranque } from '../services/arranque/aviso.service';
import { AJUSTES_A, ficherosEmpresaA, NIF } from './fixtures/arranque/generar';
import { empresaDePrueba, traerCarga } from './fixtures/arranque/importar';

const SUFIJO = Date.now();

describe('buscador de facturas de 2026 pendientes', () => {
  const E = `arr-buscar-${SUFIJO}`;
  const docs = async (q: string) =>
    (await listarPartidas(E, { tipos: ['COBRO', 'PAGO'], q })).partidas.map((p) => p.numeroDocumento).sort();

  beforeAll(async () => {
    await empresaDePrueba(E);
    await traerCarga(E, Object.values(ficherosEmpresaA()), AJUSTES_A);
  }, 120_000);

  it('por número de factura, como antes', async () => {
    expect(await docs('A-2026-001')).toEqual(['A-2026-001']);
  });

  it('por el nombre del cliente o del proveedor, sin distinguir mayúsculas', async () => {
    expect(await docs('alfa')).toEqual(['A-2026-001']);
    expect(await docs('Proveedor Dos')).toEqual(['FD-12']);
    expect(await docs('Proveedor')).toEqual(['FD-12', 'FP-77']);
  });

  it('por el NIF (también con espacios o guiones) y por la subcuenta', async () => {
    expect(await docs(NIF.alfa)).toEqual(['A-2026-001']);
    expect(await docs(`${NIF.alfa.slice(0, 3)} ${NIF.alfa.slice(3)}`)).toEqual(['A-2026-001']);
    expect(await docs('4100000001')).toEqual(['L-0330']);
  });

  it('lo que no está no sale', async () => {
    expect(await docs('Nadie con este nombre')).toEqual([]);
  });
});

describe('invitación del panel a traer la contabilidad', () => {
  it('sin clientes ni proveedores: «antes de dar de alta…»', async () => {
    const E = `arr-invita-a-${SUFIJO}`;
    await empresaDePrueba(E);
    expect(await avisoArranque(E)).toMatchObject({
      nivel: 'INVITACION',
      texto: 'Trae la contabilidad de 2026 de tu gestoría antes de dar de alta clientes o proveedores: así sus subcuentas siguen la numeración que ya usaba.',
    });
  });

  it('con un cliente ya dado de alta: la invitación sin esa frase', async () => {
    const E = `arr-invita-b-${SUFIJO}`;
    await empresaDePrueba(E);
    await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente de 2026 SL', nifCif: 'B46000014' } });
    expect(await avisoArranque(E)).toMatchObject({
      nivel: 'INVITACION',
      texto: 'Trae la contabilidad de 2026 de tu gestoría para empezar 2027 con sus saldos, las facturas pendientes y su plan de cuentas.',
    });
  });
});
